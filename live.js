// ========================================
// Live Analysis Page - JavaScript
// ========================================

let stream = null;
let videoElement = null;
let overlayCanvas = null;
let overlayCtx = null;
let isRunning = false;
let sessionManager = null;
let emotionChart = null;
let analysisInterval = null;
let sessionTimer = null;
let frameCounter = 0;
let fpsCounter = 0;
let lastFpsUpdate = Date.now();

// ========================================
// Initialize Page
// ========================================

document.addEventListener('DOMContentLoaded', () => {
  initializePage();
  setupEventListeners();
  loadSettings();
  setupBackendControls();
});

function initializePage() {
  videoElement   = document.getElementById('webcam');
  overlayCanvas  = document.getElementById('overlay');
  sessionManager = new SessionManager();

  const chartCanvas = document.getElementById('emotionChart');
  if (chartCanvas) {
    const emptyData = {};
    EMOTIONS.forEach(e => emptyData[e] = 0);
    emotionChart = createEmotionChart('emotionChart', emptyData);
  }
  updateUI();
}

function setupEventListeners() {
  document.getElementById('startCamera')?.addEventListener('click', toggleCamera);
  document.getElementById('startCameraMain')?.addEventListener('click', toggleCamera);
  document.getElementById('stopCamera')?.addEventListener('click', stopCamera);
  document.getElementById('captureFrame')?.addEventListener('click', captureFrame);
  document.getElementById('toggleOverlay')?.addEventListener('click', toggleOverlay);

  document.getElementById('detectionRate')?.addEventListener('change', (e) => {
    updateDetectionRate(e.target.value);
  });

  document.getElementById('confidenceThreshold')?.addEventListener('input', (e) => {
    const el = document.getElementById('thresholdValue');
    if (el) el.textContent = e.target.value + '%';
  });

  document.getElementById('exportSession')?.addEventListener('click', exportCurrentSession);
  document.getElementById('clearHistory')?.addEventListener('click', clearTimeline);
  document.getElementById('viewDashboard')?.addEventListener('click', () => {
    window.location.href = 'dashboard.html';
  });

  document.getElementById('closeModal')?.addEventListener('click', () => closeModal('captureModal'));
  document.getElementById('closeModal2')?.addEventListener('click', () => closeModal('captureModal'));
  document.getElementById('downloadCapture')?.addEventListener('click', downloadCapturedImage);
}

function setupBackendControls() {
  document.getElementById('connectBackendBtn')?.addEventListener('click', () => {
    const url = document.getElementById('backendUrlInput')?.value || 'http://localhost:5000';
    checkBackendHealth(url);
  });
}

function loadSettings() {
  const rate      = settings.get('defaultDetectionRate');
  const threshold = settings.get('minConfidence');

  const rateEl = document.getElementById('detectionRate');
  if (rateEl) rateEl.value = rate;

  const thEl  = document.getElementById('confidenceThreshold');
  const thVal = document.getElementById('thresholdValue');
  if (thEl)  thEl.value = threshold;
  if (thVal) thVal.textContent = threshold + '%';

  const srcEl = document.getElementById('analysisSource');
  if (srcEl) srcEl.value = settings.get('analysisSource') || 'mock';

  const urlEl = document.getElementById('backendUrlInput');
  if (urlEl) urlEl.value = settings.get('backendUrl') || 'http://localhost:5000';
}

// ========================================
// Camera Control
// ========================================

async function toggleCamera() {
  if (isRunning) stopCamera();
  else await startCamera();
}

async function startCamera() {
  try {
    const resStr = settings.get('resolution') || '1280x720';
    const [width, height] = resStr.split('x').map(Number);

    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: width }, height: { ideal: height } },
      audio: false
    });

    videoElement.srcObject = stream;
    await new Promise(resolve => { videoElement.onloadedmetadata = () => { videoElement.play(); resolve(); }; });

    overlayCanvas.width  = videoElement.videoWidth;
    overlayCanvas.height = videoElement.videoHeight;
    overlayCtx = overlayCanvas.getContext('2d');

    isRunning = true;
    sessionManager.start();
    startAnalysis();
    sessionTimer = setInterval(updateSessionInfo, 1000);

    // Expose stream globally for WebRTC module
    window._localStream = stream;

    updateUI();
    updateStatus('Recording', true);
    showToast('Camera started');

  } catch (error) {
    console.error('Camera access error:', error);
    showToast('Could not access camera. Check permissions.');
  }
}

function stopCamera() {
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  if (videoElement) videoElement.srcObject = null;
  if (analysisInterval) { clearInterval(analysisInterval); analysisInterval = null; }
  if (sessionTimer)     { clearInterval(sessionTimer); sessionTimer = null; }

  window._localStream = null;
  isRunning = false;
  sessionManager.save();
  updateUI();
  updateStatus('Stopped', false);
}

function updateStatus(text, recording = false) {
  const statusText  = document.getElementById('statusText');
  const videoStatus = document.getElementById('videoStatus');
  if (statusText) statusText.textContent = text;
  if (videoStatus) {
    const icon = videoStatus.querySelector('i');
    if (icon) icon.style.color = recording ? 'var(--success)' : 'var(--danger)';
  }
}

// ========================================
// Analysis
// ========================================

function startAnalysis() {
  const rate = document.getElementById('detectionRate')?.value || '1000';
  updateDetectionRate(rate);
}

function updateDetectionRate(rate) {
  if (analysisInterval) { clearInterval(analysisInterval); analysisInterval = null; }
  if (!isRunning) return;

  if (rate === 'realtime') {
    const loop = () => { if (isRunning) { performAnalysis(); requestAnimationFrame(loop); } };
    loop();
  } else {
    analysisInterval = setInterval(() => performAnalysis(), parseInt(rate));
  }
}

async function performAnalysis() {
  if (!isRunning || !videoElement) return;

  const source = document.getElementById('analysisSource')?.value || 'mock';

  try {
    const canvas    = captureVideoFrame(videoElement, videoElement.videoWidth, videoElement.videoHeight);
    let result;

    if (source === 'backend') {
      result = await analyseViaBackend(canvas);
    } else {
      const imageData = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
      result = await analyzeExpression(imageData);
    }

    updateAnalysisDisplay(result);
    sessionManager.addResult(result);
    addToTimeline(result);

    frameCounter++;
    fpsCounter++;
    const now = Date.now();
    if (now - lastFpsUpdate >= 1000) {
      const fpsEl = document.getElementById('fps');
      if (fpsEl) fpsEl.textContent = fpsCounter;
      fpsCounter = 0;
      lastFpsUpdate = now;
    }

    if (document.getElementById('showOverlay')?.checked) drawOverlay(result);

  } catch (error) {
    console.error('Analysis error:', error);
  }
}

// ── Backend API call ─────────────────────────────────
async function analyseViaBackend(canvas) {
  const url   = document.getElementById('backendUrlInput')?.value || 'http://localhost:5000';
  const frame = canvas.toDataURL('image/jpeg', 0.75).split(',')[1];
  const t0    = performance.now();

  try {
    const res  = await fetch(`${url}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ frame, participant_id: 'local', method: 'mtcnn' }),
      signal: AbortSignal.timeout(3000),
    });
    const data    = await res.json();
    const latency = Math.round(performance.now() - t0);

    const badge = document.getElementById('backendBadge');
    const latEl = document.getElementById('latencyMs');
    if (badge) badge.style.display = 'block';
    if (latEl) latEl.textContent = latency;

    if (data.face_emotions && data.face_emotions.length > 0) {
      const fe = data.face_emotions[0];
      const emotions = {};
      EMOTIONS.forEach(e => { emotions[e] = Math.round((fe.scores[e] || 0) * 100); });
      return { emotions, dominant: fe.emotion, confidence: Math.round(fe.confidence * 100), timestamp: new Date().toISOString() };
    }
    return await analyzeExpression(null);
  } catch {
    return await analyzeExpression(null);
  }
}

function updateAnalysisDisplay(result) {
  const emotionIcon       = document.getElementById('emotionIcon');
  const emotionName       = document.getElementById('emotionName');
  const emotionConfidence = document.getElementById('emotionConfidence');

  if (emotionIcon) {
    emotionIcon.innerHTML = `<i class="fas ${EMOTION_ICONS[result.dominant] || 'fa-meh'}" style="color:${getEmotionColor(result.dominant, 1)}"></i>`;
  }
  if (emotionName)       emotionName.textContent = result.dominant.charAt(0).toUpperCase() + result.dominant.slice(1);
  if (emotionConfidence) emotionConfidence.textContent = result.confidence + '%';

  updateEmotionBars(result.emotions);

  if (emotionChart) {
    emotionChart.data.datasets[0].data = EMOTIONS.map(e => result.emotions[e] || 0);
    emotionChart.update('none');
  }
}

function updateEmotionBars(emotions) {
  const barsContainer = document.getElementById('emotionBars');
  if (!barsContainer) return;

  const sorted = Object.entries(emotions).sort((a,b) => b[1]-a[1]);
  barsContainer.innerHTML = sorted.map(([emotion, value]) => `
    <div class="emotion-bar">
      <span style="text-transform:capitalize;color:var(--text-primary)">${emotion}</span>
      <div style="display:flex;align-items:center;gap:10px;flex:1;justify-content:flex-end">
        <div style="width:80px;height:4px;border-radius:2px;background:var(--card-bg2);overflow:hidden">
          <div style="width:${value}%;height:100%;background:${getEmotionColor(emotion,1)};border-radius:2px;transition:width .4s"></div>
        </div>
        <span style="color:var(--primary);font-family:var(--fm);font-size:12px;min-width:32px;text-align:right">${value}%</span>
      </div>
    </div>
  `).join('');
}

function drawOverlay(result) {
  if (!overlayCtx) return;
  overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

  const w = overlayCanvas.width, h = overlayCanvas.height;
  const bw = w*0.38, bh = h*0.52;
  const x  = (w-bw)/2, y = (h-bh)/2;
  const cs = 18;
  const color = getEmotionColor(result.dominant, 1);

  overlayCtx.strokeStyle = color; overlayCtx.lineWidth = 2.5;
  // Corner brackets
  [[x,y,1,1],[x+bw,y,-1,1],[x,y+bh,1,-1],[x+bw,y+bh,-1,-1]].forEach(([cx,cy,dx,dy]) => {
    overlayCtx.beginPath();
    overlayCtx.moveTo(cx, cy+dy*cs); overlayCtx.lineTo(cx, cy); overlayCtx.lineTo(cx+dx*cs, cy);
    overlayCtx.stroke();
  });

  // Label background + text
  const label = `${result.dominant.toUpperCase()}  ${result.confidence}%`;
  overlayCtx.fillStyle = 'rgba(4,8,15,0.75)';
  overlayCtx.fillRect(x, y-28, label.length * 9 + 12, 26);
  overlayCtx.fillStyle = color;
  overlayCtx.font = 'bold 12px JetBrains Mono, monospace';
  overlayCtx.fillText(label, x + 6, y - 10);

  // Scanline shimmer
  const scanGrad = overlayCtx.createLinearGradient(0, y, 0, y+bh);
  scanGrad.addColorStop(0, 'transparent');
  scanGrad.addColorStop(0.5, `${color.replace('1)',  '0.04)')}`);
  scanGrad.addColorStop(1, 'transparent');
  overlayCtx.fillStyle = scanGrad;
  overlayCtx.fillRect(x, y, bw, bh);
}

function toggleOverlay() {
  if (overlayCtx) overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
}

// ========================================
// Session Info
// ========================================

function updateSessionInfo() {
  const durationEl   = document.getElementById('sessionDuration');
  const frameCountEl = document.getElementById('frameCount');
  if (durationEl)   durationEl.textContent   = formatDuration(sessionManager.getDuration());
  if (frameCountEl) frameCountEl.textContent = frameCounter;
}

// ========================================
// Timeline
// ========================================

function addToTimeline(result) {
  const timeline = document.getElementById('timeline');
  if (!timeline) return;

  const empty = timeline.querySelector('.timeline-empty');
  if (empty) empty.remove();

  const color = getEmotionColor(result.dominant, 1);
  const item  = document.createElement('div');
  item.className = 'timeline-item';
  item.style.borderLeftColor = color;
  item.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center">
      <div>
        <strong style="text-transform:capitalize;color:${color}">${result.dominant}</strong>
        <div style="font-size:11px;color:var(--text-secondary);margin-top:2px;font-family:var(--fm)">
          ${new Date().toLocaleTimeString()}
        </div>
      </div>
      <div style="font-weight:700;color:var(--primary);font-family:var(--fm)">${result.confidence}%</div>
    </div>
  `;

  timeline.insertBefore(item, timeline.firstChild);
  while (timeline.children.length > 20) timeline.removeChild(timeline.lastChild);
}

function clearTimeline() {
  const timeline = document.getElementById('timeline');
  if (timeline) {
    timeline.innerHTML = `<div class="timeline-empty"><i class="fas fa-info-circle"></i><p>Start analysis to see timeline</p></div>`;
  }
  frameCounter   = 0;
  sessionManager = new SessionManager();
}

// ========================================
// Capture
// ========================================

let capturedImageData = null;

function captureFrame() {
  if (!isRunning || !videoElement) return;

  const canvas        = captureVideoFrame(videoElement, videoElement.videoWidth, videoElement.videoHeight);
  capturedImageData   = canvasToDataURL(canvas);

  const img = document.getElementById('capturedImage');
  if (img) img.src = capturedImageData;

  const info  = document.getElementById('captureInfo');
  const stats = sessionManager.getStats();
  if (info) {
    info.innerHTML = `
      <div style="margin-top:14px;padding:14px;background:var(--card-bg2);border-radius:9px;border:1px solid var(--border);font-size:13px;display:flex;flex-direction:column;gap:6px">
        <div><strong style="color:var(--text-secondary)">Dominant Emotion:</strong> <span style="text-transform:capitalize;color:var(--primary)">${stats.dominant}</span></div>
        <div><strong style="color:var(--text-secondary)">Avg Confidence:</strong> <span style="font-family:var(--fm);color:var(--primary)">${stats.avgConfidence}%</span></div>
        <div><strong style="color:var(--text-secondary)">Captured:</strong> <span style="color:var(--text-secondary)">${new Date().toLocaleString()}</span></div>
      </div>
    `;
  }
  openModal('captureModal');
}

function downloadCapturedImage() {
  if (!capturedImageData) return;
  const a = document.createElement('a');
  a.href = capturedImageData; a.download = `capture_${Date.now()}.jpg`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
}

// ========================================
// Export
// ========================================

function exportCurrentSession() {
  const data = sessionManager.export();
  if (data.data.length === 0) { showToast('No data to export. Start analysis first.'); return; }

  const format    = settings.get('exportFormat') || 'json';
  const timestamp = settings.get('includeTimestamp') ? '_' + Date.now() : '';

  if (format === 'json') {
    exportToJSON(data, `session${timestamp}.json`);
  } else {
    const csvData = data.data.map(item => ({
      timestamp: item.timestamp, dominant: item.dominant,
      confidence: item.confidence, sessionTime: item.sessionTime, ...item.emotions
    }));
    exportToCSV(csvData, `session${timestamp}.csv`);
  }
  showToast('Session exported');
}

// ========================================
// UI Updates
// ========================================

function updateUI() {
  const startBtn  = document.getElementById('startCamera');
  const startMain = document.getElementById('startCameraMain');
  const stopBtn   = document.getElementById('stopCamera');
  const captureBtn= document.getElementById('captureFrame');

  const label = isRunning ? '<i class="fas fa-pause"></i> Pause' : '<i class="fas fa-play"></i> Start Camera';
  if (startBtn)  { startBtn.innerHTML = label; startBtn.disabled = false; }
  if (startMain) { startMain.innerHTML = label; }
  if (stopBtn)   stopBtn.disabled = !isRunning;
  if (captureBtn)captureBtn.disabled = !isRunning;
}
