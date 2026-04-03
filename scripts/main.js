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
});

// ========================================
// Utility Functions
// ========================================

// Format duration in HH:MM:SS
function formatDuration(seconds) {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  
  return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

// Format file size
function formatFileSize(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

// Format date
function formatDate(date) {
  const options = {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  };
  return new Date(date).toLocaleDateString('en-US', options);
}

// ========================================
// Mock ML Analysis Engine
// ========================================

const EMOTIONS = ['happy', 'sad', 'angry', 'surprised', 'fear', 'disgust', 'neutral'];

const EMOTION_ICONS = {
  happy: 'fa-smile',
  sad: 'fa-sad-tear',
  angry: 'fa-angry',
  surprised: 'fa-surprise',
  fear: 'fa-flushed',
  disgust: 'fa-grimace',
  neutral: 'fa-meh'
};

// Mock emotion detection (replace with real ML model)
function analyzeExpression(imageData) {
  // Simulate processing time
  return new Promise((resolve) => {
    setTimeout(() => {
      // Generate mock probabilities with some randomness
      const scores = EMOTIONS.map(() => Math.random());
      const total = scores.reduce((a, b) => a + b, 0);
      
      // Normalize to percentages
      const normalized = scores.map(s => Math.round((s / total) * 100));
      
      // Create result object
      const result = {};
      EMOTIONS.forEach((emotion, i) => {
        result[emotion] = normalized[i];
      });
      
      // Find dominant emotion
      const dominant = EMOTIONS[normalized.indexOf(Math.max(...normalized))];
      const confidence = Math.max(...normalized);
      
      resolve({
        emotions: result,
        dominant,
        confidence,
        timestamp: new Date().toISOString()
      });
    }, 100);
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
    } catch (e) {
      console.error('Storage save failed:', e);
      return false;
    }
  }
  
  load(key) {
    try {
      const data = localStorage.getItem(this.prefix + key);
      return data ? JSON.parse(data) : null;
    } catch (e) {
      console.error('Storage load failed:', e);
      return null;
    }
  }
  
  remove(key) {
    localStorage.removeItem(this.prefix + key);
  }
  
  clear() {
    const keys = Object.keys(localStorage);
    keys.forEach(key => {
      if (key.startsWith(this.prefix)) {
        localStorage.removeItem(key);
      }
    });
  }
  
  getSize() {
    let total = 0;
    const keys = Object.keys(localStorage);
    keys.forEach(key => {
      if (key.startsWith(this.prefix)) {
        total += localStorage.getItem(key).length;
      }
    });
    return total;
  }
}

// Global storage instance
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
    this.data.push({
      ...result,
      sessionTime: Date.now() - this.startTime
    });
  }
  
  getDuration() {
    if (!this.startTime) return 0;
    return Math.floor((Date.now() - this.startTime) / 1000);
  }
  
  getStats() {
    if (this.data.length === 0) {
      return {
        count: 0,
        dominant: 'neutral',
        avgConfidence: 0
      };
    }
    
    // Count emotion occurrences
    const emotionCounts = {};
    let totalConfidence = 0;
    
    this.data.forEach(result => {
      emotionCounts[result.dominant] = (emotionCounts[result.dominant] || 0) + 1;
      totalConfidence += result.confidence;
    });
    
    // Find most common emotion
    const dominant = Object.keys(emotionCounts).reduce((a, b) => 
      emotionCounts[a] > emotionCounts[b] ? a : b
    );
    
    return {
      count: this.data.length,
      dominant,
      avgConfidence: Math.round(totalConfidence / this.data.length)
    };
  }
  
  export() {
    return {
      sessionId: this.sessionId,
      startTime: new Date(this.startTime).toISOString(),
      duration: this.getDuration(),
      frameCount: this.data.length,
      data: this.data,
      stats: this.getStats()
    };
  }
  
  save() {
    if (this.sessionId && this.data.length > 0) {
      const sessions = storage.load('sessions') || [];
      sessions.unshift(this.export());
      
      // Keep only last 50 sessions
      if (sessions.length > 50) {
        sessions.length = 50;
      }
      
      storage.save('sessions', sessions);
    }
  }
}

// ========================================
// Export Functions
// ========================================

function exportToCSV(data, filename = 'export.csv') {
  const headers = Object.keys(data[0]);
  const csv = [
    headers.join(','),
    ...data.map(row => headers.map(h => JSON.stringify(row[h])).join(','))
  ].join('\n');
  
  downloadFile(csv, filename, 'text/csv');
}

function exportToJSON(data, filename = 'export.json') {
  const json = JSON.stringify(data, null, 2);
  downloadFile(json, filename, 'application/json');
}

function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ========================================
// Toast Notifications
// ========================================

function showToast(message, duration = 3000) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  
  const messageEl = document.getElementById('toastMessage');
  if (messageEl) {
    messageEl.textContent = message;
  }
  
  toast.classList.add('active');
  
  setTimeout(() => {
    toast.classList.remove('active');
  }, duration);
}

// ========================================
// Modal Functions
// ========================================

function openModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.classList.add('active');
  }
}

function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.classList.remove('active');
  }
}

// Close modal on outside click
document.addEventListener('click', (e) => {
  if (e.target.classList.contains('modal')) {
    e.target.classList.remove('active');
  }
});

// ========================================
// Chart Utilities
// ========================================

function createEmotionChart(canvasId, data) {
  const ctx = document.getElementById(canvasId);
  if (!ctx) return null;
  
  return new Chart(ctx.getContext('2d'), {
    type: 'bar',
    data: {
      labels: EMOTIONS.map(e => e.charAt(0).toUpperCase() + e.slice(1)),
      datasets: [{
        label: 'Confidence %',
        data: EMOTIONS.map(e => data[e] || 0),
        backgroundColor: 'rgba(110, 231, 183, 0.8)',
        borderColor: 'rgba(110, 231, 183, 1)',
        borderWidth: 1
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: 'y',
      plugins: {
        legend: {
          display: false
        }
      },
      scales: {
        x: {
          beginAtZero: true,
          max: 100,
          grid: {
            color: 'rgba(255, 255, 255, 0.05)'
          },
          ticks: {
            color: '#9ca7ba'
          }
        },
        y: {
          grid: {
            display: false
          },
          ticks: {
            color: '#9ca7ba'
          }
        }
      }
    }
  });
}

// ========================================
// Image Capture Utilities
// ========================================

function captureVideoFrame(video, width = 640, height = 480) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, width, height);
  return canvas;
}

function canvasToBlob(canvas) {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), 'image/jpeg', 0.95);
  });
}

function canvasToDataURL(canvas) {
  return canvas.toDataURL('image/jpeg', 0.95);
}

// ========================================
// Settings Manager
// ========================================

class SettingsManager {
  constructor() {
    this.defaults = {
      theme: 'dark',
      accentColor: '#6ee7b7',
      language: 'en',
      dateFormat: 'mdy',
      notifyComplete: true,
      notifyLowConfidence: false,
      defaultDetectionRate: '1000',
      minConfidence: 50,
      sensitivity: 70,
      autoSave: true,
      gpuAccel: true,
      cameraDevice: 'default',
      resolution: '1280x720',
      fps: '30',
      faceOverlay: true,
      mirrorVideo: true,
      exportFormat: 'csv',
      includeTimestamp: true,
      autoClearHistory: false,
      historyRetention: '7'
    };
    
    this.settings = { ...this.defaults, ...storage.load('settings') };
  }
  
  get(key) {
    return this.settings[key];
  }
  
  set(key, value) {
    this.settings[key] = value;
  }
  
  save() {
    storage.save('settings', this.settings);
  }
  
  reset() {
    this.settings = { ...this.defaults };
    this.save();
  }
}

// Global settings instance
const settings = new SettingsManager();

// ========================================
// Initialize
// ========================================

console.log('Expression Analyser initialized');
