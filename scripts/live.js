/**
 * live.js — Real-time expression analysis
 * Uses FaceEngine for client-side detection (face-api.js)
 * Falls back to Flask-SocketIO backend when available.
 */

// ── State ─────────────────────────────────────────────────────────────────────
const State = {
  stream:        null,
  socket:        null,
  analysisTimer: null,
  sessionStart:  null,
  frameCount:    0,
  history:       [],
  isRunning:     false,
  backendUrl:    localStorage.getItem('backendUrl') || 'http://localhost:5000',
  sessionId:     'session_' + Date.now(),
  participantId: localStorage.getItem('participantId') || `user_${Date.now()}`,
  useBackend:    localStorage.getItem('analysisSource') === 'backend',
  showOverlay:   true,
  recordHistory: true,
  detectionRate: 1000,
};

// ── Emotion config ────────────────────────────────────────────────────────────
const EMOTION_CONFIG = {
  happy:     { icon: '😊', color: '#4ade80',  faIcon: 'fa-smile',    label: 'Happy'     },
  sad:       { icon: '😢', color: '#60a5fa',  faIcon: 'fa-sad-tear', label: 'Sad'       },
  angry:     { icon: '😠', color: '#f87171',  faIcon: 'fa-angry',    label: 'Angry'     },
  surprised: { icon: '😲', color: '#34d399',  faIcon: 'fa-surprise', label: 'Surprised' },
  fearful:   { icon: '😨', color: '#a78bfa',  faIcon: 'fa-grimace',  label: 'Fearful'   },
  disgusted: { icon: '🤢', color: '#fb923c',  faIcon: 'fa-dizzy',    label: 'Disgusted' },
  neutral:   { icon: '😐', color: '#94a3b8',  faIcon: 'fa-meh',      label: 'Neutral'   },
};

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const webcam        = $('webcam');
const overlay       = $('overlay');
const ctx           = overlay?.getContext('2d');
const emotionIcon   = $('emotionIcon');
const emotionName   = $('emotionName');
const emotionConf   = $('emotionConfidence');
const emotionBars   = $('emotionBars');
const timeline      = $('timeline');
const backendStatus = $('backendStatus');
const latencySpan   = $('latencyMs');
const backendBadge  = $('backendBadge');
const frameCountEl  = $('frameCount');
const fpsEl         = $('fps');
const participantEl = $('participantCount');
const sessionDurEl  = $('sessionDuration');


// ═════════════════════════════════════════════════════════════════════════════
// CAMERA
// ═════════════════════════════════════════════════════════════════════════════

async function startCamera() {
  try {
    // Get preferred resolution from settings
    const resSetting = settings.get('resolution') || '1280x720';
    const [w, h] = resSetting.split('x').map(Number);

    State.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: w || 1280, height: h || 720, facingMode: 'user' },
      audio: false,
    });
    webcam.srcObject = State.stream;
    await new Promise(r => webcam.onloadedmetadata = r);

    overlay.width  = webcam.videoWidth;
    overlay.height = webcam.videoHeight;

    State.isRunning    = true;
    State.sessionStart = Date.now();
    State.frameCount   = 0;
    State.history      = [];
    State.sessionId    = 'session_' + Date.now();

    // Initialize FaceEngine
    await FaceEngine.init();

    // Pass stream to WebRTC manager
    WebRTCManager.setLocalStream(State.stream);

    setBtn(true);
    updateStatus('🔴 Live', '#4ade80');
    startAnalysisLoop();
    startDurationTimer();

    // Save session to IndexedDB
    EmotiDB.addSession({
      session_id:   State.sessionId,
      start_time:   new Date().toISOString(),
      status:       'active',
      participants: [State.participantId],
      frame_count:  0,
      source:       State.useBackend ? 'backend' : 'client',
    });

    showToast('Camera started — analyzing expressions');
  } catch (err) {
    showToast(`Camera error: ${err.message}`, 'error');
  }
}

function stopCamera() {
  State.stream?.getTracks().forEach(t => t.stop());
  State.stream   = null;
  State.isRunning = false;
  clearInterval(State.analysisTimer);
  clearInterval(State._durationTimer);
  setBtn(false);
  updateStatus('Camera Off', '#94a3b8');
  if (ctx) ctx.clearRect(0, 0, overlay.width, overlay.height);

  // Finalize session
  if (State.sessionId) {
    const duration = State.sessionStart ? Math.round((Date.now() - State.sessionStart) / 1000) : 0;
    const emotionCounts = {};
    State.history.forEach(h => {
      emotionCounts[h.emotion] = (emotionCounts[h.emotion] || 0) + 1;
    });
    const dominant = Object.entries(emotionCounts).sort((a, b) => b[1] - a[1])[0];
    EmotiDB.addSession({
      session_id:       State.sessionId,
      start_time:       new Date(State.sessionStart).toISOString(),
      end_time:         new Date().toISOString(),
      status:           'completed',
      duration_seconds: duration,
      total_frames:     State.frameCount,
      dominant_emotion: dominant ? dominant[0] : 'neutral',
      emotion_counts:   emotionCounts,
      participants:     [State.participantId],
    });
  }

  showToast('Session ended');
}

function setBtn(running) {
  ['startCamera', 'startCameraMain'].forEach(id => {
    const el = $(id);
    if (el) el.disabled = running;
  });
  [$('captureFrame'), $('stopCamera')].forEach(el => {
    if (el) el.disabled = !running;
  });
}


// ═════════════════════════════════════════════════════════════════════════════
// ANALYSIS LOOP
// ═════════════════════════════════════════════════════════════════════════════

function startAnalysisLoop() {
  clearInterval(State.analysisTimer);

  const rate = State.detectionRate === 'realtime' ? 200
             : parseInt(State.detectionRate) || 1000;

  State.analysisTimer = setInterval(async () => {
    if (!State.isRunning || !webcam.videoWidth) return;

    State.frameCount++;
    if (frameCountEl) frameCountEl.textContent = State.frameCount;

    if (State.useBackend && State.socket?.connected) {
      // WebSocket path
      const b64 = captureBase64();
      if (!b64) return;
      State.socket.emit('frame', {
        frame:          b64,
        participant_id: State.participantId,
        session_id:     State.sessionId,
        method:         'yolo',
      });
    } else if (State.useBackend && !State.socket?.connected) {
      // REST fallback
      try {
        const result = await FaceEngine.analyze(webcam, {
          participantId: State.participantId,
          sessionId:     State.sessionId,
          preferBackend: true,
        });
        handleResult(result);
      } catch {
        handleResult(await FaceEngine.analyze(webcam, { participantId: State.participantId }));
      }
    } else {
      // Client-side (face-api.js)
      const result = await FaceEngine.analyze(webcam, {
        participantId: State.participantId,
        sessionId:     State.sessionId,
      });
      handleResult(result);
    }
  }, rate);
}

function captureBase64() {
  const c = document.createElement('canvas');
  c.width  = webcam.videoWidth;
  c.height = webcam.videoHeight;
  c.getContext('2d').drawImage(webcam, 0, 0);
  return c.toDataURL('image/jpeg', 0.75).split(',')[1];
}


// ═════════════════════════════════════════════════════════════════════════════
// WEBSOCKET
// ═════════════════════════════════════════════════════════════════════════════

function connectSocket() {
  if (typeof io === 'undefined') {
    showToast('Socket.IO not available — using REST/client-side mode', 'warn');
    return;
  }
  if (State.socket) State.socket.disconnect();

  const url = State.backendUrl;
  State.socket = io(url, {
    transports: ['websocket', 'polling'],
    query: { participant_id: State.participantId },
    reconnectionAttempts: 5,
  });

  State.socket.on('connect', () => {
    setBackendStatus(true);
    showToast('Backend connected ✓');
  });

  State.socket.on('connected', data => {
    State.sessionId = data.session_id || State.sessionId;
    log(`Session ID: ${State.sessionId}`);
  });

  State.socket.on('result', data => handleResult(data));
  State.socket.on('disconnect', () => setBackendStatus(false));
  State.socket.on('connect_error', () => setBackendStatus(false));

  // Wire WebRTC signaling
  WebRTCManager.setSocket(State.socket);
}

async function checkBackend() {
  try {
    const ok = await FaceEngine.setBackend(State.backendUrl);
    setBackendStatus(ok);
    return ok;
  } catch {
    setBackendStatus(false);
    return false;
  }
}

function setBackendStatus(ok) {
  if (!backendStatus) return;
  backendStatus.textContent = ok ? 'Online' : 'Offline';
  backendStatus.style.color = ok ? '#4ade80' : '#f87171';
  if (backendBadge) backendBadge.style.display = ok ? 'block' : 'none';
}


// ═════════════════════════════════════════════════════════════════════════════
// RESULT HANDLER
// ═════════════════════════════════════════════════════════════════════════════

function handleResult(data) {
  if (data.error) return;

  const faces = data.face_emotions || [];

  // Draw client-side face boxes on overlay
  if (faces.length > 0 && State.showOverlay && ctx) {
    if (data.annotated_frame) {
      // Backend sent annotated frame
      const img = new Image();
      img.onload = () => {
        ctx.clearRect(0, 0, overlay.width, overlay.height);
        ctx.drawImage(img, 0, 0, overlay.width, overlay.height);
      };
      img.src = 'data:image/jpeg;base64,' + data.annotated_frame;
    } else {
      // Draw client-side overlay
      ctx.clearRect(0, 0, overlay.width, overlay.height);
      faces.forEach(fe => {
        const [x, y, w, h] = fe.bbox;
        const cfg = EMOTION_CONFIG[fe.emotion] || EMOTION_CONFIG.neutral;
        ctx.strokeStyle = cfg.color;
        ctx.lineWidth = 3;

        // Corner brackets
        const cs = 18;
        [[x,y,1,1],[x+w,y,-1,1],[x,y+h,1,-1],[x+w,y+h,-1,-1]].forEach(([cx,cy,dx,dy]) => {
          ctx.beginPath();
          ctx.moveTo(cx, cy); ctx.lineTo(cx + dx * cs, cy);
          ctx.moveTo(cx, cy); ctx.lineTo(cx, cy + dy * cs);
          ctx.stroke();
        });

        // Label
        const pct = Math.round(fe.confidence * 100);
        const label = `${fe.emotion.toUpperCase()} ${pct}%`;
        ctx.font = 'bold 13px Inter, sans-serif';
        const tm = ctx.measureText(label);
        ctx.fillStyle = cfg.color;
        ctx.fillRect(x, y - 22, tm.width + 12, 22);
        ctx.fillStyle = '#000';
        ctx.fillText(label, x + 6, y - 6);
      });
    }
  } else if (ctx) {
    ctx.clearRect(0, 0, overlay.width, overlay.height);
  }

  // Update latency badge
  if (data.latency_ms !== undefined && latencySpan) {
    latencySpan.textContent = Math.round(data.latency_ms);
    if (backendBadge) backendBadge.style.display = 'block';
  }

  // Primary face emotion
  if (faces.length > 0) {
    const primary = faces[0];
    const cfg = EMOTION_CONFIG[primary.emotion] || EMOTION_CONFIG.neutral;

    if (emotionIcon) emotionIcon.innerHTML = `<span style="font-size:2.5rem">${cfg.icon}</span>`;
    if (emotionName) emotionName.textContent = cfg.label;
    if (emotionConf) emotionConf.textContent = `${Math.round(primary.confidence * 100)}% confidence`;

    renderEmotionBars(primary.scores);
    addTimelineEntry(primary, data.attention);

    if (State.recordHistory) {
      const entry = {
        ts:        data.timestamp || Date.now() / 1000,
        emotion:   primary.emotion,
        confidence: primary.confidence,
        scores:    primary.scores,
        attention: data.attention,
        faces:     faces.length,
      };
      State.history.push(entry);

      // Persist to IndexedDB
      EmotiDB.addResult({
        session_id:    State.sessionId,
        participant_id: State.participantId,
        timestamp:     entry.ts,
        face_emotions: faces,
        attention:     data.attention,
        latency_ms:    data.latency_ms,
        source:        data.source || 'client',
      });
    }
  }

  // Session info
  if (data.session_id) State.sessionId = data.session_id;
  if (participantEl) participantEl.textContent = Math.max(faces.length, 1) + Object.keys(WebRTCManager.peers).length;

  // FPS
  if (fpsEl && State.sessionStart) {
    const elapsed = (Date.now() - State.sessionStart) / 1000;
    fpsEl.textContent = elapsed > 0 ? Math.round(State.frameCount / elapsed) : 0;
  }
}


// ─── Emotion bars ─────────────────────────────────────────────────────────────
function renderEmotionBars(scores) {
  if (!emotionBars || !scores) return;
  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  emotionBars.innerHTML = sorted.map(([em, val]) => {
    const cfg = EMOTION_CONFIG[em] || { color: '#94a3b8', label: em };
    const pct = Math.round(val * 100);
    return `
      <div class="emotion-bar-row">
        <span class="emotion-bar-label">${cfg.label || em}</span>
        <div class="emotion-bar-track">
          <div class="emotion-bar-fill"
               style="width:${pct}%;background:${cfg.color};transition:width .4s ease"></div>
        </div>
        <span class="emotion-bar-pct">${pct}%</span>
      </div>`;
  }).join('');
}


// ─── Timeline ─────────────────────────────────────────────────────────────────
function addTimelineEntry(face, attention) {
  if (!timeline) return;
  const cfg   = EMOTION_CONFIG[face.emotion] || EMOTION_CONFIG.neutral;
  const now   = new Date().toLocaleTimeString();
  const pct   = Math.round(face.confidence * 100);
  const empty = timeline.querySelector('.timeline-empty');
  if (empty) empty.remove();

  const entry = document.createElement('div');
  entry.className = 'timeline-entry';
  entry.innerHTML = `
    <div class="tl-icon" style="background:${cfg.color}20;border:1px solid ${cfg.color}40">
      ${cfg.icon}
    </div>
    <div class="tl-info">
      <span class="tl-emotion" style="color:${cfg.color}">${cfg.label}</span>
      <span class="tl-meta">${pct}% · attn ${attention ?? '—'}% · ${now}</span>
    </div>`;
  timeline.prepend(entry);

  while (timeline.children.length > 40) timeline.lastChild.remove();
}


// ═════════════════════════════════════════════════════════════════════════════
// DURATION TIMER
// ═════════════════════════════════════════════════════════════════════════════

function startDurationTimer() {
  clearInterval(State._durationTimer);
  State._durationTimer = setInterval(() => {
    if (!State.sessionStart || !sessionDurEl) return;
    const s   = Math.floor((Date.now() - State.sessionStart) / 1000);
    const hh  = String(Math.floor(s / 3600)).padStart(2, '0');
    const mm  = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const ss  = String(s % 60).padStart(2, '0');
    sessionDurEl.textContent = `${hh}:${mm}:${ss}`;
  }, 1000);
}


// ═════════════════════════════════════════════════════════════════════════════
// EXPORT
// ═════════════════════════════════════════════════════════════════════════════

function exportSession() {
  if (!State.history.length) { showToast('No data to export', 'warn'); return; }
  const fmt = settings.get('exportFormat') || 'json';

  if (fmt === 'csv') {
    const headers = ['timestamp', 'emotion', 'confidence', 'attention', 'faces'];
    const rows = State.history.map(r => [
      r.ts, r.emotion, r.confidence, r.attention ?? '', r.faces
    ]);
    exportToCSV(headers, rows, `emotiscan_session_${Date.now()}.csv`);
  } else {
    exportToJSON({
      session_id:     State.sessionId,
      participant_id: State.participantId,
      exported_at:    new Date().toISOString(),
      duration_s:     State.sessionStart ? Math.round((Date.now() - State.sessionStart) / 1000) : 0,
      total_frames:   State.frameCount,
      frames:         State.history,
    }, `emotiscan_session_${Date.now()}.json`);
  }
  showToast('Session exported ✓');
}


// ═════════════════════════════════════════════════════════════════════════════
// CAPTURE FRAME
// ═════════════════════════════════════════════════════════════════════════════

function captureFrameModal() {
  const c = document.createElement('canvas');
  c.width  = webcam.videoWidth; c.height = webcam.videoHeight;
  c.getContext('2d').drawImage(webcam, 0, 0);
  const url = c.toDataURL('image/png');
  const img = $('capturedImage');
  if (img) img.src = url;

  // Show analysis info
  const info = $('captureInfo');
  if (info && State.history.length > 0) {
    const last = State.history[State.history.length - 1];
    const cfg = EMOTION_CONFIG[last.emotion] || EMOTION_CONFIG.neutral;
    info.innerHTML = `
      <div style="text-align:center;padding:12px;">
        <span style="font-size:2rem">${cfg.icon}</span>
        <div style="font-weight:700;color:${cfg.color};font-size:1.1rem;margin-top:4px">${cfg.label}</div>
        <div style="color:var(--text-secondary);font-size:0.85rem">${Math.round(last.confidence * 100)}% confidence</div>
      </div>`;
  }

  const modal = $('captureModal');
  if (modal) modal.classList.add('active');
  const dl = $('downloadCapture');
  if (dl) dl.onclick = () => {
    const a = document.createElement('a');
    a.href = url; a.download = `capture_${Date.now()}.png`; a.click();
  };
}


// ═════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═════════════════════════════════════════════════════════════════════════════

function updateStatus(text, color = '#94a3b8') {
  const el = $('statusText');
  if (el) { el.textContent = text; el.style.color = color; }
}

function log(msg) { console.log(`[EmotiScan] ${msg}`); }


// ═════════════════════════════════════════════════════════════════════════════
// INIT + EVENT WIRING
// ═════════════════════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', async () => {

  // Pre-initialize FaceEngine (non-blocking)
  FaceEngine.init();

  // Restore settings
  const src = $('analysisSource');
  if (src) {
    src.value = State.useBackend ? 'backend' : 'mock';
    src.addEventListener('change', () => {
      State.useBackend = src.value === 'backend';
      localStorage.setItem('analysisSource', src.value);
      FaceEngine._useBackend = State.useBackend;
      if (State.isRunning) startAnalysisLoop();
    });
  }

  const urlInput = $('backendUrlInput');
  if (urlInput) {
    urlInput.value = State.backendUrl;
    urlInput.addEventListener('change', () => {
      State.backendUrl = urlInput.value.trim();
      localStorage.setItem('backendUrl', State.backendUrl);
    });
  }

  const connBtn = $('connectBackendBtn');
  if (connBtn) connBtn.addEventListener('click', async () => {
    State.backendUrl = ($('backendUrlInput')?.value || 'http://localhost:5000').trim();
    localStorage.setItem('backendUrl', State.backendUrl);
    const ok = await checkBackend();
    if (ok) {
      connectSocket();
      showToast('Backend connected ✓');
    } else {
      showToast('Backend unreachable — using client-side detection', 'warn');
    }
  });

  // Detection rate
  const rateEl = $('detectionRate');
  if (rateEl) {
    rateEl.value = '1000';
    rateEl.addEventListener('change', () => {
      State.detectionRate = rateEl.value;
      if (State.isRunning) startAnalysisLoop();
    });
  }

  // Confidence threshold
  const thresh = $('confidenceThreshold');
  const thrVal = $('thresholdValue');
  if (thresh && thrVal) {
    thresh.addEventListener('input', () => {
      thrVal.textContent = `${thresh.value}%`;
    });
  }

  // Overlay toggle
  const ovCheck = $('showOverlay');
  if (ovCheck) ovCheck.addEventListener('change', () => {
    State.showOverlay = ovCheck.checked;
    if (!ovCheck.checked && ctx) ctx.clearRect(0, 0, overlay.width, overlay.height);
  });

  // Record history
  const recCheck = $('recordHistory');
  if (recCheck) recCheck.addEventListener('change', () => {
    State.recordHistory = recCheck.checked;
  });

  // Camera buttons
  ['startCamera', 'startCameraMain'].forEach(id => {
    $(id)?.addEventListener('click', startCamera);
  });
  $('stopCamera')?.addEventListener('click', stopCamera);
  $('captureFrame')?.addEventListener('click', captureFrameModal);
  $('closeModal')?.addEventListener('click',  () => $('captureModal')?.classList.remove('active'));
  $('closeModal2')?.addEventListener('click', () => $('captureModal')?.classList.remove('active'));

  $('toggleOverlay')?.addEventListener('click', () => {
    State.showOverlay = !State.showOverlay;
    if (!State.showOverlay && ctx) ctx.clearRect(0, 0, overlay.width, overlay.height);
  });

  // Actions
  $('exportSession')?.addEventListener('click', exportSession);
  $('clearHistory')?.addEventListener('click',  () => {
    State.history = [];
    if (timeline) {
      timeline.innerHTML = `<div class="timeline-empty"><i class="fas fa-info-circle"></i><p>No data yet</p></div>`;
    }
    showToast('History cleared');
  });
  $('viewDashboard')?.addEventListener('click', () => { window.location.href = 'dashboard.html'; });

  // Auto-connect backend if preferred
  if (State.useBackend) {
    const ok = await checkBackend();
    if (ok) connectSocket();
  }
});
