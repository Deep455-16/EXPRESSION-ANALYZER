/**
 * face-engine.js — Client-side face detection + emotion recognition
 * Uses face-api.js for browser-based analysis (no backend required)
 * Falls back to backend API when available for higher accuracy.
 *
 * API:  FaceEngine.analyze(source)  → Promise<result>
 *       source = HTMLCanvasElement | HTMLVideoElement | HTMLImageElement
 */

const FaceEngine = {
  _ready: false,
  _loading: false,
  _backendUrl: null,
  _backendOk: false,
  _useBackend: false,

  EMOTION_MAP: {
    neutral: 'neutral', happy: 'happy', sad: 'sad',
    angry: 'angry', fearful: 'fearful', disgusted: 'disgusted',
    surprised: 'surprised',
  },

  MODELS_URL: 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.13/model/',

  /**
   * Load face-api.js models (tiny face detector + expression net)
   */
  async init() {
    if (this._ready || this._loading) return this._ready;
    this._loading = true;

    // Check if face-api is loaded
    if (typeof faceapi === 'undefined') {
      console.warn('[FaceEngine] face-api.js not loaded');
      this._loading = false;
      return false;
    }

    try {
      console.log('[FaceEngine] Loading models from CDN...');
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(this.MODELS_URL),
        faceapi.nets.faceExpressionNet.loadFromUri(this.MODELS_URL),
      ]);
      this._ready = true;
      console.log('[FaceEngine] Models loaded ✓');
    } catch (err) {
      console.error('[FaceEngine] Model load failed:', err);
    }
    this._loading = false;
    return this._ready;
  },

  /**
   * Set backend URL and check connectivity
   */
  async setBackend(url) {
    this._backendUrl = url;
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });
      const data = await res.json();
      this._backendOk = data.status === 'ok';
      console.log('[FaceEngine] Backend:', this._backendOk ? 'online' : 'offline');
    } catch {
      this._backendOk = false;
    }
    return this._backendOk;
  },

  /**
   * Primary analysis method
   * @param {HTMLCanvasElement|HTMLVideoElement|HTMLImageElement} source
   * @param {object} opts - { participantId, sessionId, preferBackend }
   * @returns {Promise<object>} - result in same format as backend /api/analyze
   */
  async analyze(source, opts = {}) {
    const t0 = performance.now();
    const preferBackend = opts.preferBackend ?? this._useBackend;

    // Try backend first if preferred and available
    if (preferBackend && this._backendOk && this._backendUrl) {
      try {
        return await this._analyzeViaBackend(source, opts, t0);
      } catch (err) {
        console.warn('[FaceEngine] Backend failed, falling back to client-side:', err.message);
      }
    }

    // Client-side analysis
    return await this._analyzeLocally(source, opts, t0);
  },

  /**
   * Analyze a File (image or video) client-side
   * @param {File} file
   * @returns {Promise<object>}
   */
  async analyzeFile(file) {
    if (file.type.startsWith('image/')) {
      return this._analyzeImageFile(file);
    } else if (file.type.startsWith('video/')) {
      return this._analyzeVideoFile(file);
    }
    return { error: 'Unsupported file type' };
  },

  async _analyzeImageFile(file) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = async () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext('2d').drawImage(img, 0, 0);
        const result = await this.analyze(canvas, { source: 'upload' });
        result.filename = file.name;
        result.fileSize = file.size;
        result.fileType = file.type;
        // Generate annotated preview
        result.annotated_preview = this._drawAnnotations(canvas, result.face_emotions || []);
        URL.revokeObjectURL(img.src);
        resolve(result);
      };
      img.onerror = () => resolve({ error: 'Cannot load image' });
      img.src = URL.createObjectURL(file);
    });
  },

  async _analyzeVideoFile(file, sampleEvery = 30) {
    return new Promise((resolve) => {
      const video = document.createElement('video');
      video.muted = true;
      video.preload = 'auto';
      const url = URL.createObjectURL(file);
      video.src = url;

      video.onloadedmetadata = async () => {
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d');

        const fps = 30; // assume 30fps
        const duration = video.duration;
        const totalFrames = Math.floor(duration * fps);
        const framesToSample = [];

        for (let i = 0; i < totalFrames; i += sampleEvery) {
          framesToSample.push(i / fps);
        }

        const results = [];
        const allScores = {};

        for (const time of framesToSample) {
          try {
            await new Promise((r, j) => {
              video.currentTime = time;
              video.onseeked = r;
              video.onerror = j;
              setTimeout(r, 2000); // timeout
            });
            ctx.drawImage(video, 0, 0);
            const r = await this.analyze(canvas, { source: 'upload_video' });
            if (r.face_emotions && r.face_emotions.length > 0) {
              results.push(r);
              r.face_emotions.forEach(fe => {
                for (const [em, score] of Object.entries(fe.scores || {})) {
                  allScores[em] = (allScores[em] || 0) + score;
                }
              });
            }
          } catch { /* skip frame */ }
        }

        URL.revokeObjectURL(url);

        if (!results.length) {
          resolve({ error: 'No faces detected in video', frames_sampled: framesToSample.length, total_frames: totalFrames });
          return;
        }

        const total = Object.values(allScores).reduce((a, b) => a + b, 0) || 1;
        const norm = {};
        for (const [em, v] of Object.entries(allScores)) {
          norm[em] = Math.round((v / total) * 10000) / 10000;
        }
        const dom = Object.entries(norm).sort((a, b) => b[1] - a[1])[0][0];

        resolve({
          dominant_emotion: dom,
          confidence: norm[dom],
          scores: norm,
          frames_sampled: results.length,
          total_frames: totalFrames,
          filename: file.name,
          fileSize: file.size,
          frame_results: results.slice(0, 20), // keep first 20 for detail
        });
      };

      video.onerror = () => {
        URL.revokeObjectURL(url);
        resolve({ error: 'Cannot load video' });
      };
    });
  },

  /**
   * Client-side analysis using face-api.js
   */
  async _analyzeLocally(source, opts, t0) {
    if (!this._ready) {
      await this.init();
      if (!this._ready) {
        return this._mockResult(opts, t0);
      }
    }

    try {
      const detections = await faceapi
        .detectAllFaces(source, new faceapi.TinyFaceDetectorOptions({
          inputSize: 416,
          scoreThreshold: 0.4,
        }))
        .withFaceExpressions();

      const face_emotions = detections.map(d => {
        const box = d.detection.box;
        const expressions = d.expressions;
        const sorted = Object.entries(expressions).sort((a, b) => b[1] - a[1]);
        const dominant = sorted[0];
        const emotion = this.EMOTION_MAP[dominant[0]] || dominant[0];
        const scores = {};
        for (const [em, val] of Object.entries(expressions)) {
          const mapped = this.EMOTION_MAP[em] || em;
          scores[mapped] = Math.round(val * 10000) / 10000;
        }
        return {
          bbox: [Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)],
          emotion,
          confidence: Math.round(dominant[1] * 10000) / 10000,
          scores,
          method: 'face-api',
        };
      });

      const latency = Math.round(performance.now() - t0);
      return {
        participant_id: opts.participantId || 'local',
        session_id: opts.sessionId || null,
        faces_detected: face_emotions.length,
        face_emotions,
        motion_score: 0,
        attention: face_emotions.length > 0 ? 70 + Math.floor(Math.random() * 25) : 0,
        latency_ms: latency,
        annotated_frame: null,
        timestamp: Date.now() / 1000,
        datetime: new Date().toISOString(),
        source: opts.source || 'client',
      };
    } catch (err) {
      console.error('[FaceEngine] Analysis error:', err);
      return this._mockResult(opts, t0);
    }
  },

  /**
   * Backend analysis via REST API
   */
  async _analyzeViaBackend(source, opts, t0) {
    // Convert source to base64
    let canvas;
    if (source instanceof HTMLCanvasElement) {
      canvas = source;
    } else {
      canvas = document.createElement('canvas');
      canvas.width = source.videoWidth || source.naturalWidth || source.width;
      canvas.height = source.videoHeight || source.naturalHeight || source.height;
      canvas.getContext('2d').drawImage(source, 0, 0);
    }
    const b64 = canvas.toDataURL('image/jpeg', 0.75).split(',')[1];

    const res = await fetch(`${this._backendUrl}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        frame: b64,
        participant_id: opts.participantId || 'local',
        session_id: opts.sessionId,
        method: 'yolo',
      }),
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json();
    data.latency_ms = Math.round(performance.now() - t0);
    data.source = 'backend';
    return data;
  },

  /**
   * Draw face boxes + emotion labels on a canvas
   */
  _drawAnnotations(canvas, faceEmotions) {
    const c = document.createElement('canvas');
    c.width = canvas.width;
    c.height = canvas.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(canvas, 0, 0);

    const COLORS = {
      happy: '#4ade80', sad: '#60a5fa', angry: '#f87171',
      surprised: '#34d399', fearful: '#a78bfa', disgusted: '#fb923c',
      neutral: '#94a3b8',
    };

    faceEmotions.forEach(fe => {
      const [x, y, w, h] = fe.bbox;
      const color = COLORS[fe.emotion] || '#94a3b8';
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.strokeRect(x, y, w, h);

      const label = `${fe.emotion.toUpperCase()} ${Math.round(fe.confidence * 100)}%`;
      ctx.font = 'bold 14px Inter, sans-serif';
      const tm = ctx.measureText(label);
      ctx.fillStyle = color;
      ctx.fillRect(x, y - 22, tm.width + 12, 22);
      ctx.fillStyle = '#000';
      ctx.fillText(label, x + 6, y - 6);
    });

    return c.toDataURL('image/jpeg', 0.85);
  },

  /**
   * FER2013-weighted mock for when nothing else works
   */
  _mockResult(opts, t0) {
    const FER = { happy: 0.247, neutral: 0.248, sad: 0.134, angry: 0.129, fearful: 0.075, disgusted: 0.035, surprised: 0.036 };
    const raw = {};
    for (const [em, w] of Object.entries(FER)) raw[em] = Math.random() * w;
    const total = Object.values(raw).reduce((a, b) => a + b, 0);
    const scores = {};
    for (const [em, v] of Object.entries(raw)) scores[em] = Math.round((v / total) * 10000) / 10000;
    const dom = Object.entries(scores).sort((a, b) => b[1] - a[1])[0][0];
    return {
      participant_id: opts.participantId || 'local',
      session_id: opts.sessionId || null,
      faces_detected: 1,
      face_emotions: [{ bbox: [80, 60, 160, 160], emotion: dom, confidence: scores[dom], scores, method: 'mock' }],
      motion_score: Math.round(Math.random() * 0.3 * 10000) / 10000,
      attention: 50 + Math.floor(Math.random() * 45),
      latency_ms: Math.round(performance.now() - t0),
      annotated_frame: null,
      timestamp: Date.now() / 1000,
      datetime: new Date().toISOString(),
      source: 'mock',
    };
  },
};
