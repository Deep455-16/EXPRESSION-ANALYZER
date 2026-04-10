/**
 * upload.js — File upload & batch analysis
 * Uses FaceEngine for client-side emotion detection (face-api.js).
 * Falls back to backend /api/upload when available.
 */

const BACKEND = localStorage.getItem('backendUrl') || 'http://localhost:5000';
const EMOTION_CFG = {
  happy:     { icon: '😊', color: '#4ade80', label: 'Happy' },
  sad:       { icon: '😢', color: '#60a5fa', label: 'Sad' },
  angry:     { icon: '😠', color: '#f87171', label: 'Angry' },
  surprised: { icon: '😲', color: '#34d399', label: 'Surprised' },
  fearful:   { icon: '😨', color: '#a78bfa', label: 'Fearful' },
  disgusted: { icon: '🤢', color: '#fb923c', label: 'Disgusted' },
  neutral:   { icon: '😐', color: '#94a3b8', label: 'Neutral' },
};

let queue = [];
let results = [];
let totalStart = null;
let processed = 0;
let timeTimer = null;
let backendAvailable = false;

// ── DOM ───────────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const uploadArea  = $('uploadArea');
const fileInput   = $('fileInput');
const fileQueue   = $('fileQueue');
const queueList   = $('queueList');
const previewCont = $('previewContainer');
const previewInfo = $('previewInfo');
const resultCont  = $('resultContainer');

// ── Backend Health Check ──────────────────────────────────────────────────────
async function checkBackendHealth() {
  try {
    backendAvailable = await FaceEngine.setBackend(BACKEND);
    console.log('[upload.js] Backend:', backendAvailable ? 'online' : 'offline');
    return backendAvailable;
  } catch {
    backendAvailable = false;
    return false;
  }
}

// ── Drag & drop ───────────────────────────────────────────────────────────────
uploadArea?.addEventListener('dragover', e => { e.preventDefault(); uploadArea.classList.add('drag-over'); });
uploadArea?.addEventListener('dragleave', () => uploadArea.classList.remove('drag-over'));
uploadArea?.addEventListener('drop', e => {
  e.preventDefault();
  uploadArea.classList.remove('drag-over');
  addFiles([...e.dataTransfer.files]);
});
uploadArea?.addEventListener('click', () => fileInput?.click());
$('browseBtn')?.addEventListener('click', e => { e.stopPropagation(); fileInput?.click(); });
fileInput?.addEventListener('change', () => {
  addFiles([...fileInput.files]);
  fileInput.value = '';
});

// ── Queue management ──────────────────────────────────────────────────────────
function addFiles(files) {
  const allowed = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'mp4', 'webm', 'mov', 'avi'];
  files.forEach(f => {
    const ext = f.name.split('.').pop().toLowerCase();
    if (!allowed.includes(ext)) {
      showToast(`${f.name}: unsupported type`, 'error');
      return;
    }
    queue.push({ file: f, id: Date.now() + Math.random(), status: 'pending', result: null });
  });
  renderQueue();
  if ($('autoProcess')?.checked && queue.some(q => q.status === 'pending')) {
    processAll();
  }
}

function renderQueue() {
  if (!queue.length) { if (fileQueue) fileQueue.style.display = 'none'; return; }
  if (fileQueue) fileQueue.style.display = 'block';
  $('totalFiles').textContent = queue.length;

  queueList.innerHTML = queue.map(item => `
    <div class="queue-item" data-id="${item.id}">
      <div class="queue-icon">
        <i class="fas fa-${item.file.type.startsWith('video') ? 'film' : 'image'}"></i>
      </div>
      <div class="queue-info">
        <div class="queue-name">${item.file.name}</div>
        <div class="queue-size">${formatBytes(item.file.size)}</div>
      </div>
      <div class="queue-status ${item.status}">
        ${item.status === 'pending' ? '<i class="fas fa-clock"></i> Pending' :
          item.status === 'processing' ? '<i class="fas fa-spinner fa-spin"></i> Processing' :
          item.status === 'done' ? `<span style="color:#4ade80"><i class="fas fa-check"></i> ${item.result?.dominant_emotion || item.result?.face_emotions?.[0]?.emotion || 'Done'}</span>` :
          `<span style="color:#f87171"><i class="fas fa-times"></i> ${item.result?.error || 'Error'}</span>`}
      </div>
      <button class="btn btn-sm btn-danger" onclick="removeItem('${item.id}')">
        <i class="fas fa-times"></i>
      </button>
    </div>`).join('');

  const first = queue.find(q => q.status === 'done') || queue[0];
  if (first) showPreview(first.file);
}

function removeItem(id) {
  queue = queue.filter(q => String(q.id) !== String(id));
  renderQueue();
}

$('clearQueue')?.addEventListener('click', () => { queue = []; results = []; renderQueue(); });

// ── Preview ───────────────────────────────────────────────────────────────────
function showPreview(file) {
  if (!previewCont) return;
  const url = URL.createObjectURL(file);
  previewCont.innerHTML = file.type.startsWith('video')
    ? `<video src="${url}" controls style="max-width:100%;border-radius:8px;max-height:250px;"></video>`
    : `<img src="${url}" style="max-width:100%;border-radius:8px;max-height:250px;object-fit:contain;">`;
  if (previewInfo) {
    previewInfo.style.display = 'block';
    $('fileName').textContent = file.name;
    $('fileSize').textContent = formatBytes(file.size);
    $('fileType').textContent = file.type || 'Unknown';
  }
}

// ── Process single file ───────────────────────────────────────────────────────
async function processFile(item) {
  try {
    let data;

    if (backendAvailable) {
      // Try backend first
      try {
        const fd = new FormData();
        fd.append('file', item.file);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);
        const res = await fetch(`${BACKEND}/api/upload`, {
          method: 'POST', body: fd, mode: 'cors', signal: controller.signal,
        });
        clearTimeout(timeout);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        data = await res.json();
        data.source = 'backend';
      } catch (err) {
        console.warn('[upload.js] Backend upload failed, using client-side:', err.message);
        data = await FaceEngine.analyzeFile(item.file);
        data.source = 'client';
      }
    } else {
      // Client-side analysis via face-api.js
      data = await FaceEngine.analyzeFile(item.file);
      data.source = 'client';
    }

    if (data.error && !data.dominant_emotion && !data.face_emotions?.length) {
      item.result = data;
      item.status = 'error';
      return;
    }

    item.result = data;
    item.status = 'done';

    // Normalize result for display
    const dominant = data.dominant_emotion || data.face_emotions?.[0]?.emotion || 'neutral';
    const conf = data.confidence || data.face_emotions?.[0]?.confidence || 0;
    const scores = data.scores || data.face_emotions?.[0]?.scores || {};

    results.push({
      filename: item.file.name,
      dominant_emotion: dominant,
      confidence: conf,
      scores: scores,
      source: data.source,
      timestamp: Date.now() / 1000,
      frames_sampled: data.frames_sampled,
    });

    // Save to IndexedDB
    EmotiDB.addUpload({
      filename:  item.file.name,
      fileSize:  item.file.size,
      fileType:  item.file.type,
      dominant_emotion: dominant,
      confidence: conf,
      scores:    scores,
      source:    data.source,
      timestamp: new Date().toISOString(),
      frames_sampled: data.frames_sampled,
    });

  } catch (error) {
    console.error('[upload.js] Process error:', error);
    item.status = 'error';
    item.result = { error: error.message };
  }
}

// ── Process all ───────────────────────────────────────────────────────────────
async function processAll() {
  const pending = queue.filter(q => q.status === 'pending');
  if (!pending.length) {
    showToast('No pending files', 'warn');
    return;
  }

  // Init face engine
  await FaceEngine.init();

  totalStart = Date.now();
  processed = 0;
  startTimeTimer();

  for (const item of pending) {
    item.status = 'processing';
    renderQueue();

    await processFile(item);

    processed++;
    $('processedFiles').textContent = processed;
    renderQueue();

    if (item.result && item.status === 'done') {
      showResult(item.result);
      // Show annotated preview if available
      if (item.result.annotated_preview) {
        showAnnotatedPreview(item.result.annotated_preview);
      }
    }

    await new Promise(r => setTimeout(r, 150));
  }

  clearInterval(timeTimer);
  const dom = topEmotion();
  if (dom) $('avgEmotion').textContent = EMOTION_CFG[dom]?.label || dom;
  showToast(`Processed ${processed} file${processed !== 1 ? 's' : ''} ✓`);
}

$('processAll')?.addEventListener('click', processAll);

// ── Result display ────────────────────────────────────────────────────────────
function showResult(data) {
  if (!resultCont) return;
  const faces = data.face_emotions || [];
  const primary = faces[0];
  const dom = data.dominant_emotion || primary?.emotion || 'neutral';
  const cfg = EMOTION_CFG[dom] || { icon: '❓', color: '#94a3b8', label: dom };
  const conf = data.confidence ?? primary?.confidence ?? 0;
  const scores = data.scores || primary?.scores || {};
  const source = data.source || 'unknown';

  resultCont.innerHTML = `
    <div style="width:100%;">
      <div style="text-align:center;padding:16px 0">
        <div style="font-size:3rem;margin-bottom:8px">${cfg.icon}</div>
        <div style="font-size:1.3rem;font-weight:800;color:${cfg.color};text-transform:uppercase;letter-spacing:0.05em">${cfg.label || dom}</div>
        <div style="color:var(--text-secondary);font-size:.9rem;font-weight:600;margin-top:4px">${Math.round(conf * 100)}% confidence</div>
        ${data.frames_sampled ? `<div style="color:var(--text-secondary);font-size:.8rem;margin-top:4px"><i class="fas fa-film" style="margin-right:4px"></i>${data.frames_sampled} frames analyzed</div>` : ''}
        <div style="display:inline-block;margin-top:8px;padding:2px 10px;border-radius:20px;font-size:11px;font-weight:600;background:${source === 'backend' ? 'rgba(16,185,129,0.15);color:#10b981' : source === 'client' ? 'rgba(96,165,250,0.15);color:#60a5fa' : 'rgba(148,163,184,0.15);color:#94a3b8'}">
          <i class="fas fa-${source === 'backend' ? 'server' : source === 'client' ? 'brain' : 'dice'}"></i> ${source === 'backend' ? 'Backend' : source === 'client' ? 'Client AI' : 'Demo'}
        </div>
      </div>
      <div class="emotion-bars" style="padding:0 8px">
        ${Object.entries(scores).sort((a, b) => b[1] - a[1]).map(([em, v]) => {
    const c = EMOTION_CFG[em]?.color || '#94a3b8';
    const lbl = EMOTION_CFG[em]?.label || em;
    return `<div class="emotion-bar-row">
              <span class="emotion-bar-label" style="font-size:.8rem">${lbl}</span>
              <div class="emotion-bar-track"><div class="emotion-bar-fill" style="width:${Math.round(v * 100)}%;background:${c}"></div></div>
              <span class="emotion-bar-pct">${Math.round(v * 100)}%</span>
            </div>`;
  }).join('')}
      </div>
    </div>`;
}

function showAnnotatedPreview(dataUrl) {
  if (!previewCont || !dataUrl) return;
  previewCont.innerHTML = `<img src="${dataUrl}" style="max-width:100%;border-radius:8px;max-height:250px;object-fit:contain;">`;
}

function topEmotion() {
  const counts = {};
  results.forEach(r => {
    const e = r.dominant_emotion;
    if (e) counts[e] = (counts[e] || 0) + 1;
  });
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

// ── Export ────────────────────────────────────────────────────────────────────
$('exportResults')?.addEventListener('click', () => {
  if (!results.length) { showToast('No results yet', 'warn'); return; }

  const fmt = settings.get('exportFormat') || 'json';
  if (fmt === 'csv') {
    const headers = ['filename', 'emotion', 'confidence', 'source', 'timestamp', 'frames_sampled'];
    const rows = results.map(r => [
      r.filename, r.dominant_emotion, Math.round((r.confidence || 0) * 100) + '%',
      r.source || '', new Date(r.timestamp * 1000).toISOString(), r.frames_sampled || 1,
    ]);
    exportToCSV(headers, rows, `emotiscan_upload_${Date.now()}.csv`);
  } else {
    exportToJSON({
      exported_at: new Date().toISOString(),
      total_files: results.length,
      results: results,
    }, `emotiscan_upload_${Date.now()}.json`);
  }
  showToast('Results exported ✓');
});

// ── Utilities ─────────────────────────────────────────────────────────────────
function startTimeTimer() {
  clearInterval(timeTimer);
  timeTimer = setInterval(() => {
    if (!totalStart) return;
    $('processingTime').textContent = `${((Date.now() - totalStart) / 1000).toFixed(1)}s`;
  }, 200);
}

function formatBytes(b) {
  return b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`;
}

// ── Min confidence slider ────────────────────────────────────────────────────
$('minConfidence')?.addEventListener('input', e => {
  const label = $('minConfidenceValue');
  if (label) label.textContent = `${e.target.value}%`;
});

// ── Auto-init ─────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  console.log('[upload.js] Initialized. Backend:', BACKEND);
  // Pre-init face engine
  FaceEngine.init();
  checkBackendHealth();
});
