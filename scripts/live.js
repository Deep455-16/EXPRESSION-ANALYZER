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
});

function initializePage() {
  videoElement = document.getElementById('webcam');
  overlayCanvas = document.getElementById('overlay');
  sessionManager = new SessionManager();
  
  // Initialize emotion chart
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
  document.getElementById('stopCamera')?.addEventListener('click', stopCamera);
  document.getElementById('captureFrame')?.addEventListener('click', captureFrame);
  document.getElementById('toggleOverlay')?.addEventListener('click', toggleOverlay);
  document.getElementById('startCameraMain')?.addEventListener('click', toggleCamera);
  
  // Backend connection
  document.getElementById('connectBackendBtn')?.addEventListener('click', connectBackend);
  
  document.getElementById('detectionRate')?.addEventListener('change', (e) => {
    updateDetectionRate(e.target.value);
  });
  
  document.getElementById('confidenceThreshold')?.addEventListener('input', (e) => {
    document.getElementById('thresholdValue').textContent = e.target.value + '%';
  });
  
  document.getElementById('exportSession')?.addEventListener('click', exportCurrentSession);
  document.getElementById('clearHistory')?.addEventListener('click', clearTimeline);
  document.getElementById('viewDashboard')?.addEventListener('click', () => {
    window.location.href = 'dashboard.html';
  });
  
  document.getElementById('closeModal')?.addEventListener('click', () => closeModal('captureModal'));
  document.getElementById('closeModal2')?.addEventListener('click', () => closeModal('captureModal'));
  document.getElementById('downloadCapture')?.addEventListener('click', downloadCapturedImage);
  
  // WebRTC controls
  document.getElementById('toggleWebRTCMode')?.addEventListener('click', toggleWebRTCMode);
  document.getElementById('joinRoomBtn')?.addEventListener('click', joinRoom);
  document.getElementById('leaveRoomBtn')?.addEventListener('click', leaveRoom);
}

function loadSettings() {
  const rate = settings.get('defaultDetectionRate');
  const threshold = settings.get('minConfidence');
  
  if (document.getElementById('detectionRate')) {
    document.getElementById('detectionRate').value = rate;
  }
  
  if (document.getElementById('confidenceThreshold')) {
    document.getElementById('confidenceThreshold').value = threshold;
    document.getElementById('thresholdValue').textContent = threshold + '%';
  }
}

// ========================================
// Camera Control
// ========================================

async function toggleCamera() {
  if (isRunning) {
    stopCamera();
  } else {
    await startCamera();
  }
}

async function startCamera() {
  try {
    // Request camera access
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 }
      },
      audio: false
    });
    
    videoElement.srcObject = stream;
    
    // Wait for video to be ready
    await new Promise((resolve) => {
      videoElement.onloadedmetadata = () => {
        videoElement.play();
        resolve();
      };
    });
    
    // Setup overlay canvas
    overlayCanvas.width = videoElement.videoWidth;
    overlayCanvas.height = videoElement.videoHeight;
    overlayCtx = overlayCanvas.getContext('2d');
    
    isRunning = true;
    sessionManager.start();
    
    // Start analysis
    startAnalysis();
    
    // Start session timer
    sessionTimer = setInterval(updateSessionInfo, 1000);
    
    // Update UI
    updateUI();
    updateStatus('Recording', true);
    
  } catch (error) {
    console.error('Camera access error:', error);
    alert('Could not access camera. Please ensure you have granted camera permissions.');
  }
}

function stopCamera() {
  if (stream) {
    stream.getTracks().forEach(track => track.stop());
    stream = null;
  }
  
  if (videoElement) {
    videoElement.srcObject = null;
  }
  
  if (analysisInterval) {
    clearInterval(analysisInterval);
    analysisInterval = null;
  }
  
  if (sessionTimer) {
    clearInterval(sessionTimer);
    sessionTimer = null;
  }
  
  isRunning = false;
  
  // Save session
  sessionManager.save();
  
  updateUI();
  updateStatus('Stopped', false);
}

function updateStatus(text, recording = false) {
  const statusText = document.getElementById('statusText');
  const videoStatus = document.getElementById('videoStatus');
  
  if (statusText) {
    statusText.textContent = text;
  }
  
  if (videoStatus) {
    const icon = videoStatus.querySelector('i');
    if (icon) {
      icon.style.color = recording ? '#10b981' : '#ef4444';
    }
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
  if (analysisInterval) {
    clearInterval(analysisInterval);
  }
  
  if (!isRunning) return;
  
  if (rate === 'realtime') {
    // Request animation frame for real-time
    function analyzeFrame() {
      if (isRunning) {
        performAnalysis();
        requestAnimationFrame(analyzeFrame);
      }
    }
    analyzeFrame();
  } else {
    // Interval-based
    const interval = parseInt(rate);
    analysisInterval = setInterval(() => {
      performAnalysis();
    }, interval);
  }
}

async function performAnalysis() {
  if (!isRunning || !videoElement) return;
  
  try {
    const canvas = captureVideoFrame(videoElement, videoElement.videoWidth, videoElement.videoHeight);
    const imageData = canvas.toDataURL('image/jpeg', 0.85);
    
    const source = document.getElementById('analysisSource')?.value || 'mock';
    let result;
    
    if (source === 'backend' && BackendAPI.connected) {
      const start = performance.now();
      result = await BackendAPI.analyzeFrame(imageData);
      const latency = Math.round(performance.now() - start);
      const badge = document.getElementById('backendBadge');
      const latencyEl = document.getElementById('latencyMs');
      if (badge) badge.style.display = 'block';
      if (latencyEl) latencyEl.textContent = latency;
      
      if (!result || result.error) {
        result = await analyzeExpression(null);
      }
    } else {
      result = await analyzeExpression(null);
    }
    
    updateAnalysisDisplay(result);
    sessionManager.addResult(result);
    addToTimeline(result);
    frameCounter++;
    fpsCounter++;
    
    const now = Date.now();
    if (now - lastFpsUpdate >= 1000) {
      const fps = document.getElementById('fps');
      if (fps) fps.textContent = fpsCounter;
      fpsCounter = 0;
      lastFpsUpdate = now;
    }
    
    if (document.getElementById('showOverlay')?.checked && result.face_box) {
      drawOverlayWithBox(result);
    } else if (document.getElementById('showOverlay')?.checked) {
      drawOverlay(result);
    }
    
  } catch (error) {
    console.error('Analysis error:', error);
  }
}

function updateAnalysisDisplay(result) {
  // Update dominant emotion
  const emotionIcon = document.getElementById('emotionIcon');
  const emotionName = document.getElementById('emotionName');
  const emotionConfidence = document.getElementById('emotionConfidence');
  
  if (emotionIcon) {
    const iconClass = EMOTION_ICONS[result.dominant] || 'fa-meh';
    emotionIcon.innerHTML = `<i class="fas ${iconClass}"></i>`;
  }
  
  if (emotionName) {
    emotionName.textContent = result.dominant.charAt(0).toUpperCase() + result.dominant.slice(1);
  }
  
  if (emotionConfidence) {
    emotionConfidence.textContent = result.confidence + '%';
  }
  
  // Update emotion bars
  updateEmotionBars(result.emotions);
  
  // Update chart
  if (emotionChart) {
    emotionChart.data.datasets[0].data = EMOTIONS.map(e => result.emotions[e] || 0);
    emotionChart.update('none');
  }
}

function updateEmotionBars(emotions) {
  const barsContainer = document.getElementById('emotionBars');
  if (!barsContainer) return;
  
  // Sort emotions by value
  const sorted = Object.entries(emotions).sort((a, b) => b[1] - a[1]);
  
  barsContainer.innerHTML = sorted.map(([emotion, value]) => `
    <div class="emotion-bar">
      <span style="text-transform: capitalize;">${emotion}</span>
      <span style="color: var(--accent-primary);">${value}%</span>
    </div>
  `).join('');
}

function drawOverlay(result) {
  if (!overlayCtx) return;
  overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  const w = overlayCanvas.width;
  const h = overlayCanvas.height;
  const boxWidth = w * 0.4;
  const boxHeight = h * 0.5;
  const x = (w - boxWidth) / 2;
  const y = (h - boxHeight) / 2;
  overlayCtx.strokeStyle = '#6ee7b7';
  overlayCtx.lineWidth = 3;
  overlayCtx.strokeRect(x, y, boxWidth, boxHeight);
  overlayCtx.fillStyle = 'rgba(0, 0, 0, 0.7)';
  overlayCtx.fillRect(x, y - 30, 200, 30);
  overlayCtx.fillStyle = '#6ee7b7';
  overlayCtx.font = 'bold 16px Inter';
  overlayCtx.fillText(`${result.dominant} (${result.confidence}%)`, x + 10, y - 10);
}

function drawOverlayWithBox(result) {
  if (!overlayCtx || !result.face_box) return;
  overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  const { x, y, w, h } = result.face_box;
  const scaleX = overlayCanvas.width / videoElement.videoWidth;
  const scaleY = overlayCanvas.height / videoElement.videoHeight;
  overlayCtx.strokeStyle = '#6ee7b7';
  overlayCtx.lineWidth = 3;
  overlayCtx.strokeRect(x * scaleX, y * scaleY, w * scaleX, h * scaleY);
  overlayCtx.fillStyle = 'rgba(0, 0, 0, 0.7)';
  overlayCtx.fillRect(x * scaleX, y * scaleY - 30, 200, 30);
  overlayCtx.fillStyle = '#6ee7b7';
  overlayCtx.font = 'bold 16px Inter';
  const label = result.concentration ? `${result.dominant} | ${result.concentration.level}%` : `${result.dominant} (${result.confidence}%)`;
  overlayCtx.fillText(label, x * scaleX + 10, y * scaleY - 10);
}

function toggleOverlay() {
  if (!overlayCtx) return;
  overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
}

// ========================================
// Session Info
// ========================================

function updateSessionInfo() {
  const duration = sessionManager.getDuration();
  const durationEl = document.getElementById('sessionDuration');
  const frameCountEl = document.getElementById('frameCount');
  
  if (durationEl) {
    durationEl.textContent = formatDuration(duration);
  }
  
  if (frameCountEl) {
    frameCountEl.textContent = frameCounter;
  }
}

// ========================================
// Timeline
// ========================================

function addToTimeline(result) {
  const timeline = document.getElementById('timeline');
  if (!timeline) return;
  
  // Remove empty state
  const empty = timeline.querySelector('.timeline-empty');
  if (empty) {
    empty.remove();
  }
  
  // Create timeline item
  const item = document.createElement('div');
  item.className = 'timeline-item';
  item.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: center;">
      <div>
        <strong style="text-transform: capitalize;">${result.dominant}</strong>
        <div style="font-size: 0.75rem; color: var(--text-secondary);">
          ${new Date().toLocaleTimeString()}
        </div>
      </div>
      <div style="font-weight: 700; color: var(--accent-primary);">
        ${result.confidence}%
      </div>
    </div>
  `;
  
  timeline.insertBefore(item, timeline.firstChild);
  
  // Keep only last 20 items
  while (timeline.children.length > 20) {
    timeline.removeChild(timeline.lastChild);
  }
}

function clearTimeline() {
  const timeline = document.getElementById('timeline');
  if (!timeline) return;
  
  timeline.innerHTML = `
    <div class="timeline-empty">
      <i class="fas fa-info-circle"></i>
      <p>Start analysis to see timeline</p>
    </div>
  `;
  
  frameCounter = 0;
  sessionManager = new SessionManager();
}

// ========================================
// Capture
// ========================================

let capturedImageData = null;

function captureFrame() {
  if (!isRunning || !videoElement) return;
  
  const canvas = captureVideoFrame(videoElement, videoElement.videoWidth, videoElement.videoHeight);
  capturedImageData = canvasToDataURL(canvas);
  
  // Show in modal
  const img = document.getElementById('capturedImage');
  if (img) {
    img.src = capturedImageData;
  }
  
  // Show capture info
  const info = document.getElementById('captureInfo');
  if (info) {
    const stats = sessionManager.getStats();
    info.innerHTML = `
      <div style="margin-top: 1rem; padding: 1rem; background: rgba(255,255,255,0.02); border-radius: 8px;">
        <div style="margin-bottom: 0.5rem;">
          <strong>Dominant Emotion:</strong> <span style="text-transform: capitalize;">${stats.dominant}</span>
        </div>
        <div style="margin-bottom: 0.5rem;">
          <strong>Avg Confidence:</strong> ${stats.avgConfidence}%
        </div>
        <div>
          <strong>Captured:</strong> ${new Date().toLocaleString()}
        </div>
      </div>
    `;
  }
  
  openModal('captureModal');
}

function downloadCapturedImage() {
  if (!capturedImageData) return;
  
  const a = document.createElement('a');
  a.href = capturedImageData;
  a.download = `capture_${Date.now()}.jpg`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// ========================================
// Export
// ========================================

function exportCurrentSession() {
  const data = sessionManager.export();
  
  if (data.data.length === 0) {
    alert('No data to export. Start analysis first.');
    return;
  }
  
  const format = settings.get('exportFormat') || 'json';
  const timestamp = settings.get('includeTimestamp') ? '_' + Date.now() : '';
  
  if (format === 'json') {
    exportToJSON(data, `session${timestamp}.json`);
  } else {
    // Convert to CSV-friendly format
    const csvData = data.data.map(item => ({
      timestamp: item.timestamp,
      dominant: item.dominant,
      confidence: item.confidence,
      sessionTime: item.sessionTime,
      ...item.emotions
    }));
    exportToCSV(csvData, `session${timestamp}.csv`);
  }
}

// ========================================
// UI Updates
// ========================================

function updateUI() {
  const startBtn = document.getElementById('startCamera');
  const stopBtn = document.getElementById('stopCamera');
  const captureBtn = document.getElementById('captureFrame');
  const toggleBtn = document.getElementById('toggleOverlay');
  
  if (startBtn) {
    startBtn.innerHTML = isRunning ? '<i class="fas fa-pause"></i> Pause' : '<i class="fas fa-play"></i> Start Camera';
    startBtn.disabled = false;
  }
  if (stopBtn) stopBtn.disabled = !isRunning;
  if (captureBtn) captureBtn.disabled = !isRunning;
  if (toggleBtn) toggleBtn.disabled = !isRunning;
}

// ========================================
// Backend Connection
// ========================================

async function connectBackend() {
  const urlInput = document.getElementById('backendUrlInput');
  if (urlInput) BackendAPI.baseUrl = urlInput.value.replace(/\/$/, '');
  
  const statusEl = document.getElementById('backendStatus');
  const result = await BackendAPI.checkHealth();
  
  if (result && BackendAPI.connected) {
    if (statusEl) {
      statusEl.textContent = 'Online';
      statusEl.style.color = 'var(--success)';
    }
    showToast(`Backend connected: ${result.model}`);
  } else {
    if (statusEl) {
      statusEl.textContent = 'Offline';
      statusEl.style.color = 'var(--danger)';
    }
    showToast('Backend not reachable. Using mock mode.', 4000);
  }
}

// ========================================
// WebRTC Room Management
// ========================================

let webrtcModeActive = false;
let webrtcPollInterval = null;

function toggleWebRTCMode() {
  webrtcModeActive = !webrtcModeActive;
  const statusBar = document.getElementById('webrtcStatusBar');
  const participantsSection = document.getElementById('webrtcParticipantsSection');
  const btn = document.getElementById('toggleWebRTCMode');
  
  if (webrtcModeActive) {
    if (statusBar) statusBar.style.display = 'flex';
    if (participantsSection) participantsSection.style.display = 'block';
    if (btn) {
      btn.innerHTML = '<i class="fas fa-users-slash"></i> Exit WebRTC';
      btn.classList.remove('btn-secondary');
      btn.classList.add('btn-danger');
    }
    updateRTCStatus('disconnected', 'Not connected');
    showToast('WebRTC Mode enabled. Join a room to start.');
  } else {
    if (statusBar) statusBar.style.display = 'none';
    if (participantsSection) participantsSection.style.display = 'none';
    if (btn) {
      btn.innerHTML = '<i class="fas fa-users"></i> WebRTC Mode';
      btn.classList.remove('btn-danger');
      btn.classList.add('btn-secondary');
    }
    if (webrtcPollInterval) clearInterval(webrtcPollInterval);
    showToast('WebRTC Mode disabled.');
  }
}

async function joinRoom() {
  const roomId = document.getElementById('roomIdInput')?.value || 'meet-room-001';
  const result = await BackendAPI.joinRoom(roomId);
  
  if (result) {
    updateRTCStatus('connected', `Connected to ${roomId}`);
    document.getElementById('joinRoomBtn').style.display = 'none';
    document.getElementById('leaveRoomBtn').style.display = 'inline-flex';
    showToast(`Joined room: ${roomId}`);
    
    // Start polling for participant updates
    if (webrtcPollInterval) clearInterval(webrtcPollInterval);
    webrtcPollInterval = setInterval(() => updateParticipantDisplay(roomId), 2000);
    updateParticipantDisplay(roomId);
  } else {
    showToast('Failed to join room. Check backend connection.', 4000);
  }
}

async function leaveRoom() {
  const roomId = document.getElementById('roomIdInput')?.value || 'meet-room-001';
  await BackendAPI.leaveRoom(roomId);
  
  updateRTCStatus('disconnected', 'Not connected');
  document.getElementById('joinRoomBtn').style.display = 'inline-flex';
  document.getElementById('leaveRoomBtn').style.display = 'none';
  
  if (webrtcPollInterval) clearInterval(webrtcPollInterval);
  const grid = document.getElementById('remoteParticipantsGrid');
  if (grid) grid.innerHTML = '';
  
  showToast('Left room.');
}

function updateRTCStatus(state, text) {
  const dot = document.getElementById('rtcDot');
  const statusText = document.getElementById('rtcStatusText');
  if (dot) {
    dot.className = `rtc-dot ${state}`;
  }
  if (statusText) {
    statusText.textContent = text;
  }
}

async function updateParticipantDisplay(roomId) {
  const summary = await BackendAPI.getRoomSummary(roomId);
  if (!summary) return;
  
  const grid = document.getElementById('remoteParticipantsGrid');
  const countEl = document.getElementById('participantCount');
  if (countEl) countEl.textContent = summary.participant_count;
  
  if (!grid) return;
  
  grid.innerHTML = Object.entries(summary.participants || {}).map(([pid, data]) => {
    const conc = data.concentration || 0;
    const level = conc >= 80 ? 'Highly Focused' : conc >= 60 ? 'Engaged' : conc >= 40 ? 'Moderate' : 'Distracted';
    const color = conc >= 60 ? 'var(--success)' : conc >= 40 ? 'var(--warning)' : 'var(--danger)';
    const shortId = pid.slice(0, 8);
    
    return `
      <div class="participant-card" style="background:var(--card-bg);border:1px solid var(--border);border-radius:8px;padding:12px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
          <span style="font-weight:600;font-size:12px;">${shortId}</span>
          <span style="font-size:11px;color:${color};font-weight:700;">${level}</span>
        </div>
        <div style="background:var(--background);border-radius:4px;height:6px;overflow:hidden;">
          <div style="width:${conc}%;height:100%;background:${color};border-radius:4px;transition:width 0.5s;"></div>
        </div>
        <div style="font-size:11px;color:var(--text-secondary);margin-top:4px;text-align:right;">${conc}% concentration</div>
      </div>
    `;
  }).join('');
}
