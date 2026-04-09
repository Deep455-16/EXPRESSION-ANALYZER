/**
 * live.js  –  Real-time expression analysis
 * Connects to Flask-SocketIO backend, sends frames, receives MongoDB-persisted results.
 */

// ── State ─────────────────────────────────────────────────────────────────────
const State = {
  stream:        null,
  socket:        null,
  analysisTimer: null,
  sessionStart:  null,
  frameCount:    0,
  history:       [],
  isRunning:     false,
  backendUrl:    localStorage.getItem("backendUrl") || "http://localhost:5000",
  sessionId:     null,
  participantId: localStorage.getItem("participantId") || `user_${Date.now()}`,
  useBackend:    localStorage.getItem("analysisSource") === "backend",
  showOverlay:   true,
  recordHistory: true,
  detectionRate: 1000,
};

// ── Emotion config ────────────────────────────────────────────────────────────
const EMOTION_CONFIG = {
  happy:     { icon:"😊", color:"#4ade80",  label:"Happy"     },
  sad:       { icon:"😢", color:"#60a5fa",  label:"Sad"       },
  angry:     { icon:"😠", color:"#f87171",  label:"Angry"     },
  surprised: { icon:"😲", color:"#34d399",  label:"Surprised" },
  fearful:   { icon:"😨", color:"#a78bfa",  label:"Fearful"   },
  disgusted: { icon:"🤢", color:"#fb923c",  label:"Disgusted" },
  neutral:   { icon:"😐", color:"#94a3b8",  label:"Neutral"   },
};

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const webcam        = $("webcam");
const overlay       = $("overlay");
const ctx           = overlay?.getContext("2d");
const emotionIcon   = $("emotionIcon");
const emotionName   = $("emotionName");
const emotionConf   = $("emotionConfidence");
const emotionBars   = $("emotionBars");
const timeline      = $("timeline");
const backendStatus = $("backendStatus");
const latencySpan   = $("latencyMs");
const backendBadge  = $("backendBadge");
const frameCountEl  = $("frameCount");
const fpsEl         = $("fps");
const participantEl = $("participantCount");
const sessionDurEl  = $("sessionDuration");


// ═════════════════════════════════════════════════════════════════════════════
// CAMERA
// ═════════════════════════════════════════════════════════════════════════════

async function startCamera() {
  try {
    State.stream = await navigator.mediaDevices.getUserMedia({
      video: { width:1280, height:720, facingMode:"user" },
      audio: false,
    });
    webcam.srcObject = State.stream;
    await new Promise(r => webcam.onloadedmetadata = r);

    overlay.width  = webcam.videoWidth;
    overlay.height = webcam.videoHeight;

    State.isRunning  = true;
    State.sessionStart = Date.now();
    State.frameCount   = 0;
    State.history      = [];

    setBtn(true);
    updateStatus("🔴 Live", "#4ade80");
    startAnalysisLoop();
    startDurationTimer();
    showToast("Camera started");
  } catch (err) {
    showToast(`Camera error: ${err.message}`, "error");
  }
}

function stopCamera() {
  State.stream?.getTracks().forEach(t => t.stop());
  State.stream   = null;
  State.isRunning= false;
  clearInterval(State.analysisTimer);
  clearInterval(State._durationTimer);
  setBtn(false);
  updateStatus("Camera Off", "#94a3b8");
  if (ctx) ctx.clearRect(0,0,overlay.width,overlay.height);
}

function setBtn(running) {
  ["startCamera","startCameraMain"].forEach(id => {
    const el = $(id);
    if (el) el.disabled = running;
  });
  [$("captureFrame"),$("stopCamera")].forEach(el => {
    if (el) el.disabled = !running;
  });
}


// ═════════════════════════════════════════════════════════════════════════════
// ANALYSIS LOOP
// ═════════════════════════════════════════════════════════════════════════════

function startAnalysisLoop() {
  clearInterval(State.analysisTimer);

  const rate = State.detectionRate === "realtime" ? 100
             : parseInt(State.detectionRate) || 1000;

  State.analysisTimer = setInterval(async () => {
    if (!State.isRunning || !webcam.videoWidth) return;
    const b64 = captureBase64();
    if (!b64) return;

    State.frameCount++;
    if (frameCountEl) frameCountEl.textContent = State.frameCount;

    if (State.useBackend && State.socket?.connected) {
      // WebSocket path – fastest
      State.socket.emit("frame", {
        frame:          b64,
        participant_id: State.participantId,
        session_id:     State.sessionId,
        method:         "yolo",
      });
    } else if (State.useBackend) {
      // REST fallback
      try {
        const t0  = Date.now();
        const res = await fetch(`${State.backendUrl}/api/analyze`, {
          method:  "POST",
          headers: {"Content-Type":"application/json"},
          body:    JSON.stringify({
            frame:          b64,
            participant_id: State.participantId,
            session_id:     State.sessionId,
            method:         "yolo",
          }),
        });
        const data = await res.json();
        handleResult({...data, latency_ms: Date.now()-t0});
      } catch (err) {
        handleResult(mockResult());
      }
    } else {
      handleResult(mockResult());
    }
  }, rate);
}

function captureBase64() {
  const c = document.createElement("canvas");
  c.width  = webcam.videoWidth;
  c.height = webcam.videoHeight;
  c.getContext("2d").drawImage(webcam, 0,0);
  return c.toDataURL("image/jpeg", 0.75).split(",")[1];
}


// ═════════════════════════════════════════════════════════════════════════════
// WEBSOCKET
// ═════════════════════════════════════════════════════════════════════════════

function connectSocket() {
  if (typeof io === "undefined") {
    showToast("Socket.IO not loaded – using REST", "warn");
    return;
  }
  if (State.socket) State.socket.disconnect();

  const url = State.backendUrl;
  State.socket = io(url, {
    transports: ["websocket","polling"],
    query: { participant_id: State.participantId },
    reconnectionAttempts: 5,
  });

  State.socket.on("connect", () => {
    setBackendStatus(true);
    showToast("Backend connected ✓");
  });

  State.socket.on("connected", data => {
    State.sessionId = data.session_id;
    log(`Session ID: ${data.session_id}`);
  });

  State.socket.on("result", data => handleResult(data));

  State.socket.on("disconnect", () => setBackendStatus(false));
  State.socket.on("connect_error", () => setBackendStatus(false));
}

async function checkBackend() {
  try {
    const res  = await fetch(`${State.backendUrl}/health`, {signal: AbortSignal.timeout(3000)});
    const data = await res.json();
    setBackendStatus(data.status === "ok");
    log(`Backend: YOLO=${data.yolo} DeepFace=${data.deepface} MongoDB=${data.mongodb} FER2013=${data.fer_weights}`);
    return data.status === "ok";
  } catch {
    setBackendStatus(false);
    return false;
  }
}

function setBackendStatus(ok) {
  if (!backendStatus) return;
  backendStatus.textContent = ok ? "Online" : "Offline";
  backendStatus.style.color = ok ? "#4ade80" : "#f87171";
  if (backendBadge) backendBadge.style.display = ok ? "block" : "none";
}


// ═════════════════════════════════════════════════════════════════════════════
// RESULT HANDLER
// ═════════════════════════════════════════════════════════════════════════════

function handleResult(data) {
  if (data.error) return;

  const faces = data.face_emotions || [];

  // Draw annotated frame from backend onto overlay
  if (data.annotated_frame && State.showOverlay && ctx) {
    const img = new Image();
    img.onload = () => {
      ctx.clearRect(0,0,overlay.width,overlay.height);
      ctx.drawImage(img,0,0,overlay.width,overlay.height);
    };
    img.src = "data:image/jpeg;base64," + data.annotated_frame;
  } else if (ctx) {
    ctx.clearRect(0,0,overlay.width,overlay.height);
  }

  // Update latency badge
  if (data.latency_ms !== undefined) {
    if (latencySpan) latencySpan.textContent = Math.round(data.latency_ms);
  }

  // Primary face emotion
  if (faces.length > 0) {
    const primary = faces[0];
    const cfg     = EMOTION_CONFIG[primary.emotion] || EMOTION_CONFIG.neutral;

    if (emotionIcon) emotionIcon.innerHTML = `<span style="font-size:2.5rem">${cfg.icon}</span>`;
    if (emotionName) emotionName.textContent = cfg.label;
    if (emotionConf) emotionConf.textContent = `${Math.round(primary.confidence*100)}% confidence`;

    renderEmotionBars(primary.scores);
    addTimelineEntry(primary, data.attention);

    if (State.recordHistory) {
      State.history.push({
        ts:        data.timestamp || Date.now()/1000,
        emotion:   primary.emotion,
        confidence:primary.confidence,
        scores:    primary.scores,
        attention: data.attention,
        faces:     faces.length,
      });
    }
  }

  // Participant count from session
  if (data.session_id) State.sessionId = data.session_id;
  if (participantEl) participantEl.textContent = faces.length || 1;

  // FPS estimate
  if (fpsEl && State.sessionStart) {
    const elapsed = (Date.now() - State.sessionStart) / 1000;
    fpsEl.textContent = elapsed > 0 ? Math.round(State.frameCount / elapsed) : 0;
  }
}


// ─── Emotion bars ─────────────────────────────────────────────────────────────
function renderEmotionBars(scores) {
  if (!emotionBars || !scores) return;
  const sorted = Object.entries(scores).sort((a,b) => b[1]-a[1]);
  emotionBars.innerHTML = sorted.map(([em, val]) => {
    const cfg = EMOTION_CONFIG[em] || {color:"#94a3b8", label: em};
    const pct = Math.round(val * 100);
    return `
      <div class="emotion-bar-row">
        <span class="emotion-bar-label">${cfg.label}</span>
        <div class="emotion-bar-track">
          <div class="emotion-bar-fill"
               style="width:${pct}%;background:${cfg.color};transition:width .4s ease"></div>
        </div>
        <span class="emotion-bar-pct">${pct}%</span>
      </div>`;
  }).join("");
}


// ─── Timeline ─────────────────────────────────────────────────────────────────
function addTimelineEntry(face, attention) {
  if (!timeline) return;
  const cfg   = EMOTION_CONFIG[face.emotion] || EMOTION_CONFIG.neutral;
  const now   = new Date().toLocaleTimeString();
  const pct   = Math.round(face.confidence*100);
  const empty = timeline.querySelector(".timeline-empty");
  if (empty) empty.remove();

  const entry = document.createElement("div");
  entry.className = "timeline-entry";
  entry.innerHTML = `
    <div class="tl-icon" style="background:${cfg.color}20;border:1px solid ${cfg.color}40">
      ${cfg.icon}
    </div>
    <div class="tl-info">
      <span class="tl-emotion" style="color:${cfg.color}">${cfg.label}</span>
      <span class="tl-meta">${pct}% · attn ${attention??'—'}% · ${now}</span>
    </div>`;
  timeline.prepend(entry);

  // Keep max 40 entries
  while (timeline.children.length > 40) timeline.lastChild.remove();
}


// ═════════════════════════════════════════════════════════════════════════════
// MOCK (offline demo, FER2013-distribution-aware)
// ═════════════════════════════════════════════════════════════════════════════

const FER_WEIGHTS = {happy:0.247,neutral:0.248,sad:0.134,angry:0.129,
                     fearful:0.075,disgusted:0.035,surprised:0.036};

function mockResult() {
  const raw   = Object.fromEntries(
    Object.entries(FER_WEIGHTS).map(([e,w]) => [e, Math.random()*w])
  );
  const total = Object.values(raw).reduce((a,b)=>a+b,0);
  const scores= Object.fromEntries(Object.entries(raw).map(([e,v])=>[e,+(v/total).toFixed(4)]));
  const dom   = Object.entries(scores).sort((a,b)=>b[1]-a[1])[0][0];
  return {
    participant_id: State.participantId,
    faces_detected: 1,
    face_emotions:  [{bbox:[80,60,160,160],emotion:dom,confidence:scores[dom],scores}],
    motion_score:   +(Math.random()*0.3).toFixed(4),
    attention:      50+Math.floor(Math.random()*45),
    latency_ms:     8+Math.random()*12,
    annotated_frame:null,
    timestamp:      Date.now()/1000,
  };
}


// ═════════════════════════════════════════════════════════════════════════════
// DURATION TIMER
// ═════════════════════════════════════════════════════════════════════════════

function startDurationTimer() {
  clearInterval(State._durationTimer);
  State._durationTimer = setInterval(() => {
    if (!State.sessionStart || !sessionDurEl) return;
    const s   = Math.floor((Date.now()-State.sessionStart)/1000);
    const hh  = String(Math.floor(s/3600)).padStart(2,"0");
    const mm  = String(Math.floor((s%3600)/60)).padStart(2,"0");
    const ss  = String(s%60).padStart(2,"0");
    sessionDurEl.textContent = `${hh}:${mm}:${ss}`;
  }, 1000);
}


// ═════════════════════════════════════════════════════════════════════════════
// EXPORT
// ═════════════════════════════════════════════════════════════════════════════

function exportSession() {
  if (!State.history.length) { showToast("No data to export","warn"); return; }
  const fmt    = localStorage.getItem("exportFormat") || "json";
  let   blob, name;
  if (fmt === "csv") {
    const hdr  = "timestamp,emotion,confidence,attention,faces\n";
    const rows = State.history.map(r =>
      `${r.ts},${r.emotion},${r.confidence},${r.attention??''},${r.faces}`
    ).join("\n");
    blob = new Blob([hdr+rows], {type:"text/csv"});
    name = `emotiscan_session_${Date.now()}.csv`;
  } else {
    blob = new Blob([JSON.stringify({
      session_id:     State.sessionId,
      participant_id: State.participantId,
      exported_at:    new Date().toISOString(),
      frames:         State.history,
    }, null, 2)], {type:"application/json"});
    name = `emotiscan_session_${Date.now()}.json`;
  }
  const a  = document.createElement("a");
  a.href   = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  showToast("Session exported ✓");
}


// ═════════════════════════════════════════════════════════════════════════════
// CAPTURE FRAME
// ═════════════════════════════════════════════════════════════════════════════

function captureFrameModal() {
  const c = document.createElement("canvas");
  c.width  = webcam.videoWidth; c.height = webcam.videoHeight;
  c.getContext("2d").drawImage(webcam,0,0);
  const url = c.toDataURL("image/png");
  const img = $("capturedImage");
  if (img) img.src = url;
  const modal = $("captureModal");
  if (modal) modal.classList.add("active");
  const dl = $("downloadCapture");
  if (dl) dl.onclick = () => {
    const a = document.createElement("a");
    a.href = url; a.download = `capture_${Date.now()}.png`; a.click();
  };
}


// ═════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═════════════════════════════════════════════════════════════════════════════

function updateStatus(text, color="#94a3b8") {
  const el = $("statusText");
  if (el) { el.textContent = text; el.style.color = color; }
}

function log(msg) { console.log(`[EmotiScan] ${msg}`); }


// ═════════════════════════════════════════════════════════════════════════════
// INIT + EVENT WIRING
// ═════════════════════════════════════════════════════════════════════════════

document.addEventListener("DOMContentLoaded", async () => {

  // Restore settings
  const src = $("analysisSource");
  if (src) {
    src.value = State.useBackend ? "backend" : "mock";
    src.addEventListener("change", () => {
      State.useBackend = src.value === "backend";
      localStorage.setItem("analysisSource", src.value);
    });
  }

  const urlInput = $("backendUrlInput");
  if (urlInput) {
    urlInput.value = State.backendUrl;
    urlInput.addEventListener("change", () => {
      State.backendUrl = urlInput.value.trim();
      localStorage.setItem("backendUrl", State.backendUrl);
    });
  }

  const connBtn = $("connectBackendBtn");
  if (connBtn) connBtn.addEventListener("click", async () => {
    State.backendUrl = ($("backendUrlInput")?.value || "http://localhost:5000").trim();
    localStorage.setItem("backendUrl", State.backendUrl);
    const ok = await checkBackend();
    if (ok) connectSocket();
  });

  // Detection rate
  const rateEl = $("detectionRate");
  if (rateEl) {
    rateEl.value = "1000";
    rateEl.addEventListener("change", () => {
      State.detectionRate = rateEl.value;
      if (State.isRunning) startAnalysisLoop();
    });
  }

  // Confidence threshold display
  const thresh = $("confidenceThreshold");
  const thrVal = $("thresholdValue");
  if (thresh && thrVal) {
    thresh.addEventListener("input", () => {
      thrVal.textContent = `${thresh.value}%`;
    });
  }

  // Overlay toggle
  const ovCheck = $("showOverlay");
  if (ovCheck) ovCheck.addEventListener("change", () => {
    State.showOverlay = ovCheck.checked;
    if (!ovCheck.checked && ctx) ctx.clearRect(0,0,overlay.width,overlay.height);
  });

  // Record history
  const recCheck = $("recordHistory");
  if (recCheck) recCheck.addEventListener("change", () => {
    State.recordHistory = recCheck.checked;
  });

  // Camera buttons
  ["startCamera","startCameraMain"].forEach(id => {
    $(id)?.addEventListener("click", startCamera);
  });
  $("stopCamera")?.addEventListener("click", stopCamera);
  $("captureFrame")?.addEventListener("click", captureFrameModal);
  $("closeModal")?.addEventListener("click",  () => $("captureModal")?.classList.remove("active"));
  $("closeModal2")?.addEventListener("click", () => $("captureModal")?.classList.remove("active"));

  $("toggleOverlay")?.addEventListener("click", () => {
    State.showOverlay = !State.showOverlay;
    if (!State.showOverlay && ctx) ctx.clearRect(0,0,overlay.width,overlay.height);
  });

  // Actions
  $("exportSession")?.addEventListener("click", exportSession);
  $("clearHistory")?.addEventListener("click",  () => {
    State.history = [];
    if (timeline) {
      timeline.innerHTML = `<div class="timeline-empty"><i class="fas fa-info-circle"></i><p>No data yet</p></div>`;
    }
    showToast("History cleared");
  });
  $("viewDashboard")?.addEventListener("click", () => { window.location.href = "dashboard.html"; });

  // Auto-connect backend
  if (State.useBackend) {
    const ok = await checkBackend();
    if (ok) connectSocket();
  }
});
