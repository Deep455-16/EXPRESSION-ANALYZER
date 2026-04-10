/**
 * settings.js — Settings page management
 * Uses the `settings` object from main.js for persistence.
 * Supports: save, load, reset, export data, clear data, camera detection.
 */

let currentSection = 'general';

// ═════════════════════════════════════════════════════════════════════════════
// INIT
// ═════════════════════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
  initializeSettings();
  setupSettingsListeners();
  loadSettings();
  detectSystemInfo();
  updateStorageInfo();
});

function initializeSettings() {
  showSection('general');
}

function setupSettingsListeners() {
  // Section navigation
  document.querySelectorAll('.settings-nav-item').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const section = e.currentTarget.dataset.section;
      showSection(section);
      document.querySelectorAll('.settings-nav-item').forEach(b => b.classList.remove('active'));
      e.currentTarget.classList.add('active');
    });
  });

  // Save and reset buttons
  document.getElementById('saveSettings')?.addEventListener('click', saveSettings);
  document.getElementById('resetSettings')?.addEventListener('click', resetSettings);

  // Range sliders
  document.getElementById('minConfSlider')?.addEventListener('input', (e) => {
    document.getElementById('minConfValue').textContent = e.target.value + '%';
  });
  document.getElementById('sensitivitySlider')?.addEventListener('input', (e) => {
    document.getElementById('sensitivityValue').textContent = e.target.value + '%';
  });

  // Camera detection
  document.getElementById('detectCameras')?.addEventListener('click', detectCameras);

  // Data management buttons
  document.getElementById('exportAllDataBtn')?.addEventListener('click', exportAllData);
  document.getElementById('clearAllDataBtn')?.addEventListener('click', clearAllData);

  // Theme live preview
  document.getElementById('theme')?.addEventListener('change', () => {
    // Live preview theme change
    const theme = document.getElementById('theme').value;
    document.documentElement.setAttribute('data-theme',
      theme === 'auto'
        ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
        : theme
    );
  });

  // Accent color live preview
  document.getElementById('accentColor')?.addEventListener('input', (e) => {
    document.documentElement.style.setProperty('--accent', e.target.value);
  });
}

function showSection(sectionId) {
  currentSection = sectionId;
  document.querySelectorAll('.settings-section').forEach(section => {
    section.classList.remove('active');
  });
  const section = document.getElementById(sectionId);
  if (section) section.classList.add('active');
}


// ═════════════════════════════════════════════════════════════════════════════
// LOAD SETTINGS
// ═════════════════════════════════════════════════════════════════════════════

function loadSettings() {
  setVal('theme', settings.get('theme'));
  setVal('accentColor', settings.get('accentColor'), 'value');
  setVal('language', settings.get('language'));
  setVal('dateFormat', settings.get('dateFormat'));
  setChecked('notifyComplete', settings.get('notifyComplete'));
  setChecked('notifyLowConfidence', settings.get('notifyLowConfidence'));

  setVal('defaultDetectionRate', settings.get('defaultDetectionRate'));

  const minConf = settings.get('minConfidence');
  setVal('minConfSlider', minConf, 'value');
  const minConfLabel = document.getElementById('minConfValue');
  if (minConfLabel) minConfLabel.textContent = minConf + '%';

  const sensitivity = settings.get('sensitivity');
  setVal('sensitivitySlider', sensitivity, 'value');
  const sensLabel = document.getElementById('sensitivityValue');
  if (sensLabel) sensLabel.textContent = sensitivity + '%';

  setChecked('autoSave', settings.get('autoSave'));
  setChecked('gpuAccel', settings.get('gpuAccel'));

  setVal('cameraDevice', settings.get('cameraDevice'));
  setVal('resolution', settings.get('resolution'));
  setVal('fps', settings.get('fps'));
  setChecked('faceOverlay', settings.get('faceOverlay'));
  setChecked('mirrorVideo', settings.get('mirrorVideo'));

  setVal('exportFormat', settings.get('exportFormat'));
  setChecked('includeTimestamp', settings.get('includeTimestamp'));

  setChecked('autoClearHistory', settings.get('autoClearHistory'));
  setVal('historyRetention', settings.get('historyRetention'));
}

function setVal(id, val, prop = 'value') {
  const el = document.getElementById(id);
  if (el && val !== undefined) el[prop] = val;
}

function setChecked(id, val) {
  const el = document.getElementById(id);
  if (el) el.checked = !!val;
}


// ═════════════════════════════════════════════════════════════════════════════
// SAVE SETTINGS
// ═════════════════════════════════════════════════════════════════════════════

function saveSettings() {
  try {
    settings.set('theme', getVal('theme'));
    settings.set('accentColor', document.getElementById('accentColor')?.value || '#6ee7b7');
    settings.set('language', getVal('language'));
    settings.set('dateFormat', getVal('dateFormat'));
    settings.set('notifyComplete', getChecked('notifyComplete'));
    settings.set('notifyLowConfidence', getChecked('notifyLowConfidence'));

    settings.set('defaultDetectionRate', getVal('defaultDetectionRate'));
    settings.set('minConfidence', parseInt(getVal('minConfSlider')) || 50);
    settings.set('sensitivity', parseInt(getVal('sensitivitySlider')) || 70);
    settings.set('autoSave', getChecked('autoSave'));
    settings.set('gpuAccel', getChecked('gpuAccel'));

    settings.set('cameraDevice', getVal('cameraDevice'));
    settings.set('resolution', getVal('resolution'));
    settings.set('fps', getVal('fps'));
    settings.set('faceOverlay', getChecked('faceOverlay'));
    settings.set('mirrorVideo', getChecked('mirrorVideo'));

    settings.set('exportFormat', getVal('exportFormat'));
    settings.set('includeTimestamp', getChecked('includeTimestamp'));

    settings.set('autoClearHistory', getChecked('autoClearHistory'));
    settings.set('historyRetention', getVal('historyRetention'));

    settings.save();
    applyGlobalTheme();
    showToast('Settings saved successfully!');
  } catch (error) {
    console.error('Error saving settings:', error);
    showToast('Error saving settings', 'error');
  }
}

function getVal(id) {
  return document.getElementById(id)?.value || '';
}

function getChecked(id) {
  return document.getElementById(id)?.checked || false;
}

function resetSettings() {
  if (!confirm('Reset all settings to defaults?')) return;
  settings.reset();
  loadSettings();
  applyGlobalTheme();
  showToast('Settings reset to defaults');
}


// ═════════════════════════════════════════════════════════════════════════════
// CAMERA DETECTION
// ═════════════════════════════════════════════════════════════════════════════

async function detectCameras() {
  try {
    // Request permissions first
    await navigator.mediaDevices.getUserMedia({ video: true }).then(s => s.getTracks().forEach(t => t.stop()));
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameras = devices.filter(d => d.kind === 'videoinput');

    const select = document.getElementById('cameraDevice');
    if (!select) return;

    select.innerHTML = '<option value="default">Default Camera</option>';
    cameras.forEach((camera, i) => {
      const option = document.createElement('option');
      option.value = camera.deviceId;
      option.textContent = camera.label || `Camera ${i + 1}`;
      select.appendChild(option);
    });

    // Restore saved selection
    const saved = settings.get('cameraDevice');
    if (saved && select.querySelector(`option[value="${saved}"]`)) {
      select.value = saved;
    }

    showToast(cameras.length === 0 ? 'No cameras detected' : `Found ${cameras.length} camera(s)`);
  } catch (error) {
    console.error('Error detecting cameras:', error);
    showToast('Camera permission denied', 'error');
  }
}


// ═════════════════════════════════════════════════════════════════════════════
// SYSTEM INFORMATION
// ═════════════════════════════════════════════════════════════════════════════

function detectSystemInfo() {
  const browserInfo = document.getElementById('browserInfo');
  if (browserInfo) {
    const ua = navigator.userAgent;
    let browser = 'Unknown';
    if (ua.indexOf('Chrome') > -1 && ua.indexOf('Edg') === -1) browser = 'Chrome';
    else if (ua.indexOf('Edg') > -1) browser = 'Edge';
    else if (ua.indexOf('Safari') > -1 && ua.indexOf('Chrome') === -1) browser = 'Safari';
    else if (ua.indexOf('Firefox') > -1) browser = 'Firefox';
    browserInfo.textContent = browser;
  }

  const platformInfo = document.getElementById('platformInfo');
  if (platformInfo) {
    platformInfo.textContent = navigator.platform || navigator.userAgentData?.platform || 'Unknown';
  }

  const webrtcSupport = document.getElementById('webrtcSupport');
  if (webrtcSupport) {
    const hasWebRTC = !!(window.RTCPeerConnection && navigator.mediaDevices?.getUserMedia);
    webrtcSupport.innerHTML = hasWebRTC
      ? '<span style="color: var(--success);"><i class="fas fa-check-circle"></i> Supported</span>'
      : '<span style="color: var(--danger);"><i class="fas fa-times-circle"></i> Not Supported</span>';
  }

  const webglSupport = document.getElementById('webglSupport');
  if (webglSupport) {
    const canvas = document.createElement('canvas');
    const hasWebGL = !!(canvas.getContext('webgl2') || canvas.getContext('webgl'));
    webglSupport.innerHTML = hasWebGL
      ? '<span style="color: var(--success);"><i class="fas fa-check-circle"></i> Supported</span>'
      : '<span style="color: var(--danger);"><i class="fas fa-times-circle"></i> Not Supported</span>';
  }
}


// ═════════════════════════════════════════════════════════════════════════════
// DATA MANAGEMENT
// ═════════════════════════════════════════════════════════════════════════════

async function updateStorageInfo() {
  try {
    const est = await EmotiDB.getStorageEstimate();
    const usageMB = (est.usage / (1024 * 1024)).toFixed(1);
    const quotaMB = Math.min(est.quota / (1024 * 1024), 50).toFixed(0);

    const fill = document.querySelector('.storage-fill');
    const label = document.querySelector('.storage-info span');
    if (fill) {
      const pct = Math.min((est.usage / Math.max(est.quota, 1)) * 100, 100);
      fill.style.width = `${pct}%`;
      fill.style.background = pct > 80 ? 'var(--danger)' : pct > 50 ? 'var(--warning)' : 'var(--primary)';
    }
    if (label) label.textContent = `${usageMB} MB / ${quotaMB} MB`;
  } catch { /* ignore */ }
}

async function clearAllData() {
  if (!confirm('Clear ALL application data?\n\nThis will delete:\n• All session history\n• All upload results\n• All saved preferences\n\nThis cannot be undone.')) return;

  try {
    await EmotiDB.clearAll();
    storage.clear();
    settings.reset();
    showToast('All data cleared');
    setTimeout(() => window.location.reload(), 1000);
  } catch (err) {
    console.error('Clear failed:', err);
    showToast('Error clearing data', 'error');
  }
}

async function exportAllData() {
  try {
    const [sessions, results, uploads] = await Promise.all([
      EmotiDB.getSessions(1000),
      EmotiDB.getAllResults(),
      EmotiDB.getUploads(1000),
    ]);

    const allData = {
      exported_at: new Date().toISOString(),
      version: '1.0.0',
      settings: settings.settings,
      sessions: sessions,
      analysis_results: results,
      uploads: uploads,
      stats: {
        total_sessions: sessions.length,
        total_results: results.length,
        total_uploads: uploads.length,
      },
    };

    exportToJSON(allData, `expression_analyser_backup_${Date.now()}.json`);
    showToast('All data exported ✓');
  } catch (err) {
    console.error('Export failed:', err);
    showToast('Export failed', 'error');
  }
}
