// ========================================
// Settings Page - JavaScript
// ========================================

let currentSection = 'general';

// ========================================
// Initialize Page
// ========================================

document.addEventListener('DOMContentLoaded', () => {
  initializeSettings();
  setupSettingsListeners();
  loadSettings();
  detectSystemInfo();
});

function initializeSettings() {
  showSection('general');
}

function setupSettingsListeners() {
  // Navigation
  document.querySelectorAll('.settings-nav-item').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const section = e.currentTarget.dataset.section;
      showSection(section);
      
      // Update active state
      document.querySelectorAll('.settings-nav-item').forEach(b => {
        b.classList.remove('active');
      });
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
}

function showSection(sectionId) {
  currentSection = sectionId;
  
  // Hide all sections
  document.querySelectorAll('.settings-section').forEach(section => {
    section.classList.remove('active');
  });
  
  // Show selected section
  const section = document.getElementById(sectionId);
  if (section) {
    section.classList.add('active');
  }
}

// ========================================
// Load Settings
// ========================================

function loadSettings() {
  // General
  document.getElementById('theme').value = settings.get('theme');
  document.getElementById('accentColor').value = settings.get('accentColor');
  document.getElementById('language').value = settings.get('language');
  document.getElementById('dateFormat').value = settings.get('dateFormat');
  document.getElementById('notifyComplete').checked = settings.get('notifyComplete');
  document.getElementById('notifyLowConfidence').checked = settings.get('notifyLowConfidence');
  
  // Analysis
  document.getElementById('defaultDetectionRate').value = settings.get('defaultDetectionRate');
  
  const minConf = settings.get('minConfidence');
  document.getElementById('minConfSlider').value = minConf;
  document.getElementById('minConfValue').textContent = minConf + '%';
  
  const sensitivity = settings.get('sensitivity');
  document.getElementById('sensitivitySlider').value = sensitivity;
  document.getElementById('sensitivityValue').textContent = sensitivity + '%';
  
  document.getElementById('autoSave').checked = settings.get('autoSave');
  document.getElementById('gpuAccel').checked = settings.get('gpuAccel');
  
  // Camera
  document.getElementById('cameraDevice').value = settings.get('cameraDevice');
  document.getElementById('resolution').value = settings.get('resolution');
  document.getElementById('fps').value = settings.get('fps');
  document.getElementById('faceOverlay').checked = settings.get('faceOverlay');
  document.getElementById('mirrorVideo').checked = settings.get('mirrorVideo');
  
  // Export
  document.getElementById('exportFormat').value = settings.get('exportFormat');
  document.getElementById('includeTimestamp').checked = settings.get('includeTimestamp');
  
  // Privacy
  document.getElementById('autoClearHistory').checked = settings.get('autoClearHistory');
  document.getElementById('historyRetention').value = settings.get('historyRetention');
}

// ========================================
// Save Settings
// ========================================

function saveSettings() {
  try {
    // General
    settings.set('theme', document.getElementById('theme').value);
    settings.set('accentColor', document.getElementById('accentColor').value);
    settings.set('language', document.getElementById('language').value);
    settings.set('dateFormat', document.getElementById('dateFormat').value);
    settings.set('notifyComplete', document.getElementById('notifyComplete').checked);
    settings.set('notifyLowConfidence', document.getElementById('notifyLowConfidence').checked);
    
    // Analysis
    settings.set('defaultDetectionRate', document.getElementById('defaultDetectionRate').value);
    settings.set('minConfidence', parseInt(document.getElementById('minConfSlider').value));
    settings.set('sensitivity', parseInt(document.getElementById('sensitivitySlider').value));
    settings.set('autoSave', document.getElementById('autoSave').checked);
    settings.set('gpuAccel', document.getElementById('gpuAccel').checked);
    
    // Camera
    settings.set('cameraDevice', document.getElementById('cameraDevice').value);
    settings.set('resolution', document.getElementById('resolution').value);
    settings.set('fps', document.getElementById('fps').value);
    settings.set('faceOverlay', document.getElementById('faceOverlay').checked);
    settings.set('mirrorVideo', document.getElementById('mirrorVideo').checked);
    
    // Export
    settings.set('exportFormat', document.getElementById('exportFormat').value);
    settings.set('includeTimestamp', document.getElementById('includeTimestamp').checked);
    
    // Privacy
    settings.set('autoClearHistory', document.getElementById('autoClearHistory').checked);
    settings.set('historyRetention', document.getElementById('historyRetention').value);
    
    // Save to storage
    settings.save();
    
    // Apply theme
    applyTheme();
    
    // Show success message
    showToast('Settings saved successfully!');
    
  } catch (error) {
    console.error('Error saving settings:', error);
    showToast('Error saving settings');
  }
}

function resetSettings() {
  if (!confirm('Reset all settings to defaults?')) return;
  
  settings.reset();
  loadSettings();
  applyTheme();
  showToast('Settings reset to defaults');
}

// ========================================
// Apply Settings
// ========================================

function applyTheme() {
  const theme = settings.get('theme');
  const accentColor = settings.get('accentColor');
  
  // Apply theme class to body
  document.body.className = theme + '-theme';
  
  // Apply accent color
  document.documentElement.style.setProperty('--accent-primary', accentColor);
  
  // Note: Full theme implementation would require additional CSS
}

// ========================================
// Camera Detection
// ========================================

async function detectCameras() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameras = devices.filter(d => d.kind === 'videoinput');
    
    const select = document.getElementById('cameraDevice');
    if (!select) return;
    
    // Clear existing options
    select.innerHTML = '<option value="default">Default Camera</option>';
    
    // Add detected cameras
    cameras.forEach((camera, i) => {
      const option = document.createElement('option');
      option.value = camera.deviceId;
      option.textContent = camera.label || `Camera ${i + 1}`;
      select.appendChild(option);
    });
    
    if (cameras.length === 0) {
      showToast('No cameras detected');
    } else {
      showToast(`Found ${cameras.length} camera(s)`);
    }
    
  } catch (error) {
    console.error('Error detecting cameras:', error);
    showToast('Error detecting cameras');
  }
}

// ========================================
// System Information
// ========================================

function detectSystemInfo() {
  // Browser info
  const browserInfo = document.getElementById('browserInfo');
  if (browserInfo) {
    const ua = navigator.userAgent;
    let browser = 'Unknown';
    
    if (ua.indexOf('Chrome') > -1) browser = 'Chrome';
    else if (ua.indexOf('Safari') > -1) browser = 'Safari';
    else if (ua.indexOf('Firefox') > -1) browser = 'Firefox';
    else if (ua.indexOf('Edge') > -1) browser = 'Edge';
    
    browserInfo.textContent = browser;
  }
  
  // Platform info
  const platformInfo = document.getElementById('platformInfo');
  if (platformInfo) {
    platformInfo.textContent = navigator.platform || 'Unknown';
  }
  
  // WebRTC support
  const webrtcSupport = document.getElementById('webrtcSupport');
  if (webrtcSupport) {
    const hasWebRTC = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    webrtcSupport.innerHTML = hasWebRTC ? 
      '<span style="color: var(--success);"><i class="fas fa-check-circle"></i> Supported</span>' :
      '<span style="color: var(--danger);"><i class="fas fa-times-circle"></i> Not Supported</span>';
  }
  
  // WebGL support
  const webglSupport = document.getElementById('webglSupport');
  if (webglSupport) {
    const canvas = document.createElement('canvas');
    const hasWebGL = !!(canvas.getContext('webgl') || canvas.getContext('experimental-webgl'));
    webglSupport.innerHTML = hasWebGL ? 
      '<span style="color: var(--success);"><i class="fas fa-check-circle"></i> Supported</span>' :
      '<span style="color: var(--danger);"><i class="fas fa-times-circle"></i> Not Supported</span>';
  }
}

// ========================================
// Data Management
// ========================================

function clearAllData() {
  if (!confirm('Clear all application data? This cannot be undone.')) return;
  
  storage.clear();
  showToast('All data cleared');
  
  // Reload page
  setTimeout(() => {
    window.location.reload();
  }, 1000);
}

function exportAllData() {
  const allData = {
    settings: settings.settings,
    sessions: storage.load('sessions') || [],
    batches: storage.load('batches') || [],
    exportedAt: new Date().toISOString()
  };
  
  exportToJSON(allData, `expression_analyser_backup_${Date.now()}.json`);
  showToast('Data exported successfully');
}

// Attach to buttons
document.addEventListener('DOMContentLoaded', () => {
  const clearDataBtn = document.querySelector('button.btn-danger');
  const exportDataBtn = document.querySelector('button.btn-secondary');
  
  if (clearDataBtn && clearDataBtn.textContent.includes('Clear All Data')) {
    clearDataBtn.addEventListener('click', clearAllData);
  }
  
  if (exportDataBtn && exportDataBtn.textContent.includes('Export All Data')) {
    exportDataBtn.addEventListener('click', exportAllData);
  }
});
