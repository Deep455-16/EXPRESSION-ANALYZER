// ========================================
// Upload & Batch Analysis - JavaScript
// ========================================

let uploadedFiles = [];
let processedResults = [];
let currentFileIndex = 0;
let batchChart = null;

// ========================================
// Initialize Page
// ========================================

document.addEventListener('DOMContentLoaded', () => {
  initializeUploadPage();
  setupUploadListeners();
  initializeBatchChart();
});

function initializeUploadPage() {
  loadSettings();
  updateStats();
}

function setupUploadListeners() {
  const uploadArea = document.getElementById('uploadArea');
  const fileInput = document.getElementById('fileInput');
  const browseBtn = document.getElementById('browseBtn');
  
  // Browse button
  browseBtn?.addEventListener('click', () => {
    fileInput.click();
  });
  
  // Upload area click
  uploadArea?.addEventListener('click', () => {
    fileInput.click();
  });
  
  // File input change
  fileInput?.addEventListener('change', (e) => {
    handleFiles(e.target.files);
  });
  
  // Drag and drop
  uploadArea?.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadArea.classList.add('drag-over');
  });
  
  uploadArea?.addEventListener('dragleave', () => {
    uploadArea.classList.remove('drag-over');
  });
  
  uploadArea?.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadArea.classList.remove('drag-over');
    handleFiles(e.dataTransfer.files);
  });
  
  // Action buttons
  document.getElementById('clearQueue')?.addEventListener('click', clearQueue);
  document.getElementById('processAll')?.addEventListener('click', processAllFiles);
  document.getElementById('exportResults')?.addEventListener('click', exportBatchResults);
  
  // Settings
  document.getElementById('minConfidence')?.addEventListener('input', (e) => {
    document.getElementById('minConfidenceValue').textContent = e.target.value + '%';
  });
}

function loadSettings() {
  const minConf = settings.get('minConfidence') || 30;
  
  if (document.getElementById('minConfidence')) {
    document.getElementById('minConfidence').value = minConf;
    document.getElementById('minConfidenceValue').textContent = minConf + '%';
  }
}

// ========================================
// File Handling
// ========================================

function handleFiles(files) {
  const fileArray = Array.from(files);
  
  // Filter valid files
  const validFiles = fileArray.filter(file => {
    const isImage = file.type.startsWith('image/');
    const isVideo = file.type.startsWith('video/');
    const isValidSize = file.size <= 50 * 1024 * 1024; // 50MB
    
    if (!isImage && !isVideo) {
      alert(`${file.name} is not a valid image or video file`);
      return false;
    }
    
    if (!isValidSize) {
      alert(`${file.name} exceeds 50MB size limit`);
      return false;
    }
    
    return true;
  });
  
  if (validFiles.length === 0) return;
  
  // Add to queue
  validFiles.forEach(file => {
    uploadedFiles.push({
      file,
      id: 'file_' + Date.now() + '_' + Math.random(),
      status: 'pending',
      result: null
    });
  });
  
  updateFileQueue();
  updateStats();
  
  // Auto-process if enabled
  if (document.getElementById('autoProcess')?.checked) {
    processAllFiles();
  }
}

function updateFileQueue() {
  const queueContainer = document.getElementById('fileQueue');
  const queueList = document.getElementById('queueList');
  
  if (!queueContainer || !queueList) return;
  
  if (uploadedFiles.length === 0) {
    queueContainer.style.display = 'none';
    return;
  }
  
  queueContainer.style.display = 'block';
  
  queueList.innerHTML = uploadedFiles.map((item, index) => {
    const statusIcon = getStatusIcon(item.status);
    const statusColor = getStatusColor(item.status);
    
    return `
      <div class="queue-item" data-index="${index}">
        <div style="flex: 1;">
          <div style="font-weight: 600;">${item.file.name}</div>
          <div style="font-size: 0.75rem; color: var(--text-secondary);">
            ${formatFileSize(item.file.size)} • ${item.file.type.split('/')[0]}
          </div>
        </div>
        <div style="display: flex; align-items: center; gap: 1rem;">
          <span style="color: ${statusColor};">
            <i class="fas ${statusIcon}"></i> ${item.status}
          </span>
          ${item.status === 'pending' ? `
            <button class="btn btn-sm btn-primary" onclick="processFile(${index})">
              <i class="fas fa-play"></i>
            </button>
          ` : ''}
          ${item.status === 'completed' ? `
            <button class="btn btn-sm btn-secondary" onclick="viewResult(${index})">
              <i class="fas fa-eye"></i>
            </button>
          ` : ''}
          <button class="btn btn-sm btn-danger" onclick="removeFile(${index})">
            <i class="fas fa-times"></i>
          </button>
        </div>
      </div>
    `;
  }).join('');
}

function getStatusIcon(status) {
  const icons = {
    pending: 'fa-clock',
    processing: 'fa-spinner fa-spin',
    completed: 'fa-check-circle',
    error: 'fa-exclamation-circle'
  };
  return icons[status] || 'fa-circle';
}

function getStatusColor(status) {
  const colors = {
    pending: 'var(--text-secondary)',
    processing: 'var(--info)',
    completed: 'var(--success)',
    error: 'var(--danger)'
  };
  return colors[status] || 'var(--text-secondary)';
}

// ========================================
// File Processing
// ========================================

async function processAllFiles() {
  const pendingFiles = uploadedFiles.filter(f => f.status === 'pending');
  
  if (pendingFiles.length === 0) {
    alert('No files to process');
    return;
  }
  
  showProcessingModal();
  
  for (let i = 0; i < uploadedFiles.length; i++) {
    if (uploadedFiles[i].status === 'pending') {
      await processFile(i);
    }
  }
  
  closeModal('processingModal');
  updateStats();
  
  if (document.getElementById('saveResults')?.checked) {
    saveBatchResults();
  }
}

async function processFile(index) {
  const item = uploadedFiles[index];
  if (!item || item.status !== 'pending') return;
  
  try {
    item.status = 'processing';
    updateFileQueue();
    updateProcessingStatus(`Processing ${item.file.name}...`);
    
    // Load file
    const fileData = await loadFile(item.file);
    
    // Analyze based on type
    let result;
    if (item.file.type.startsWith('image/')) {
      result = await analyzeImage(fileData);
    } else if (item.file.type.startsWith('video/')) {
      result = await analyzeVideo(fileData);
    }
    
    item.result = result;
    item.status = 'completed';
    processedResults.push({
      filename: item.file.name,
      type: item.file.type,
      size: item.file.size,
      ...result
    });
    
    // Show preview
    showPreview(item.file, fileData);
    showResult(result);
    
  } catch (error) {
    console.error('Processing error:', error);
    item.status = 'error';
  }
  
  updateFileQueue();
  updateStats();
  updateProgress();
}

function loadFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result);
    reader.onerror = reject;
    
    if (file.type.startsWith('image/')) {
      reader.readAsDataURL(file);
    } else {
      reader.readAsArrayBuffer(file);
    }
  });
}

async function analyzeImage(imageData) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = async () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      
      const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const result = await analyzeExpression(imgData);
      
      resolve({
        ...result,
        frames: 1,
        width: img.width,
        height: img.height
      });
    };
    img.src = imageData;
  });
}

async function analyzeVideo(videoData) {
  // Mock video analysis (in real app, extract frames and analyze)
  const samplingRate = parseInt(document.getElementById('videoSampling')?.value || '10');
  const frameCount = Math.floor(Math.random() * 100) + 10; // Mock frame count
  const sampled = Math.floor(frameCount / samplingRate);
  
  // Simulate analyzing multiple frames
  const results = [];
  for (let i = 0; i < Math.min(sampled, 5); i++) {
    const mockData = new ImageData(1, 1);
    const result = await analyzeExpression(mockData);
    results.push(result);
  }
  
  // Average results
  const avgEmotions = {};
  EMOTIONS.forEach(emotion => {
    avgEmotions[emotion] = Math.round(
      results.reduce((sum, r) => sum + r.emotions[emotion], 0) / results.length
    );
  });
  
  const dominant = EMOTIONS[Object.values(avgEmotions).indexOf(Math.max(...Object.values(avgEmotions)))];
  
  return {
    emotions: avgEmotions,
    dominant,
    confidence: Math.max(...Object.values(avgEmotions)),
    frames: frameCount,
    sampledFrames: sampled,
    timestamp: new Date().toISOString()
  };
}

// ========================================
// Preview & Results
// ========================================

function showPreview(file, data) {
  const previewContainer = document.getElementById('previewContainer');
  const previewInfo = document.getElementById('previewInfo');
  
  if (!previewContainer || !previewInfo) return;
  
  // Show preview based on type
  if (file.type.startsWith('image/')) {
    previewContainer.innerHTML = `<img src="${data}" style="width: 100%; height: 100%; object-fit: contain;">`;
  } else {
    previewContainer.innerHTML = `
      <div class="preview-empty">
        <i class="fas fa-file-video"></i>
        <p>Video Preview</p>
      </div>
    `;
  }
  
  // Update info
  previewInfo.style.display = 'block';
  document.getElementById('fileName').textContent = file.name;
  document.getElementById('fileSize').textContent = formatFileSize(file.size);
  document.getElementById('fileType').textContent = file.type;
}

function showResult(result) {
  const resultContainer = document.getElementById('resultContainer');
  if (!resultContainer) return;
  
  resultContainer.innerHTML = `
    <div style="width: 100%;">
      <div style="text-align: center; margin-bottom: 1rem;">
        <div style="font-size: 3rem;">
          <i class="fas ${EMOTION_ICONS[result.dominant]}"></i>
        </div>
        <div style="font-size: 1.5rem; font-weight: 700; text-transform: capitalize; margin-top: 0.5rem;">
          ${result.dominant}
        </div>
        <div style="font-size: 1.25rem; color: var(--accent-primary);">
          ${result.confidence}%
        </div>
      </div>
      <div style="display: flex; flex-direction: column; gap: 0.5rem;">
        ${Object.entries(result.emotions)
          .sort((a, b) => b[1] - a[1])
          .map(([emotion, value]) => `
            <div style="display: flex; justify-content: space-between; padding: 0.5rem; background: rgba(255,255,255,0.02); border-radius: 6px;">
              <span style="text-transform: capitalize;">${emotion}</span>
              <span style="color: var(--accent-primary); font-weight: 700;">${value}%</span>
            </div>
          `).join('')}
      </div>
      ${result.frames ? `
        <div style="margin-top: 1rem; padding: 0.5rem; background: rgba(110,231,183,0.05); border-radius: 6px; font-size: 0.875rem; text-align: center;">
          Analyzed ${result.sampledFrames || result.frames} frame${(result.sampledFrames || result.frames) > 1 ? 's' : ''}
        </div>
      ` : ''}
    </div>
  `;
}

window.viewResult = function(index) {
  const item = uploadedFiles[index];
  if (!item || !item.result) return;
  
  showResult(item.result);
  
  // Try to show preview
  loadFile(item.file).then(data => {
    showPreview(item.file, data);
  });
};

// ========================================
// File Management
// ========================================

window.removeFile = function(index) {
  uploadedFiles.splice(index, 1);
  updateFileQueue();
  updateStats();
};

function clearQueue() {
  if (uploadedFiles.length === 0) return;
  
  if (confirm('Clear all files from queue?')) {
    uploadedFiles = [];
    processedResults = [];
    updateFileQueue();
    updateStats();
    
    // Clear preview
    const previewContainer = document.getElementById('previewContainer');
    const previewInfo = document.getElementById('previewInfo');
    const resultContainer = document.getElementById('resultContainer');
    
    if (previewContainer) {
      previewContainer.innerHTML = `
        <div class="preview-empty">
          <i class="fas fa-file-image"></i>
          <p>No file selected</p>
        </div>
      `;
    }
    
    if (previewInfo) {
      previewInfo.style.display = 'none';
    }
    
    if (resultContainer) {
      resultContainer.innerHTML = `
        <div class="result-empty">
          <i class="fas fa-info-circle"></i>
          <p>Process a file to see results</p>
        </div>
      `;
    }
  }
}

// ========================================
// Statistics
// ========================================

function updateStats() {
  const totalFiles = uploadedFiles.length;
  const processedFiles = uploadedFiles.filter(f => f.status === 'completed').length;
  
  document.getElementById('totalFiles').textContent = totalFiles;
  document.getElementById('processedFiles').textContent = processedFiles;
  
  // Calculate average emotion
  if (processedResults.length > 0) {
    const emotionCounts = {};
    processedResults.forEach(r => {
      emotionCounts[r.dominant] = (emotionCounts[r.dominant] || 0) + 1;
    });
    
    const avgEmotion = Object.keys(emotionCounts).reduce((a, b) => 
      emotionCounts[a] > emotionCounts[b] ? a : b
    );
    
    document.getElementById('avgEmotion').textContent = 
      avgEmotion.charAt(0).toUpperCase() + avgEmotion.slice(1);
  } else {
    document.getElementById('avgEmotion').textContent = '—';
  }
  
  // Update batch chart
  updateBatchChart();
}

// ========================================
// Charts
// ========================================

function initializeBatchChart() {
  const ctx = document.getElementById('batchChart');
  if (!ctx) return;
  
  batchChart = new Chart(ctx.getContext('2d'), {
    type: 'doughnut',
    data: {
      labels: EMOTIONS.map(e => e.charAt(0).toUpperCase() + e.slice(1)),
      datasets: [{
        data: EMOTIONS.map(() => 0),
        backgroundColor: [
          'rgba(16, 185, 129, 0.8)',
          'rgba(59, 130, 246, 0.8)',
          'rgba(239, 68, 68, 0.8)',
          'rgba(245, 158, 11, 0.8)',
          'rgba(139, 92, 246, 0.8)',
          'rgba(236, 72, 153, 0.8)',
          'rgba(107, 114, 128, 0.8)'
        ]
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            color: '#9ca7ba'
          }
        }
      }
    }
  });
}

function updateBatchChart() {
  if (!batchChart || processedResults.length === 0) return;
  
  const emotionCounts = {};
  EMOTIONS.forEach(e => emotionCounts[e] = 0);
  
  processedResults.forEach(r => {
    emotionCounts[r.dominant]++;
  });
  
  batchChart.data.datasets[0].data = EMOTIONS.map(e => emotionCounts[e]);
  batchChart.update();
}

// ========================================
// Processing Modal
// ========================================

function showProcessingModal() {
  openModal('processingModal');
  updateProgress();
}

function updateProgress() {
  const total = uploadedFiles.length;
  const processed = uploadedFiles.filter(f => f.status !== 'pending').length;
  const percent = total > 0 ? Math.round((processed / total) * 100) : 0;
  
  const progressFill = document.getElementById('progressFill');
  const progressPercent = document.getElementById('progressPercent');
  
  if (progressFill) {
    progressFill.style.width = percent + '%';
  }
  
  if (progressPercent) {
    progressPercent.textContent = percent + '%';
  }
}

function updateProcessingStatus(text) {
  const status = document.getElementById('processingStatus');
  if (status) {
    status.textContent = text;
  }
}

// ========================================
// Export
// ========================================

function exportBatchResults() {
  if (processedResults.length === 0) {
    alert('No results to export');
    return;
  }
  
  const format = settings.get('exportFormat') || 'csv';
  const timestamp = settings.get('includeTimestamp') ? '_' + Date.now() : '';
  
  if (format === 'json') {
    exportToJSON(processedResults, `batch_results${timestamp}.json`);
  } else {
    exportToCSV(processedResults, `batch_results${timestamp}.csv`);
  }
}

function saveBatchResults() {
  const batches = storage.load('batches') || [];
  
  batches.unshift({
    id: 'batch_' + Date.now(),
    timestamp: new Date().toISOString(),
    fileCount: uploadedFiles.length,
    results: processedResults
  });
  
  // Keep only last 20 batches
  if (batches.length > 20) {
    batches.length = 20;
  }
  
  storage.save('batches', batches);
}
