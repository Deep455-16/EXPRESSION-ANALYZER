/**
 * main.js – Shared utilities for EmotiScan / Expression Analyser
 * Provides: settings manager, storage, IndexedDB, toast, export, nav
 */

// ── Google Fonts load ─────────────────────────────────────────────────────────
(function(){
  if(!document.querySelector('link[href*="fonts.googleapis.com/css2?family=Inter"]')){
    const l=document.createElement('link');
    l.rel='stylesheet';
    l.href='https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap';
    document.head.appendChild(l);
  }
})();

// ═══════════════════════════════════════════════════════════════════════════════
// SETTINGS MANAGER  (used by settings.js and other pages)
// ═══════════════════════════════════════════════════════════════════════════════

const SETTINGS_DEFAULTS = {
  // General
  theme:               'dark',
  accentColor:         '#6ee7b7',
  language:            'en',
  dateFormat:          'mdy',
  notifyComplete:      true,
  notifyLowConfidence: false,
  // Analysis
  defaultDetectionRate:'1000',
  minConfidence:       50,
  sensitivity:         70,
  autoSave:            true,
  gpuAccel:            true,
  // Camera
  cameraDevice:        'default',
  resolution:          '1280x720',
  fps:                 '30',
  faceOverlay:         true,
  mirrorVideo:         true,
  // Export
  exportFormat:        'csv',
  includeTimestamp:     true,
  // Privacy
  autoClearHistory:    false,
  historyRetention:    '7',
};

const settings = {
  _data: {},

  init() {
    try {
      const raw = localStorage.getItem('emotiscan_settings');
      this._data = raw ? JSON.parse(raw) : {};
    } catch { this._data = {}; }
    // Fill any missing keys with defaults
    for (const [k, v] of Object.entries(SETTINGS_DEFAULTS)) {
      if (!(k in this._data)) this._data[k] = v;
    }
  },

  get(key) {
    if (!Object.keys(this._data).length) this.init();
    return key in this._data ? this._data[key] : SETTINGS_DEFAULTS[key];
  },

  set(key, value) {
    if (!Object.keys(this._data).length) this.init();
    this._data[key] = value;
  },

  save() {
    try {
      localStorage.setItem('emotiscan_settings', JSON.stringify(this._data));
    } catch (e) { console.warn('Settings save failed:', e); }
  },

  reset() {
    this._data = { ...SETTINGS_DEFAULTS };
    this.save();
  },

  get settings() { return { ...this._data }; },
};
settings.init();


// ═══════════════════════════════════════════════════════════════════════════════
// STORAGE HELPER  (used by settings.js for sessions/batches)
// ═══════════════════════════════════════════════════════════════════════════════

const storage = {
  load(key) {
    try {
      const raw = localStorage.getItem('emotiscan_' + key);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  },
  save(key, data) {
    try {
      localStorage.setItem('emotiscan_' + key, JSON.stringify(data));
    } catch (e) { console.warn('Storage save failed:', e); }
  },
  clear() {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('emotiscan_')) keys.push(k);
    }
    keys.forEach(k => localStorage.removeItem(k));
  },
};


// ═══════════════════════════════════════════════════════════════════════════════
// INDEXEDDB WRAPPER  (EmotiDB – persistent session + result storage)
// ═══════════════════════════════════════════════════════════════════════════════

const EmotiDB = {
  _db: null,
  DB_NAME: 'EmotiScanDB',
  DB_VERSION: 2,

  async open() {
    if (this._db) return this._db;
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.DB_NAME, this.DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('sessions')) {
          const s = db.createObjectStore('sessions', { keyPath: 'session_id' });
          s.createIndex('start_time', 'start_time');
          s.createIndex('status', 'status');
        }
        if (!db.objectStoreNames.contains('results')) {
          const r = db.createObjectStore('results', { keyPath: 'id', autoIncrement: true });
          r.createIndex('session_id', 'session_id');
          r.createIndex('timestamp', 'timestamp');
          r.createIndex('source', 'source');
        }
        if (!db.objectStoreNames.contains('uploads')) {
          const u = db.createObjectStore('uploads', { keyPath: 'id', autoIncrement: true });
          u.createIndex('timestamp', 'timestamp');
        }
      };
      req.onsuccess = () => { this._db = req.result; resolve(this._db); };
      req.onerror = () => reject(req.error);
    });
  },

  async addSession(session) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction('sessions', 'readwrite');
      tx.objectStore('sessions').put(session);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  },

  async getSessions(limit = 100) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction('sessions', 'readonly');
      const store = tx.objectStore('sessions');
      const idx = store.index('start_time');
      const req = idx.openCursor(null, 'prev');
      const results = [];
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor && results.length < limit) {
          results.push(cursor.value);
          cursor.continue();
        } else {
          res(results);
        }
      };
      req.onerror = () => rej(req.error);
    });
  },

  async addResult(result) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction('results', 'readwrite');
      tx.objectStore('results').put(result);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  },

  async getResults(sessionId, limit = 500) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction('results', 'readonly');
      const store = tx.objectStore('results');
      if (sessionId) {
        const idx = store.index('session_id');
        const req = idx.getAll(sessionId, limit);
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      } else {
        const req = store.getAll(null, limit);
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      }
    });
  },

  async getAllResults() {
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction('results', 'readonly');
      const req = tx.objectStore('results').getAll();
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  },

  async addUpload(upload) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction('uploads', 'readwrite');
      tx.objectStore('uploads').put(upload);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  },

  async getUploads(limit = 100) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction('uploads', 'readonly');
      const req = tx.objectStore('uploads').getAll(null, limit);
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  },

  async getStats() {
    const [sessions, results] = await Promise.all([
      this.getSessions(1000),
      this.getAllResults(),
    ]);
    const totalSessions = sessions.length;
    const totalFrames = results.length;
    let totalConf = 0, confCount = 0;
    const emotionCounts = {};
    results.forEach(r => {
      const faces = r.face_emotions || [];
      faces.forEach(f => {
        totalConf += f.confidence || 0;
        confCount++;
        const em = f.emotion || 'neutral';
        emotionCounts[em] = (emotionCounts[em] || 0) + 1;
      });
    });
    const avgConfidence = confCount > 0 ? totalConf / confCount : 0;
    const dominant = Object.entries(emotionCounts).sort((a,b) => b[1]-a[1])[0];
    return {
      totalSessions, totalFrames, avgConfidence,
      emotionCounts, dominantEmotion: dominant ? dominant[0] : 'neutral',
      sessions, results,
    };
  },

  async clearAll() {
    const db = await this.open();
    const storeNames = ['sessions', 'results', 'uploads'];
    return new Promise((res, rej) => {
      const tx = db.transaction(storeNames, 'readwrite');
      storeNames.forEach(s => tx.objectStore(s).clear());
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  },

  async getStorageEstimate() {
    if (navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      return { usage: est.usage || 0, quota: est.quota || 0 };
    }
    return { usage: 0, quota: 0 };
  },
};


// ═══════════════════════════════════════════════════════════════════════════════
// EXPORT UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

function exportToJSON(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename || `emotiscan_export_${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function exportToCSV(headers, rows, filename) {
  const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename || `emotiscan_export_${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}


// ═══════════════════════════════════════════════════════════════════════════════
// TOAST NOTIFICATION  (supports .show class)
// ═══════════════════════════════════════════════════════════════════════════════

function showToast(message, type = 'success') {
  const toast = document.getElementById('toast');
  const msg   = document.getElementById('toastMessage');
  if (!toast || !msg) return;

  msg.textContent = message;
  // Support both old and new class patterns
  toast.className = `toast toast-${type} show`;
  const icon = toast.querySelector('i');
  if (icon) {
    icon.className = type === 'error'  ? 'fas fa-exclamation-circle'
                   : type === 'warn'   ? 'fas fa-exclamation-triangle'
                   : 'fas fa-check-circle';
  }
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    toast.classList.remove('show');
  }, 3500);
}


// ═══════════════════════════════════════════════════════════════════════════════
// MOBILE NAV + THEME INIT
// ═══════════════════════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
  // Mobile nav toggle
  const toggle = document.getElementById('mobileToggle');
  const menu   = document.getElementById('navMenu');
  toggle?.addEventListener('click', () => menu?.classList.toggle('open'));

  // Highlight active nav link
  const path = location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('.nav-menu a').forEach(a => {
    a.classList.remove('active');
    if (a.getAttribute('href') === path) a.classList.add('active');
  });

  // Apply saved theme
  applyGlobalTheme();
});

function applyGlobalTheme() {
  const theme = settings.get('theme');
  const accent = settings.get('accentColor');
  document.documentElement.setAttribute('data-theme', theme === 'auto'
    ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : theme
  );
  if (accent) {
    document.documentElement.style.setProperty('--accent', accent);
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// LOCALSTORAGE HELPERS  (backwards compatibility)
// ═══════════════════════════════════════════════════════════════════════════════

const Storage = {
  get:    (k, def) => { try { const v=localStorage.getItem(k); return v!=null?JSON.parse(v):def; } catch{return def;} },
  set:    (k, v)   => { try { localStorage.setItem(k, JSON.stringify(v)); } catch{} },
  remove: k        => localStorage.removeItem(k),
};
