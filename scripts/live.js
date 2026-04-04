// ========================================
// Live Analysis — live.js
// Integrates with Python backend via REST + WebSocket
// ========================================

let stream          = null;
let videoElement    = null;
let overlayCanvas   = null;
let overlayCtx      = null;
let isRunning       = false;
let sessionManager  = null;
let analysisInterval= null;
let sessionTimer    = null;
let frameCounter    = 0;
let fpsCounter      = 0;
let lastFpsUpdate   = Date.now();
let backendSocket   = null;   // socket.io connection to backend
let useBackend      = false;
let backendUrl      = "http://localhost:5000";

// ========================================
// Init
// ========================================

document.addEventListener("DOMContentLoaded", () => {
  videoElement  = document.getElementById("webcam");
  overlayCanvas = document.getElementById("overlay");
  sessionManager = new SessionManager();
  updateUI();
  loadSettings();
  wireBackendControls();
  wireWebRTCControls();
});

function loadSettings() {
  const rate = settings.get("defaultDetectionRate");
  const thr  = settings.get("minConfidence");
  const rateEl = document.getElementById("detectionRate");
  const thrEl  = document.getElementById("confidenceThreshold");
  const thrTxt = document.getElementById("thresholdValue");
  if (rateEl) rateEl.value = rate;
  if (thrEl)  thrEl.value  = thr;
  if (thrTxt) thrTxt.textContent = thr + "%";

  document.getElementById("detectionRate")?.addEventListener("change", e =>
    updateDetectionRate(e.target.value)
  );
  document.getElementById("confidenceThreshold")?.addEventListener("input", e => {
    document.getElementById("thresholdValue").textContent = e.target.value + "%";
  });
  document.getElementById("startCamera")?.addEventListener("click", toggleCamera);
  document.getElementById("startCameraMain")?.addEventListener("click", toggleCamera);
  document.getElementById("stopCamera")?.addEventListener("click", stopCamera);
  document.getElementById("captureFrame")?.addEventListener("click", captureFrame);
  document.getElementById("toggleOverlay")?.addEventListener("click", toggleOverlay);
  document.getElementById("exportSession")?.addEventListener("click", exportCurrentSession);
  document.getElementById("clearHistory")?.addEventListener("click", clearTimeline);
  document.getElementById("viewDashboard")?.addEventListener("click", () => {
    window.location.href = "dashboard.html";
  });
  document.getElementById("closeModal")?.addEventListener("click", () => closeModal("captureModal"));
  document.getElementById("closeModal2")?.addEventListener("click",() => closeModal("captureModal"));
  document.getElementById("downloadCapture")?.addEventListener("click", downloadCapturedImage);
}

// ========================================
// Backend Controls
// ========================================

function wireBackendControls() {
  document.getElementById("connectBackendBtn")?.addEventListener("click", () => {
    backendUrl = document.getElementById("backendUrlInput")?.value || "http://localhost:5000";
    connectToBackend(backendUrl);
  });
  document.getElementById("analysisSource")?.addEventListener("change", e => {
    useBackend = (e.target.value === "backend");
  });
}

async function connectToBackend(url) {
  const statusEl = document.getElementById("backendStatus");
  try {
    const res  = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2500) });
    const data = await res.json();
    if (statusEl) { statusEl.textContent = "Online"; statusEl.style.color = "var(--success)"; }
    const badge = document.getElementById("backendBadge");
    if (badge) badge.style.display = "block";
    showToast(`Backend online · YOLOv8:${data.yolo?"✓":"✗"} DeepFace:${data.deepface?"✓":"✗"}`);
    // Connect WebSocket for streaming
    if (typeof io !== "undefined") {
      backendSocket = io(url, { transports: ["websocket"] });
      backendSocket.on("result", onBackendResult);
    }
    return true;
  } catch {
    if (statusEl) { statusEl.textContent = "Offline"; statusEl.style.color = "var(--danger)"; }
    showToast("Backend offline — using mock analysis");
    return false;
  }
}

// ========================================
// Camera Control
// ========================================

async function toggleCamera() {
  if (isRunning) stopCamera(); else await startCamera();
}

async function startCamera() {
  try {
    const res = settings.get("resolution") || "1280x720";
    const [w, h] = res.split("x").map(Number);
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: w }, height: { ideal: h } }, audio: false
    });
    videoElement.srcObject = stream;
    await new Promise(resolve => { videoElement.onloadedmetadata = () => { videoElement.play(); resolve(); }; });

    overlayCanvas.width  = videoElement.videoWidth;
    overlayCanvas.height = videoElement.videoHeight;
    overlayCtx = overlayCanvas.getContext("2d");

    isRunning = true;
    sessionManager.start();
    window._localStream = stream;    // expose for WebRTC module

    startAnalysis();
    sessionTimer = setInterval(updateSessionInfo, 1000);
    updateUI();
    updateStatus("Recording", true);
  } catch (err) {
    console.error(err);
    showToast("Camera access denied — check browser permissions");
  }
}

function stopCamera() {
  stream?.getTracks().forEach(t => t.stop());
  stream = null;
  if (videoElement) videoElement.srcObject = null;
  clearInterval(analysisInterval); analysisInterval = null;
  clearInterval(sessionTimer);     sessionTimer = null;
  isRunning = false;
  window._localStream = null;
  sessionManager.save();
  updateUI();
  updateStatus("Stopped", false);
}

function updateStatus(text, recording = false) {
  const el   = document.getElementById("statusText");
  const icon = document.querySelector("#videoStatus i");
  if (el)   el.textContent = text;
  if (icon) icon.style.color = recording ? "#10b981" : "#ef4444";
}

// ========================================
// Analysis Loop
// ========================================

function startAnalysis() {
  const rate = document.getElementById("detectionRate")?.value || "1000";
  updateDetectionRate(rate);
}

function updateDetectionRate(rate) {
  clearInterval(analysisInterval); analysisInterval = null;
  if (!isRunning) return;
  if (rate === "realtime") {
    (function loop() { if (isRunning) { performAnalysis(); requestAnimationFrame(loop); } })();
  } else {
    analysisInterval = setInterval(performAnalysis, parseInt(rate));
  }
}

async function performAnalysis() {
  if (!isRunning || !videoElement) return;
  try {
    const canvas = captureVideoFrame(videoElement, videoElement.videoWidth, videoElement.videoHeight);
    let result;

    const src = document.getElementById("analysisSource")?.value || "mock";

    if (src === "backend") {
      result = await analyzeViaREST(canvas);
    } else {
      const imgData = canvas.getContext("2d").getImageData(0,0,canvas.width,canvas.height);
      result = await analyzeExpression(imgData);
    }

    displayResult(result);
    sessionManager.addResult(result);
    addToTimeline(result);
    frameCounter++;
    fpsCounter++;
    const now = Date.now();
    if (now - lastFpsUpdate >= 1000) {
      const fpsEl = document.getElementById("fps");
      if (fpsEl) fpsEl.textContent = fpsCounter;
      fpsCounter = 0; lastFpsUpdate = now;
    }
    if (document.getElementById("showOverlay")?.checked) drawOverlay(result);
  } catch (e) { console.error("analysis error", e); }
}

// ─── REST call to Python backend ────────────────────────────────

async function analyzeViaREST(canvas) {
  const frame = canvas.toDataURL("image/jpeg", 0.75).split(",")[1];
  const t0    = performance.now();
  try {
    const res   = await fetch(`${backendUrl}/api/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ frame, participant_id: "local", method: "yolo" }),
      signal: AbortSignal.timeout(3000),
    });
    const data  = await res.json();
    const ms    = Math.round(performance.now()-t0);
    const latEl = document.getElementById("latencyMs");
    if (latEl) latEl.textContent = ms;
    const badge = document.getElementById("backendBadge");
    if (badge) badge.style.display = "block";

    // Map backend response → frontend format
    if (data.face_emotions?.length) {
      const fe = data.face_emotions[0];
      const emotions = {};
      EMOTIONS.forEach(e => { emotions[e] = Math.round((fe.scores[e]||0)*100); });
      return { emotions, dominant: fe.emotion, confidence: Math.round(fe.confidence*100), timestamp: new Date().toISOString() };
    }
    return await analyzeExpression(null);
  } catch {
    return await analyzeExpression(null);
  }
}

// ─── WebSocket result (sent when backend pushes) ─────────────────

function onBackendResult(data) {
  if (!data.face_emotions?.length) return;
  const fe = data.face_emotions[0];
  const emotions = {};
  EMOTIONS.forEach(e => { emotions[e] = Math.round((fe.scores[e]||0)*100); });
  const result = { emotions, dominant: fe.emotion, confidence: Math.round(fe.confidence*100), timestamp: new Date().toISOString() };
  displayResult(result);
  sessionManager.addResult(result);
  addToTimeline(result);
}

// ========================================
// Display
// ========================================

function displayResult(result) {
  const iconEl = document.getElementById("emotionIcon");
  const nameEl = document.getElementById("emotionName");
  const confEl = document.getElementById("emotionConfidence");
  if (iconEl) iconEl.innerHTML = `<i class="fas ${EMOTION_ICONS[result.dominant]||"fa-meh"}"></i>`;
  if (nameEl) nameEl.textContent = result.dominant.charAt(0).toUpperCase()+result.dominant.slice(1);
  if (confEl) confEl.textContent = result.confidence + "%";
  updateEmotionBars(result.emotions);
}

function updateEmotionBars(emotions) {
  const bars = document.getElementById("emotionBars");
  if (!bars) return;
  const sorted = Object.entries(emotions).sort((a,b)=>b[1]-a[1]);
  const COLORS = { happy:"#10b981",sad:"#60a5fa",angry:"#f43f5e",surprised:"#f59e0b",fearful:"#a78bfa",disgusted:"#f472b6",neutral:"#94a3b8" };
  bars.innerHTML = sorted.map(([em,val]) => `
    <div class="emotion-bar">
      <span style="text-transform:capitalize">${em}</span>
      <div style="display:flex;align-items:center;gap:8px;flex:1;justify-content:flex-end">
        <div style="width:70px;height:4px;border-radius:2px;background:rgba(0,0,0,0.08);overflow:hidden">
          <div style="width:${val}%;height:100%;background:${COLORS[em]||"#94a3b8"};border-radius:2px"></div>
        </div>
        <span style="color:var(--primary);font-size:13px;min-width:34px;text-align:right">${val}%</span>
      </div>
    </div>`).join("");
}

function drawOverlay(result) {
  if (!overlayCtx) return;
  overlayCtx.clearRect(0,0,overlayCanvas.width,overlayCanvas.height);
  const w=overlayCanvas.width, h=overlayCanvas.height;
  const bw=w*0.38, bh=h*0.52, bx=(w-bw)/2, by=(h-bh)/2, cs=16;
  overlayCtx.strokeStyle="#10b981"; overlayCtx.lineWidth=2.5;
  [[bx,by,1,1],[bx+bw,by,-1,1],[bx,by+bh,1,-1],[bx+bw,by+bh,-1,-1]].forEach(([cx,cy,dx,dy])=>{
    overlayCtx.beginPath();
    overlayCtx.moveTo(cx,cy+dy*cs); overlayCtx.lineTo(cx,cy); overlayCtx.lineTo(cx+dx*cs,cy);
    overlayCtx.stroke();
  });
  const lbl = `${result.dominant.toUpperCase()}  ${result.confidence}%`;
  overlayCtx.fillStyle="rgba(0,0,0,0.65)";
  overlayCtx.fillRect(bx, by-28, lbl.length*9+12, 26);
  overlayCtx.fillStyle="#10b981"; overlayCtx.font="bold 12px monospace";
  overlayCtx.fillText(lbl, bx+6, by-10);
}

function toggleOverlay() {
  if (overlayCtx) overlayCtx.clearRect(0,0,overlayCanvas.width,overlayCanvas.height);
}

// ========================================
// Session + Timeline
// ========================================

function updateSessionInfo() {
  const dur   = document.getElementById("sessionDuration");
  const frm   = document.getElementById("frameCount");
  if (dur) dur.textContent = formatDuration(sessionManager.getDuration());
  if (frm) frm.textContent = frameCounter;
}

function addToTimeline(result) {
  const tl = document.getElementById("timeline");
  if (!tl) return;
  tl.querySelector(".timeline-empty")?.remove();
  const item = document.createElement("div");
  item.className = "timeline-item";
  item.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center">
      <div>
        <strong style="text-transform:capitalize">${result.dominant}</strong>
        <div style="font-size:0.75rem;color:var(--text-secondary)">${new Date().toLocaleTimeString()}</div>
      </div>
      <div style="font-weight:700;color:var(--primary)">${result.confidence}%</div>
    </div>`;
  tl.insertBefore(item, tl.firstChild);
  while (tl.children.length>20) tl.removeChild(tl.lastChild);
}

function clearTimeline() {
  const tl = document.getElementById("timeline");
  if (tl) tl.innerHTML = `<div class="timeline-empty"><i class="fas fa-info-circle"></i><p>Start analysis to see timeline</p></div>`;
  frameCounter   = 0;
  sessionManager = new SessionManager();
}

// ========================================
// Capture / Export
// ========================================

let capturedImageData = null;
function captureFrame() {
  if (!isRunning||!videoElement) return;
  const c = captureVideoFrame(videoElement, videoElement.videoWidth, videoElement.videoHeight);
  capturedImageData = canvasToDataURL(c);
  const img = document.getElementById("capturedImage");
  if (img) img.src = capturedImageData;
  const info = document.getElementById("captureInfo");
  if (info) {
    const s = sessionManager.getStats();
    info.innerHTML = `<div style="margin-top:1rem;padding:1rem;background:rgba(0,0,0,0.04);border-radius:8px">
      <div><strong>Dominant:</strong> ${s.dominant}</div>
      <div><strong>Avg Confidence:</strong> ${s.avgConfidence}%</div>
      <div><strong>Captured:</strong> ${new Date().toLocaleString()}</div></div>`;
  }
  openModal("captureModal");
}

function downloadCapturedImage() {
  if (!capturedImageData) return;
  const a = document.createElement("a");
  a.href = capturedImageData; a.download = `capture_${Date.now()}.jpg`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
}

function exportCurrentSession() {
  const data = sessionManager.export();
  if (!data.data.length) { showToast("No data to export"); return; }
  const fmt = settings.get("exportFormat")||"json";
  const ts  = settings.get("includeTimestamp")?"_"+Date.now():"";
  if (fmt==="json") exportToJSON(data,`session${ts}.json`);
  else exportToCSV(data.data.map(d=>({timestamp:d.timestamp,dominant:d.dominant,confidence:d.confidence,...d.emotions})),`session${ts}.csv`);
  showToast("Session exported");
}

// ========================================
// UI
// ========================================

function updateUI() {
  const s = document.getElementById("startCamera");
  const t = document.getElementById("stopCamera");
  const c = document.getElementById("captureFrame");
  if (s) s.innerHTML = isRunning ? '<i class="fas fa-pause"></i> Pause' : '<i class="fas fa-play"></i> Start Camera';
  if (t) t.disabled = !isRunning;
  if (c) c.disabled = !isRunning;
}

// ========================================
// WebRTC Mode wiring (minimal — real logic in webrtc.js)
// ========================================

function wireWebRTCControls() {
  const toggleBtn = document.getElementById("toggleWebRTCMode");
  const bar       = document.getElementById("webrtcStatusBar");
  const section   = document.getElementById("webrtcParticipantsSection");
  let on = false;
  toggleBtn?.addEventListener("click", () => {
    on = !on;
    if (bar)     bar.style.display     = on ? "flex" : "none";
    if (section) section.style.display = on ? "block": "none";
    if (toggleBtn) {
      toggleBtn.innerHTML = on
        ? '<i class="fas fa-users"></i> WebRTC: ON'
        : '<i class="fas fa-users"></i> WebRTC Mode';
      toggleBtn.className = on ? "btn btn-primary" : "btn btn-secondary";
    }
    if (on) showToast("WebRTC mode enabled");
  });
}
