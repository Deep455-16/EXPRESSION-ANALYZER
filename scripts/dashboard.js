/**
 * dashboard.js – Analytics Dashboard
 * Pulls real data from MongoDB via /api/stats, /api/sessions, /api/history
 */

const BACKEND = localStorage.getItem("backendUrl") || "http://localhost:5000";

const EMOTION_COLORS = {
  happy:     "#4ade80", sad:       "#60a5fa", angry:     "#f87171",
  surprised: "#34d399", fearful:   "#a78bfa", disgusted: "#fb923c",
  neutral:   "#94a3b8",
};
const EMOTION_LABELS_MAP = {
  happy:"Happy",sad:"Sad",angry:"Angry",surprised:"Surprised",
  fearful:"Fearful",disgusted:"Disgusted",neutral:"Neutral",
};

let trendChart, confChart, distChart;
let allSessions  = [];
let currentPage  = 1;
const PAGE_SIZE  = 10;


// ═════════════════════════════════════════════════════════════════════════════
// FETCH HELPERS
// ═════════════════════════════════════════════════════════════════════════════

async function apiFetch(path) {
  try {
    const r = await fetch(BACKEND + path, {signal: AbortSignal.timeout(6000)});
    if (!r.ok) throw new Error(r.status);
    return await r.json();
  } catch { return null; }
}

async function loadDashboard() {
  const [statsData, sessionsData] = await Promise.all([
    apiFetch("/api/stats"),
    apiFetch("/api/sessions?limit=100"),
  ]);

  if (statsData && statsData.stats) {
    renderSummaryCards(statsData);
    renderCharts(statsData);
  } else {
    renderMockCharts();
  }

  if (sessionsData && sessionsData.sessions) {
    allSessions = sessionsData.sessions;
    renderSessionsTable(allSessions);
  } else {
    renderMockSessions();
  }
}


// ═════════════════════════════════════════════════════════════════════════════
// SUMMARY CARDS
// ═════════════════════════════════════════════════════════════════════════════

function renderSummaryCards(data) {
  const total = data.total_frames || 0;

  const sessions = allSessions.length ||
    (document.getElementById("totalSessions")?.textContent || 0);

  setEl("totalSessions",   allSessions.length || "—");
  setEl("totalFrames",     total.toLocaleString());

  const avgConf = data.stats.length
    ? Math.round(data.stats.reduce((a,r)=>a+r.avg_confidence,0)/data.stats.length*100)
    : 0;
  setEl("avgConfidence",   `${avgConf}%`);

  // Avg session duration
  const completed = allSessions.filter(s=>s.duration_seconds);
  const avgDur    = completed.length
    ? Math.round(completed.reduce((a,s)=>a+s.duration_seconds,0)/completed.length)
    : 0;
  setEl("avgDuration", avgDur >= 60 ? `${Math.round(avgDur/60)}m` : `${avgDur}s`);
}

function setEl(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}


// ═════════════════════════════════════════════════════════════════════════════
// CHARTS
// ═════════════════════════════════════════════════════════════════════════════

function renderCharts(statsData) {
  const rows   = statsData.stats || [];
  const labels = rows.map(r => EMOTION_LABELS_MAP[r.emotion] || r.emotion);
  const counts = rows.map(r => r.count);
  const confs  = rows.map(r => Math.round(r.avg_confidence*100));
  const colors = rows.map(r => EMOTION_COLORS[r.emotion] || "#94a3b8");

  // Trend (simulate from session data)
  buildTrendChart(allSessions);

  // Confidence bar chart
  buildConfChart(labels, confs, colors);

  // Distribution doughnut
  buildDistChart(labels, counts, colors);
}

function buildTrendChart(sessions) {
  const ctx = document.getElementById("trendChart")?.getContext("2d");
  if (!ctx) return;
  if (trendChart) trendChart.destroy();

  // Group sessions by date, pick dominant emotion
  const grouped = {};
  sessions.forEach(s => {
    const d = s.start_time ? s.start_time.substring(0,10) : "Unknown";
    if (!grouped[d]) grouped[d] = {};
    if (s.dominant_emotion) {
      grouped[d][s.dominant_emotion] = (grouped[d][s.dominant_emotion]||0)+1;
    }
  });

  const dates  = Object.keys(grouped).sort().slice(-14);
  const emotions = ["happy","neutral","sad","angry","surprised","fearful","disgusted"];

  const datasets = emotions.map(em => ({
    label:           EMOTION_LABELS_MAP[em] || em,
    data:            dates.map(d => grouped[d]?.[em] || 0),
    borderColor:     EMOTION_COLORS[em],
    backgroundColor: EMOTION_COLORS[em] + "22",
    borderWidth:     2,
    tension:         0.4,
    fill:            false,
    pointRadius:     3,
  }));

  trendChart = new Chart(ctx, {
    type: "line",
    data: { labels: dates, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend:{ position:"bottom", labels:{ color:"#94a3b8", boxWidth:12 }}},
      scales: {
        x: { ticks:{color:"#94a3b8"}, grid:{color:"#1e2a3a"} },
        y: { ticks:{color:"#94a3b8"}, grid:{color:"#1e2a3a"}, beginAtZero:true },
      },
    },
  });
}

function buildConfChart(labels, confs, colors) {
  const ctx = document.getElementById("confidenceChart")?.getContext("2d");
  if (!ctx) return;
  if (confChart) confChart.destroy();
  confChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets:[{ label:"Avg Confidence %", data:confs,
                  backgroundColor:colors.map(c=>c+"99"), borderColor:colors, borderWidth:2 }],
    },
    options:{
      responsive:true, maintainAspectRatio:false,
      plugins:{legend:{display:false}},
      scales:{
        x:{ticks:{color:"#94a3b8"},grid:{color:"#1e2a3a"}},
        y:{ticks:{color:"#94a3b8"},grid:{color:"#1e2a3a"},beginAtZero:true,max:100},
      },
    },
  });
}

function buildDistChart(labels, counts, colors) {
  const ctx = document.getElementById("distributionChart")?.getContext("2d");
  if (!ctx) return;
  if (distChart) distChart.destroy();
  distChart = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels,
      datasets:[{ data:counts, backgroundColor:colors.map(c=>c+"cc"),
                  borderColor:colors, borderWidth:2 }],
    },
    options:{
      responsive:true, maintainAspectRatio:false,
      plugins:{ legend:{ position:"bottom", labels:{color:"#94a3b8", boxWidth:12} } },
    },
  });
}

function renderMockCharts() {
  // placeholder with FER2013 distribution
  const labels = ["Happy","Neutral","Sad","Angry","Fearful","Disgusted","Surprised"];
  const confs  = [82,75,78,71,69,65,80];
  const counts = [247,248,134,129,75,35,36];
  const colors = Object.values(EMOTION_COLORS);
  buildConfChart(labels, confs, colors);
  buildDistChart(labels, counts, colors);
  buildTrendChart([]);
}


// ═════════════════════════════════════════════════════════════════════════════
// SESSIONS TABLE
// ═════════════════════════════════════════════════════════════════════════════

function renderSessionsTable(sessions) {
  const tbody = document.getElementById("sessionsTable");
  if (!tbody) return;

  const start  = (currentPage-1)*PAGE_SIZE;
  const page   = sessions.slice(start, start+PAGE_SIZE);
  const total  = Math.ceil(sessions.length/PAGE_SIZE) || 1;

  document.getElementById("pageInfo")?.textContent && (
    document.getElementById("pageInfo").textContent = `Page ${currentPage} of ${total}`
  );

  tbody.innerHTML = page.map(s => {
    const date  = s.start_time ? new Date(s.start_time).toLocaleDateString() : "—";
    const dur   = s.duration_seconds ? formatDuration(s.duration_seconds) : "Active";
    const frames= s.total_frames ?? "—";
    const dom   = s.dominant_emotion || "—";
    const cfg   = EMOTION_COLORS[dom] || "#94a3b8";
    const conf  = s.emotion_distribution?.[dom]
                ? `${Math.round(s.emotion_distribution[dom]*100)}%` : "—";
    return `
      <tr>
        <td>${date}</td>
        <td>${dur}</td>
        <td>${frames}</td>
        <td><span style="color:${cfg};font-weight:600">${dom}</span></td>
        <td>${conf}</td>
      </tr>`;
  }).join("");
}

function renderMockSessions() {
  allSessions = Array.from({length:8},(_,i)=>({
    start_time:       new Date(Date.now()-i*86400000).toISOString(),
    duration_seconds: 120+Math.random()*600|0,
    total_frames:     80+Math.random()*200|0,
    dominant_emotion: ["happy","neutral","sad","angry","surprised"][i%5],
    emotion_distribution:{ happy:0.4,neutral:0.3,sad:0.1,angry:0.1,surprised:0.1 },
  }));
  renderSessionsTable(allSessions);
}

function formatDuration(s) {
  return s >= 3600 ? `${(s/3600).toFixed(1)}h`
       : s >= 60   ? `${Math.round(s/60)}m`
       : `${Math.round(s)}s`;
}


// ═════════════════════════════════════════════════════════════════════════════
// EXPORT
// ═════════════════════════════════════════════════════════════════════════════

function exportTable() {
  const hdr  = "date,duration,frames,emotion,confidence\n";
  const rows = allSessions.map(s => {
    const date = s.start_time ? new Date(s.start_time).toLocaleDateString() : "";
    const dur  = s.duration_seconds ? formatDuration(s.duration_seconds) : "";
    const dom  = s.dominant_emotion || "";
    const conf = s.emotion_distribution?.[dom]
               ? Math.round(s.emotion_distribution[dom]*100)+"%" : "";
    return `${date},${dur},${s.total_frames||""},${dom},${conf}`;
  }).join("\n");
  const blob = new Blob([hdr+rows],{type:"text/csv"});
  const a    = document.createElement("a");
  a.href     = URL.createObjectURL(blob);
  a.download = `emotiscan_sessions_${Date.now()}.csv`;
  a.click();
  showToast("Exported ✓");
}


// ═════════════════════════════════════════════════════════════════════════════
// INIT
// ═════════════════════════════════════════════════════════════════════════════

document.addEventListener("DOMContentLoaded", () => {
  loadDashboard();

  document.getElementById("refreshData")?.addEventListener("click", loadDashboard);
  document.getElementById("exportTable")?.addEventListener("click", exportTable);

  document.getElementById("prevPage")?.addEventListener("click", () => {
    if (currentPage > 1) { currentPage--; renderSessionsTable(allSessions); }
  });
  document.getElementById("nextPage")?.addEventListener("click", () => {
    const max = Math.ceil(allSessions.length/PAGE_SIZE)||1;
    if (currentPage < max) { currentPage++; renderSessionsTable(allSessions); }
  });

  document.getElementById("timeRange")?.addEventListener("change", e => {
    // Re-filter allSessions by time range
    const now = Date.now();
    const cutoffs = { today:86400000, week:604800000, month:2592000000, all:Infinity };
    const ms = cutoffs[e.target.value] || Infinity;
    const filtered = allSessions.filter(s => {
      if (!s.start_time) return true;
      return (now - new Date(s.start_time).getTime()) <= ms;
    });
    renderSessionsTable(filtered);
  });
});
