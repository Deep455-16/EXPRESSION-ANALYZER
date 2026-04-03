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
  // Camera controls
  document.getElementById('startCamera')?.addEventListener('click', toggleCamera);
  document.getElementById('stopCamera')?.addEventListener('click', stopCamera);
  document.getElementById('captureFrame')?.addEventListener('click', captureFrame);
  document.getElementById('toggleOverlay')?.addEventListener('click', toggleOverlay);
  
  // Settings
  document.getElementById('detectionRate')?.addEventListener('change', (e) => {
    updateDetectionRate(e.target.value);
  });
  
  document.getElementById('confidenceThreshold')?.addEventListener('input', (e) => {
    document.getElementById('thresholdValue').textContent = e.target.value + '%';
  });
  
  // Quick actions
  document.getElementById('exportSession')?.addEventListener('click', exportCurrentSession);
  document.getElementById('clearHistory')?.addEventListener('click', clearTimeline);
  document.getElementById('viewDashboard')?.addEventListener('click', () => {
    window.location.href = 'dashboard.html';
  });
  
  // Modal controls
  document.getElementById('closeModal')?.addEventListener('click', () => {
    closeModal('captureModal');
  });
  document.getElementById('closeModal2')?.addEventListener('click', () => {
    closeModal('captureModal');
  });
  document.getElementById('downloadCapture')?.addEventListener('click', downloadCapturedImage);
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
    // Capture frame
    const canvas = captureVideoFrame(videoElement, videoElement.videoWidth, videoElement.videoHeight);
    const imageData = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    
    // Analyze (mock for now)
    const result = await analyzeExpression(imageData);
    
    // Update UI
    updateAnalysisDisplay(result);
    
    // Add to session
    sessionManager.addResult(result);
    
    // Add to timeline
    addToTimeline(result);
    
    // Update frame counter
    frameCounter++;
    fpsCounter++;
    
    // Calculate FPS
    const now = Date.now();
    if (now - lastFpsUpdate >= 1000) {
      const fps = document.getElementById('fps');
      if (fps) {
        fps.textContent = fpsCounter;
      }
      fpsCounter = 0;
      lastFpsUpdate = now;
    }
    
    // Draw overlay if enabled
    if (document.getElementById('showOverlay')?.checked) {
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
  
  // Draw face rectangle (mock position)
  const w = overlayCanvas.width;
  const h = overlayCanvas.height;
  const boxWidth = w * 0.4;
  const boxHeight = h * 0.5;
  const x = (w - boxWidth) / 2;
  const y = (h - boxHeight) / 2;
  
  overlayCtx.strokeStyle = '#6ee7b7';
  overlayCtx.lineWidth = 3;
  overlayCtx.strokeRect(x, y, boxWidth, boxHeight);
  
  // Draw label
  overlayCtx.fillStyle = 'rgba(0, 0, 0, 0.7)';
  overlayCtx.fillRect(x, y - 30, 200, 30);
  
  overlayCtx.fillStyle = '#6ee7b7';
  overlayCtx.font = 'bold 16px Inter';
  overlayCtx.fillText(`${result.dominant} (${result.confidence}%)`, x + 10, y - 10);
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
    startBtn.innerHTML = isRunning ? 
      '<i class="fas fa-pause"></i> Pause' :
      '<i class="fas fa-play"></i> Start Camera';
    startBtn.disabled = false;
  }
  
  if (stopBtn) {
    stopBtn.disabled = !isRunning;
  }
  
  if (captureBtn) {
    captureBtn.disabled = !isRunning;
  }
  
  if (toggleBtn) {
    toggleBtn.disabled = !isRunning;
  }
}
