/**
 * upload.js – File upload & batch analysis
 * POSTs to /api/upload, displays per-file emotion results from backend.
 */

const BACKEND    = localStorage.getItem("backendUrl") || "http://localhost:5000";
const EMOTION_CFG= {
  happy:    {icon:"😊",color:"#4ade80"}, sad:      {icon:"😢",color:"#60a5fa"},
  angry:    {icon:"😠",color:"#f87171"}, surprised:{icon:"😲",color:"#34d399"},
  fearful:  {icon:"😨",color:"#a78bfa"}, disgusted:{icon:"🤢",color:"#fb923c"},
  neutral:  {icon:"😐",color:"#94a3b8"},
};

let queue       = [];
let results     = [];
let totalStart  = null;
let processed   = 0;
let timeTimer   = null;

// ── DOM ───────────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const uploadArea     = $("uploadArea");
const fileInput      = $("fileInput");
const fileQueue      = $("fileQueue");
const queueList      = $("queueList");
const previewCont    = $("previewContainer");
const previewInfo    = $("previewInfo");
const resultCont     = $("resultContainer");


// ── Drag & drop ───────────────────────────────────────────────────────────────
uploadArea?.addEventListener("dragover",  e => { e.preventDefault(); uploadArea.classList.add("drag-over"); });
uploadArea?.addEventListener("dragleave", () => uploadArea.classList.remove("drag-over"));
uploadArea?.addEventListener("drop", e => {
  e.preventDefault();
  uploadArea.classList.remove("drag-over");
  addFiles([...e.dataTransfer.files]);
});
uploadArea?.addEventListener("click", () => fileInput?.click());
$("browseBtn")?.addEventListener("click", e => { e.stopPropagation(); fileInput?.click(); });
fileInput?.addEventListener("change", () => {
  addFiles([...fileInput.files]);
  fileInput.value = "";
});


// ── Queue management ──────────────────────────────────────────────────────────
function addFiles(files) {
  const allowed = ["jpg","jpeg","png","gif","webp","mp4","webm","mov","avi"];
  files.forEach(f => {
    const ext = f.name.split(".").pop().toLowerCase();
    if (!allowed.includes(ext)) { showToast(`${f.name}: unsupported type`,"error"); return; }
    queue.push({ file:f, id:Date.now()+Math.random(), status:"pending", result:null });
  });
  renderQueue();
  if ($("autoProcess")?.checked && queue.some(q=>q.status==="pending")) {
    processAll();
  }
}

function renderQueue() {
  if (!queue.length) { fileQueue.style.display="none"; return; }
  fileQueue.style.display="block";
  $("totalFiles").textContent = queue.length;

  queueList.innerHTML = queue.map(item => `
    <div class="queue-item" data-id="${item.id}">
      <div class="queue-icon">
        <i class="fas fa-${item.file.type.startsWith("video")?"film":"image"}"></i>
      </div>
      <div class="queue-info">
        <div class="queue-name">${item.file.name}</div>
        <div class="queue-size">${formatBytes(item.file.size)}</div>
      </div>
      <div class="queue-status ${item.status}">
        ${item.status==="pending"   ? '<i class="fas fa-clock"></i> Pending'    :
          item.status==="processing"? '<i class="fas fa-spinner fa-spin"></i> Processing' :
          item.status==="done"      ? `<span style="color:#4ade80"><i class="fas fa-check"></i> ${
            item.result?.dominant_emotion || item.result?.face_emotions?.[0]?.emotion || "done"
          }</span>` :
          '<span style="color:#f87171"><i class="fas fa-times"></i> Error</span>'}
      </div>
      <button class="btn btn-sm btn-danger" onclick="removeItem('${item.id}')">
        <i class="fas fa-times"></i>
      </button>
    </div>`).join("");

  // Preview first item
  const first = queue[0];
  if (first) showPreview(first.file);
}

function removeItem(id) {
  queue = queue.filter(q => String(q.id) !== String(id));
  renderQueue();
}

$("clearQueue")?.addEventListener("click", () => { queue=[]; renderQueue(); });


// ── Preview ───────────────────────────────────────────────────────────────────
function showPreview(file) {
  if (!previewCont) return;
  const url = URL.createObjectURL(file);
  previewCont.innerHTML = file.type.startsWith("video")
    ? `<video src="${url}" controls style="max-width:100%;border-radius:8px"></video>`
    : `<img src="${url}" style="max-width:100%;border-radius:8px">`;
  if (previewInfo) {
    previewInfo.style.display="block";
    $("fileName").textContent = file.name;
    $("fileSize").textContent  = formatBytes(file.size);
    $("fileType").textContent  = file.type || "Unknown";
  }
}


// ── Processing ────────────────────────────────────────────────────────────────
async function processAll() {
  const pending = queue.filter(q=>q.status==="pending");
  if (!pending.length) { showToast("No pending files","warn"); return; }

  totalStart = Date.now();
  processed  = 0;
  startTimeTimer();

  for (const item of pending) {
    item.status = "processing";
    renderQueue();

    try {
      const fd = new FormData();
      fd.append("file", item.file);

      const res  = await fetch(`${BACKEND}/api/upload`, {method:"POST", body:fd});
      const data = await res.json();

      item.result = data;
      item.status = data.error ? "error" : "done";
      if (!data.error) results.push({filename:item.file.name, ...data});

    } catch {
      item.status = "error";
    }

    processed++;
    $("processedFiles").textContent = processed;
    renderQueue();
    if (item.result && !item.result.error) showResult(item.result);
  }

  clearInterval(timeTimer);
  const dom = topEmotion();
  if (dom) $("avgEmotion").textContent = dom;
  showToast(`Processed ${processed} file${processed!==1?"s":""}  ✓`);
}

function showResult(data) {
  if (!resultCont) return;
  const faces   = data.face_emotions || [];
  const primary = faces[0];
  const dom     = data.dominant_emotion || primary?.emotion || "—";
  const cfg     = EMOTION_CFG[dom] || {icon:"❓",color:"#94a3b8"};
  const conf    = data.confidence ?? primary?.confidence ?? 0;
  const scores  = data.scores || primary?.scores || {};

  resultCont.innerHTML = `
    <div style="text-align:center;padding:12px 0">
      <div style="font-size:2.8rem;margin-bottom:8px">${cfg.icon}</div>
      <div style="font-size:1.2rem;font-weight:700;color:${cfg.color}">${dom}</div>
      <div style="color:#94a3b8;font-size:.85rem">${Math.round(conf*100)}% confidence</div>
      ${data.frames_sampled ? `<div style="color:#94a3b8;font-size:.8rem;margin-top:4px">${data.frames_sampled} frames sampled</div>` : ""}
    </div>
    <div class="emotion-bars" style="padding:0 8px">
      ${Object.entries(scores).sort((a,b)=>b[1]-a[1]).map(([em,v])=>{
        const c = EMOTION_CFG[em]?.color||"#94a3b8";
        return `<div class="emotion-bar-row">
          <span class="emotion-bar-label" style="font-size:.8rem">${em}</span>
          <div class="emotion-bar-track"><div class="emotion-bar-fill" style="width:${Math.round(v*100)}%;background:${c}"></div></div>
          <span class="emotion-bar-pct">${Math.round(v*100)}%</span>
        </div>`;
      }).join("")}
    </div>`;
}

function topEmotion() {
  const counts = {};
  results.forEach(r => {
    const e = r.dominant_emotion || r.face_emotions?.[0]?.emotion;
    if (e) counts[e] = (counts[e]||0)+1;
  });
  return Object.entries(counts).sort((a,b)=>b[1]-a[1])[0]?.[0] || null;
}

$("processAll")?.addEventListener("click", processAll);


// ── Export ────────────────────────────────────────────────────────────────────
$("exportResults")?.addEventListener("click", () => {
  if (!results.length) { showToast("No results yet","warn"); return; }
  const blob = new Blob([JSON.stringify(results,null,2)],{type:"application/json"});
  const a    = document.createElement("a");
  a.href     = URL.createObjectURL(blob);
  a.download = `emotiscan_upload_${Date.now()}.json`;
  a.click();
  showToast("Results exported ✓");
});


// ── Time tracker ──────────────────────────────────────────────────────────────
function startTimeTimer() {
  clearInterval(timeTimer);
  timeTimer = setInterval(() => {
    if (!totalStart) return;
    $("processingTime").textContent = `${((Date.now()-totalStart)/1000).toFixed(1)}s`;
  }, 200);
}

function formatBytes(b) {
  return b<1024?""+b+" B":b<1048576?(b/1024).toFixed(1)+" KB":(b/1048576).toFixed(1)+" MB";
}
