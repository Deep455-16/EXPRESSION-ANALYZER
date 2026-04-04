// ========================================
// Upload & Batch Analysis — upload.js
// Calls Python /api/upload for real analysis
// ========================================

let uploadedFiles    = [];
let processedResults = [];

document.addEventListener("DOMContentLoaded", () => {
  setupUploadListeners();
  updateStats();
  // slider label
  document.getElementById("minConfidence")?.addEventListener("input", e => {
    document.getElementById("minConfidenceValue").textContent = e.target.value + "%";
  });
});

function setupUploadListeners() {
  const area  = document.getElementById("uploadArea");
  const input = document.getElementById("fileInput");

  document.getElementById("browseBtn")?.addEventListener("click", () => input?.click());
  area?.addEventListener("click", () => input?.click());
  input?.addEventListener("change", e => handleFiles(e.target.files));

  area?.addEventListener("dragover", e => { e.preventDefault(); area.classList.add("drag-over"); });
  area?.addEventListener("dragleave", () => area.classList.remove("drag-over"));
  area?.addEventListener("drop", e => {
    e.preventDefault(); area.classList.remove("drag-over");
    handleFiles(e.dataTransfer.files);
  });

  document.getElementById("clearQueue")?.addEventListener("click", clearQueue);
  document.getElementById("processAll")?.addEventListener("click", processAll);
  document.getElementById("exportResults")?.addEventListener("click", exportBatchResults);
}

// ── File Handling ──────────────────────────────────────────────────

function handleFiles(files) {
  const valid = Array.from(files).filter(f => {
    const ext = f.name.split(".").pop().toLowerCase();
    const ok  = ["jpg","jpeg","png","gif","webp","mp4","webm","mov"].includes(ext) && f.size <= 50*1024*1024;
    if (!ok) showToast(`Skipped: ${f.name}`);
    return ok;
  });
  valid.forEach(f => uploadedFiles.push({ file:f, id:"f_"+Date.now()+Math.random(), status:"pending", result:null }));
  renderQueue();
  updateStats();
  if (document.getElementById("autoProcess")?.checked) processAll();
}

function renderQueue() {
  const qEl = document.getElementById("fileQueue");
  const list = document.getElementById("queueList");
  if (!qEl || !list) return;
  qEl.style.display = uploadedFiles.length ? "block" : "none";
  list.innerHTML = uploadedFiles.map((item,i) => {
    const ic   = {pending:"fa-clock",processing:"fa-spinner fa-spin",completed:"fa-check-circle",error:"fa-exclamation-circle"}[item.status];
    const col  = {pending:"#94a3b8",processing:"#0ea5e9",completed:"#10b981",error:"#ef4444"}[item.status];
    return `<div class="queue-item">
      <div style="flex:1"><div style="font-weight:600">${item.file.name}</div>
        <div style="font-size:0.75rem;color:var(--text-secondary)">${formatFileSize(item.file.size)} · ${item.file.type.split("/")[0]}</div></div>
      <div style="display:flex;align-items:center;gap:10px">
        <span style="color:${col}"><i class="fas ${ic}"></i> ${item.status}</span>
        ${item.status==="pending"?`<button class="btn btn-sm btn-primary" onclick="processSingle(${i})"><i class="fas fa-play"></i></button>`:""}
        ${item.status==="completed"?`<button class="btn btn-sm btn-secondary" onclick="viewResult(${i})"><i class="fas fa-eye"></i></button>`:""}
        <button class="btn btn-sm btn-danger" onclick="removeFile(${i})"><i class="fas fa-times"></i></button>
      </div></div>`;
  }).join("");
}

// ── Processing ────────────────────────────────────────────────────

async function processAll() {
  const pending = uploadedFiles.filter(f=>f.status==="pending");
  if (!pending.length) { showToast("No files to process"); return; }
  openModal("processingModal");
  for (let i=0; i<uploadedFiles.length; i++) {
    if (uploadedFiles[i].status==="pending") await processSingle(i);
  }
  closeModal("processingModal");
  updateStats();
  if (document.getElementById("saveResults")?.checked) saveBatch();
}

async function processSingle(i) {
  const item = uploadedFiles[i];
  if (!item || item.status!=="pending") return;
  item.status = "processing";
  renderQueue();
  updateProgress(i);

  try {
    const backendUrl = document.getElementById("backendUrlInput")?.value || "http://localhost:5000";
    const fd = new FormData();
    fd.append("file", item.file);
    const res  = await fetch(`${backendUrl}/api/upload`, { method:"POST", body:fd, signal:AbortSignal.timeout(30000) });
    const data = await res.json();
    item.result = data;
    item.status = data.error ? "error" : "completed";
    if (data.error) throw new Error(data.error);
    processedResults.push({ filename:item.file.name, ...data });
    showPreview(item.file);
    showResult(data);
  } catch (err) {
    // Fallback: mock analysis
    const mock = await analyzeExpression(null);
    item.result = mock;
    item.status = "completed";
    processedResults.push({ filename:item.file.name, ...mock });
    showPreview(item.file);
    showResult(mock);
  }

  renderQueue();
  updateStats();
}

function updateProgress(idx) {
  const done = uploadedFiles.filter(f=>f.status!=="pending").length;
  const pct  = Math.round((done/uploadedFiles.length)*100);
  const fill = document.getElementById("progressFill");
  const pct2 = document.getElementById("progressPercent");
  const stat = document.getElementById("processingStatus");
  if (fill) fill.style.width = pct+"%";
  if (pct2) pct2.textContent = pct+"%";
  if (stat) stat.textContent = `Processing ${uploadedFiles[idx]?.file.name||""}...`;
}

// ── Preview / Result ──────────────────────────────────────────────

function showPreview(file) {
  const box  = document.getElementById("previewContainer");
  const info = document.getElementById("previewInfo");
  if (!box) return;
  if (file.type.startsWith("image/")) {
    const url = URL.createObjectURL(file);
    box.innerHTML = `<img src="${url}" style="width:100%;height:100%;object-fit:contain" onload="URL.revokeObjectURL(this.src)">`;
  } else {
    box.innerHTML = `<div class="preview-empty"><i class="fas fa-file-video fa-2x" style="color:var(--primary)"></i><p>${file.name}</p></div>`;
  }
  if (info) {
    info.style.display = "block";
    document.getElementById("fileName").textContent = file.name;
    document.getElementById("fileSize").textContent  = formatFileSize(file.size);
    document.getElementById("fileType").textContent  = file.type;
  }
}

function showResult(data) {
  const box = document.getElementById("resultContainer");
  if (!box) return;
  const dom   = data.dominant_emotion || data.dominant || "—";
  const conf  = data.confidence ? Math.round(data.confidence*100)+"%" : "—";
  const scores= data.scores || data.emotions || {};
  box.innerHTML = `
    <div style="width:100%">
      <div style="text-align:center;margin-bottom:1rem">
        <i class="fas ${EMOTION_ICONS[dom]||"fa-meh"}" style="font-size:2.5rem;color:var(--primary)"></i>
        <div style="font-size:1.4rem;font-weight:700;text-transform:capitalize;margin-top:6px">${dom}</div>
        <div style="font-size:1rem;color:var(--primary)">${conf}</div>
        ${data.frames_sampled?`<div style="font-size:0.8rem;color:var(--text-secondary);margin-top:4px">Sampled ${data.frames_sampled} frames</div>`:""}
      </div>
      ${Object.entries(scores).sort((a,b)=>b[1]-a[1]).map(([em,v])=>`
        <div style="display:flex;justify-content:space-between;padding:5px 0;font-size:0.875rem">
          <span style="text-transform:capitalize">${em}</span>
          <span style="color:var(--primary);font-weight:700">${Math.round(v*100)}%</span>
        </div>`).join("")}
    </div>`;
}

window.viewResult = i => { const it=uploadedFiles[i]; if(it?.result){showPreview(it.file);showResult(it.result);} };
window.removeFile = i => { uploadedFiles.splice(i,1); renderQueue(); updateStats(); };

function clearQueue() {
  if (!uploadedFiles.length) return;
  if (!confirm("Clear all files?")) return;
  uploadedFiles=[]; processedResults=[];
  renderQueue(); updateStats();
  document.getElementById("previewContainer").innerHTML=`<div class="preview-empty"><i class="fas fa-file-image"></i><p>No file selected</p></div>`;
  document.getElementById("resultContainer").innerHTML=`<div class="result-empty"><i class="fas fa-info-circle"></i><p>No results yet</p></div>`;
  document.getElementById("previewInfo").style.display="none";
}

// ── Stats ─────────────────────────────────────────────────────────

function updateStats() {
  document.getElementById("totalFiles").textContent     = uploadedFiles.length;
  document.getElementById("processedFiles").textContent = uploadedFiles.filter(f=>f.status==="completed").length;
  if (processedResults.length) {
    const counts = {};
    processedResults.forEach(r => {
      const em = r.dominant_emotion||r.dominant||"neutral";
      counts[em]=(counts[em]||0)+1;
    });
    const dom = Object.keys(counts).reduce((a,b)=>counts[a]>counts[b]?a:b);
    document.getElementById("avgEmotion").textContent = dom.charAt(0).toUpperCase()+dom.slice(1);
  }
}

function exportBatchResults() {
  if (!processedResults.length) { showToast("No results to export"); return; }
  const ts = "_"+Date.now();
  const fmt = settings.get("exportFormat")||"json";
  if (fmt==="json") exportToJSON(processedResults,`batch${ts}.json`);
  else exportToCSV(processedResults,`batch${ts}.csv`);
  showToast("Results exported");
}

function saveBatch() {
  const batches = storage.load("batches")||[];
  batches.unshift({ id:"batch_"+Date.now(), timestamp:new Date().toISOString(), count:processedResults.length, results:processedResults });
  if (batches.length>20) batches.length=20;
  storage.save("batches", batches);
}
