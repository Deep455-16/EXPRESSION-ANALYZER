// ========================================
// Expression Analyser - Main JavaScript
// Shared utilities and functions
// ========================================

// Mobile Navigation Toggle
document.addEventListener('DOMContentLoaded', () => {
  const mobileToggle = document.getElementById('mobileToggle');
  const navMenu = document.getElementById('navMenu');

  if (mobileToggle && navMenu) {
    mobileToggle.addEventListener('click', () => {
      navMenu.classList.toggle('active');
    });
  }

  // Close nav on outside click (mobile)
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.navbar') && navMenu) {
      navMenu.classList.remove('active');
    }
  });
});

// ========================================
// Utility Functions
// ========================================

function formatDuration(seconds) {
  const hrs  = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  return `${hrs.toString().padStart(2,'0')}:${mins.toString().padStart(2,'0')}:${secs.toString().padStart(2,'0')}`;
}

function formatFileSize(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

function formatDate(date) {
  const options = { year:'numeric', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' };
  return new Date(date).toLocaleDateString('en-US', options);
}

// ========================================
// Mock ML Analysis Engine
// ========================================

const EMOTIONS = ['happy', 'sad', 'angry', 'surprised', 'fear', 'disgust', 'neutral'];

const EMOTION_ICONS = {
  happy:     'fa-smile',
  sad:       'fa-sad-tear',
  angry:     'fa-angry',
  surprised: 'fa-surprise',
  fear:      'fa-flushed',
  disgust:   'fa-grimace',
  neutral:   'fa-meh'
};

// Weighted mock — biases toward positive emotions for demo realism
function analyzeExpression(imageData) {
  return new Promise((resolve) => {
    setTimeout(() => {
      const weights = { happy:2.0, sad:0.7, angry:0.6, surprised:1.2, fear:0.5, disgust:0.4, neutral:1.6 };
      const scores = EMOTIONS.map(e => Math.random() * (weights[e] || 1));
      const total  = scores.reduce((a,b) => a+b, 0);
      const normalized = scores.map(s => Math.round((s/total)*100));
      const result = {};
      EMOTIONS.forEach((e,i) => { result[e] = normalized[i]; });
      const dominant   = EMOTIONS[normalized.indexOf(Math.max(...normalized))];
      const confidence = Math.max(...normalized);
      resolve({ emotions: result, dominant, confidence, timestamp: new Date().toISOString() });
    }, 80);
  });
}

// ========================================
// Storage Manager
// ========================================

class StorageManager {
  constructor(prefix = 'expression_analyser_') {
    this.prefix = prefix;
  }
  save(key, data) {
    try {
      localStorage.setItem(this.prefix + key, JSON.stringify(data));
      return true;
    } catch(e) { console.error('Storage save failed:', e); return false; }
  }
  load(key) {
    try {
      const data = localStorage.getItem(this.prefix + key);
      return data ? JSON.parse(data) : null;
    } catch(e) { console.error('Storage load failed:', e); return null; }
  }
  remove(key) { localStorage.removeItem(this.prefix + key); }
  clear() {
    Object.keys(localStorage)
      .filter(k => k.startsWith(this.prefix))
      .forEach(k => localStorage.removeItem(k));
  }
  getSize() {
    return Object.keys(localStorage)
      .filter(k => k.startsWith(this.prefix))
      .reduce((t,k) => t + localStorage.getItem(k).length, 0);
  }
}

const storage = new StorageManager();

// ========================================
// Session Manager
// ========================================

class SessionManager {
  constructor() {
    this.sessionId = null;
    this.startTime = null;
    this.data = [];
  }
  start() {
    this.sessionId = 'session_' + Date.now();
    this.startTime = Date.now();
    this.data = [];
  }
  addResult(result) {
    this.data.push({ ...result, sessionTime: Date.now() - this.startTime });
  }
  getDuration() {
    return this.startTime ? Math.floor((Date.now() - this.startTime) / 1000) : 0;
  }
  getStats() {
    if (this.data.length === 0) return { count:0, dominant:'neutral', avgConfidence:0 };
    const emotionCounts = {};
    let totalConfidence = 0;
    this.data.forEach(r => {
      emotionCounts[r.dominant] = (emotionCounts[r.dominant] || 0) + 1;
      totalConfidence += r.confidence;
    });
    const dominant = Object.keys(emotionCounts).reduce((a,b) => emotionCounts[a]>emotionCounts[b]?a:b);
    return { count: this.data.length, dominant, avgConfidence: Math.round(totalConfidence/this.data.length) };
  }
  export() {
    return {
      sessionId: this.sessionId,
      startTime: this.startTime ? new Date(this.startTime).toISOString() : null,
      duration:  this.getDuration(),
      frameCount:this.data.length,
      data:      this.data,
      stats:     this.getStats()
    };
  }
  save() {
    if (this.sessionId && this.data.length > 0) {
      const sessions = storage.load('sessions') || [];
      sessions.unshift(this.export());
      if (sessions.length > 50) sessions.length = 50;
      storage.save('sessions', sessions);
    }
  }
}

// ========================================
// Chart defaults — dark theme
// ========================================

function getDarkChartDefaults() {
  return {
    color: '#6b8aab',
    borderColor: 'rgba(16,185,129,0.12)',
    backgroundColor: 'rgba(16,185,129,0.08)',
    plugins: {
      legend: {
        labels: {
          color: '#6b8aab',
          font: { size: 12, family: "'Sora', sans-serif" },
          usePointStyle: true, pointStyle: 'circle', padding: 14
        }
      },
      tooltip: {
        backgroundColor: 'rgba(8,15,28,0.95)',
        titleColor: '#e8f4ff',
        bodyColor: '#6b8aab',
        padding: 12,
        borderColor: 'rgba(16,185,129,0.25)',
        borderWidth: 1,
        titleFont: { size: 13, weight: 'bold', family: "'Sora', sans-serif" },
        bodyFont:  { size: 12, family: "'Sora', sans-serif" }
      }
    },
    scales: {
      x: {
        ticks:  { color: '#6b8aab', font: { size:11, family:"'Sora',sans-serif" } },
        grid:   { color: 'rgba(16,185,129,0.06)', drawBorder: false }
      },
      y: {
        ticks:  { color: '#6b8aab', font: { size:11, family:"'Sora',sans-serif" } },
        grid:   { color: 'rgba(16,185,129,0.06)', drawBorder: false },
        beginAtZero: true
      }
    }
  };
}

function getEmotionColor(emotion, alpha = 1) {
  const colors = {
    happy:    `rgba(16, 185, 129, ${alpha})`,
    sad:      `rgba(96, 165, 250, ${alpha})`,
    angry:    `rgba(244,  63,  94, ${alpha})`,
    surprised:`rgba(245, 158,  11, ${alpha})`,
    fear:     `rgba(139,  92, 246, ${alpha})`,
    disgust:  `rgba(236,  72, 153, ${alpha})`,
    neutral:  `rgba(100, 116, 139, ${alpha})`
  };
  return colors[emotion] || `rgba(16,185,129,${alpha})`;
}

// ========================================
// Export Functions
// ========================================

function exportToCSV(data, filename = 'export.csv') {
  if (!data || data.length === 0) return;
  const headers = Object.keys(data[0]);
  const csv = [
    headers.join(','),
    ...data.map(row => headers.map(h => JSON.stringify(row[h] ?? '')).join(','))
  ].join('\n');
  downloadFile(csv, filename, 'text/csv');
}

function exportToJSON(data, filename = 'export.json') {
  downloadFile(JSON.stringify(data, null, 2), filename, 'application/json');
}

function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}

// ========================================
// Toast Notifications
// ========================================

function showToast(message, duration = 3500) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  const msgEl = document.getElementById('toastMessage');
  if (msgEl) msgEl.textContent = message;
  toast.classList.add('active');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove('active'), duration);
}

// ========================================
// Modal Functions
// ========================================

function openModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) modal.classList.add('active');
}

function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) modal.classList.remove('active');
}

document.addEventListener('click', (e) => {
  if (e.target.classList.contains('modal')) e.target.classList.remove('active');
});

// ========================================
// Chart Utilities
// ========================================

function createEmotionChart(canvasId, data) {
  const ctx = document.getElementById(canvasId);
  if (!ctx) return null;
  const d = getDarkChartDefaults();
  return new Chart(ctx.getContext('2d'), {
    type: 'bar',
    data: {
      labels: EMOTIONS.map(e => e.charAt(0).toUpperCase() + e.slice(1)),
      datasets: [{
        label: 'Confidence %',
        data: EMOTIONS.map(e => data[e] || 0),
        backgroundColor: EMOTIONS.map(e => getEmotionColor(e, 0.75)),
        borderColor:     EMOTIONS.map(e => getEmotionColor(e, 1)),
        borderWidth: 1, borderRadius: 6
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, indexAxis: 'y',
      plugins: { legend: { display: false }, tooltip: d.plugins.tooltip },
      scales: {
        x: { beginAtZero: true, max: 100, ...d.scales.x },
        y: { grid: { display: false }, ticks: d.scales.y.ticks }
      }
    }
  });
}

// ========================================
// Image Capture Utilities
// ========================================

function captureVideoFrame(video, width = 640, height = 480) {
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  canvas.getContext('2d').drawImage(video, 0, 0, width, height);
  return canvas;
}

function canvasToBlob(canvas) {
  return new Promise(resolve => canvas.toBlob(blob => resolve(blob), 'image/jpeg', 0.95));
}

function canvasToDataURL(canvas) {
  return canvas.toDataURL('image/jpeg', 0.95);
}

// ========================================
// Backend Health Check (shared utility)
// ========================================

async function checkBackendHealth(url) {
  try {
    const res  = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2500) });
    const data = await res.json();
    const statusEl = document.getElementById('backendStatus');
    if (statusEl) { statusEl.textContent = 'Online'; statusEl.style.color = 'var(--success)'; }
    showToast(`Backend online · MTCNN:${data.mtcnn?'✓':'✗'} DeepFace:${data.deepface?'✓':'✗'} YOLO:${data.yolo?'✓':'✗'}`);
    return true;
  } catch {
    const statusEl = document.getElementById('backendStatus');
    if (statusEl) { statusEl.textContent = 'Offline'; statusEl.style.color = 'var(--danger)'; }
    showToast('Backend offline — using mock analysis');
    return false;
  }
}

// ========================================
// Settings Manager
// ========================================

class SettingsManager {
  constructor() {
    this.defaults = {
      theme: 'dark', accentColor: '#10b981', language: 'en', dateFormat: 'mdy',
      notifyComplete: true, notifyLowConfidence: false,
      defaultDetectionRate: '1000', minConfidence: 50, sensitivity: 70,
      autoSave: true, gpuAccel: true, cameraDevice: 'default',
      resolution: '1280x720', fps: '30', faceOverlay: true, mirrorVideo: true,
      exportFormat: 'csv', includeTimestamp: true,
      autoClearHistory: false, historyRetention: '7',
      backendUrl: 'http://localhost:5000', analysisSource: 'mock'
    };
    this.settings = { ...this.defaults, ...(storage.load('settings') || {}) };
  }
  get(key)       { return this.settings[key]; }
  set(key, value){ this.settings[key] = value; }
  save()         { storage.save('settings', this.settings); }
  reset()        { this.settings = { ...this.defaults }; this.save(); }
}

const settings = new SettingsManager();

// ========================================
// Initialize
// ========================================

console.log('%c Expression Analyser ', 'background:#10b981;color:#000;font-weight:bold;padding:4px 8px;border-radius:4px;');
console.log('MTCNN + ResNet50 + WebRTC | v2.0');
