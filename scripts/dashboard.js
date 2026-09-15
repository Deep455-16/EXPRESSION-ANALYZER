/**
 * dashboard.js — Analytics Dashboard
 * Pulls data from IndexedDB (primary) and backend API (secondary).
 * Renders KPI cards, trend/confidence/distribution charts, session table.
 *
 * Fixes (2024-09):
 *  - buildTrendChart now always renders visible data (uses IndexedDB results first)
 *  - Placeholder data uses realistic non-zero values so lines are visible
 *  - loadSessionTrend / buildSessionTrendChart fully implemented (was missing)
 *  - Latest session ID auto-filled into the trend input on load
 */

const BACKEND_URL = localStorage.getItem('backendUrl') || 'http://localhost:5000';

const EMOTION_COLORS = {
  happy: '#4ade80', sad: '#60a5fa', angry: '#f87171',
  surprised: '#34d399', fearful: '#a78bfa', disgusted: '#fb923c',
  neutral: '#94a3b8',
};
const EMOTION_LABELS_MAP = {
  happy: 'Happy', sad: 'Sad', angry: 'Angry', surprised: 'Surprised',
  fearful: 'Fearful', disgusted: 'Disgusted', neutral: 'Neutral',
};
const EMOTIONS_ORDER = ['happy', 'neutral', 'sad', 'angry', 'surprised', 'fearful', 'disgusted'];

let trendChart, confChart, distChart, sessionTrendChartObj;
let allSessions = [];
let allResults  = [];
let currentPage = 1;
const PAGE_SIZE = 10;


// ═════════════════════════════════════════════════════════════════════════════
// DATA LOADING
// ═════════════════════════════════════════════════════════════════════════════

async function apiFetch(path) {
  try {
    const r = await fetch(BACKEND_URL + path, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) throw new Error(r.status);
    return await r.json();
  } catch { return null; }
}

async function loadDashboard() {
  showToast('Loading dashboard data...', 'info');

  // 1. Load from IndexedDB (always available)
  let localStats;
  try {
    localStats = await EmotiDB.getStats();
  } catch {
    localStats = { totalSessions: 0, totalFrames: 0, avgConfidence: 0, emotionCounts: {}, sessions: [], results: [] };
  }

  // 2. Try backend API
  const [backendStats, backendSessions] = await Promise.all([
    apiFetch('/api/stats'),
    apiFetch('/api/sessions?limit=100'),
  ]);

  // Merge: prefer backend if available, supplement with local
  if (backendSessions?.sessions?.length > 0) {
    allSessions = backendSessions.sessions;
    const backendIds = new Set(allSessions.map(s => s.session_id));
    localStats.sessions.forEach(s => {
      if (!backendIds.has(s.session_id)) allSessions.push(s);
    });
  } else {
    allSessions = localStats.sessions || [];
  }

  allResults = localStats.results || [];

  // Auto-fill the trend session input with the latest known session_id
  const trendInput = document.getElementById('trendSessionId');
  if (trendInput && !trendInput.value) {
    const latestSession = allSessions[0] || null;
    if (latestSession?.session_id) {
      trendInput.value = latestSession.session_id;
      trendInput.title = `Latest session: ${latestSession.session_id}`;
    } else if (localStats.sessions?.length > 0) {
      trendInput.value = localStats.sessions[localStats.sessions.length - 1].session_id || '';
    }
  }

  // Render everything
  renderSummaryCards(localStats, backendStats);
  renderCharts(localStats, backendStats);
  renderSessionsTable(allSessions);

  showToast('Dashboard updated ✓');
}


// ═════════════════════════════════════════════════════════════════════════════
// SUMMARY CARDS (KPIs)
// ═════════════════════════════════════════════════════════════════════════════

function renderSummaryCards(localStats, backendStats) {
  const totalSessions = Math.max(allSessions.length, localStats.totalSessions || 0);
  setEl('totalSessions', totalSessions || '—');

  const backendFrames = backendStats?.total_frames || 0;
  const totalFrames = Math.max(backendFrames, localStats.totalFrames || 0);
  setEl('totalFrames', totalFrames > 0 ? totalFrames.toLocaleString() : '—');

  let avgConf = 0;
  if (backendStats?.stats?.length) {
    avgConf = Math.round(backendStats.stats.reduce((a, r) => a + r.avg_confidence, 0) / backendStats.stats.length * 100);
  } else if (localStats.avgConfidence > 0) {
    avgConf = Math.round(localStats.avgConfidence * 100);
  }
  setEl('avgConfidence', avgConf > 0 ? `${avgConf}%` : '—');

  let accurateCount = 0, totalCount = 0;
  allResults.forEach(r => {
    (r.face_emotions || []).forEach(fe => {
      totalCount++;
      if (fe.confidence > 0.5) accurateCount++;
    });
  });
  const accuracy = totalCount > 0 ? Math.round((accurateCount / totalCount) * 100) : 0;
  setEl('avgDuration', accuracy > 0 ? `${accuracy}%` : '—');

  updateChangeIndicator();
}

function updateChangeIndicator() {
  const now = Date.now();
  const weekAgo = now - 7 * 86400000;
  const thisWeek = allSessions.filter(s => {
    const t = s.start_time ? new Date(s.start_time).getTime() : 0;
    return t > weekAgo;
  }).length;
  const lastWeek = allSessions.filter(s => {
    const t = s.start_time ? new Date(s.start_time).getTime() : 0;
    return t > weekAgo - 7 * 86400000 && t <= weekAgo;
  }).length;

  const cards = document.querySelectorAll('.summary-change');
  if (cards[0] && thisWeek > 0) {
    const pct = lastWeek > 0 ? Math.round(((thisWeek - lastWeek) / lastWeek) * 100) : 100;
    const positive = pct >= 0;
    cards[0].className = `summary-change ${positive ? 'positive' : ''}`;
    cards[0].innerHTML = `<i class="fas fa-arrow-${positive ? 'up' : 'down'}"></i> ${positive ? '+' : ''}${pct}% this week`;
  }
}

function setEl(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}


// ═════════════════════════════════════════════════════════════════════════════
// CHARTS
// ═════════════════════════════════════════════════════════════════════════════

function renderCharts(localStats, backendStats) {
  const hasBackend = backendStats?.stats?.length > 0;

  if (hasBackend) {
    const rows = backendStats.stats;
    buildConfChart(
      rows.map(r => EMOTION_LABELS_MAP[r.emotion] || r.emotion),
      rows.map(r => Math.round(r.avg_confidence * 100)),
      rows.map(r => EMOTION_COLORS[r.emotion] || '#94a3b8')
    );
    buildDistChart(
      rows.map(r => EMOTION_LABELS_MAP[r.emotion] || r.emotion),
      rows.map(r => r.count),
      rows.map(r => EMOTION_COLORS[r.emotion] || '#94a3b8')
    );
  } else if (Object.keys(localStats.emotionCounts || {}).length > 0) {
    const entries = Object.entries(localStats.emotionCounts).sort((a, b) => b[1] - a[1]);
    const labels = entries.map(([em]) => EMOTION_LABELS_MAP[em] || em);
    const counts = entries.map(([, c]) => c);
    const colors = entries.map(([em]) => EMOTION_COLORS[em] || '#94a3b8');

    const emotionConfs = {}, emotionConfCounts = {};
    allResults.forEach(r => {
      (r.face_emotions || []).forEach(fe => {
        emotionConfs[fe.emotion] = (emotionConfs[fe.emotion] || 0) + (fe.confidence || 0);
        emotionConfCounts[fe.emotion] = (emotionConfCounts[fe.emotion] || 0) + 1;
      });
    });
    const confs = entries.map(([em]) => {
      const tot = emotionConfs[em] || 0;
      const cnt = emotionConfCounts[em] || 1;
      return Math.round((tot / cnt) * 100);
    });

    buildConfChart(labels, confs, colors);
    buildDistChart(labels, counts, colors);
  } else {
    renderPlaceholderCharts();
  }

  // Emotion Trends — always build from IndexedDB allResults first
  buildTrendChart(allSessions, allResults);
}

/**
 * buildTrendChart — auto-selects time bucket granularity:
 *   • Same day / ≤3 days of data  →  group by HOUR   (HH:00 labels)
 *   • >3 days of data             →  group by DATE   (MM-DD labels)
 *   • No real data                →  show realistic placeholder so lines are visible
 */
function buildTrendChart(sessions, results) {
  const canvasEl = document.getElementById('trendChart');
  if (!canvasEl) return;
  const ctxChart = canvasEl.getContext('2d');
  if (trendChart) trendChart.destroy();

  // Collect all timestamps (in ms) from both sources
  const timestamps = [];
  (sessions || []).forEach(s => {
    if (s.start_time) timestamps.push(new Date(s.start_time).getTime());
  });
  (results || []).forEach(r => {
    if (r.timestamp) timestamps.push(r.timestamp * 1000);
  });

  const hasRealData = timestamps.length > 0;

  if (!hasRealData) {
    // Placeholder: realistic non-zero sample across 7 synthetic days
    const sampleByEm = {
      happy:     [12, 15, 10, 18, 22, 14, 20],
      neutral:   [20, 18, 22, 15, 17, 25, 18],
      sad:       [5,  8,  6,  4,  7,  5,  6],
      angry:     [3,  4,  2,  5,  3,  4,  3],
      surprised: [4,  3,  5,  6,  4,  3,  5],
      fearful:   [2,  1,  3,  2,  1,  2,  2],
      disgusted: [1,  2,  1,  1,  2,  1,  1],
    };
    const labels = [];
    const grouped = {};
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000).toISOString().substring(5, 10);
      labels.push(d);
      grouped[d] = {};
      EMOTIONS_ORDER.forEach(em => { grouped[d][em] = sampleByEm[em]?.[6 - i] || 0; });
    }
    _renderTrendChart(ctxChart, labels, grouped, false);
    return;
  }

  // Decide granularity based on data span
  const minTs = Math.min(...timestamps);
  const maxTs = Math.max(...timestamps);
  const spanDays = (maxTs - minTs) / 86400000;
  const useHourly = spanDays <= 3;

  const grouped = {};

  if (useHourly) {
    // Group by hour: key = "HH:00"
    const bucket = ts => {
      const d = new Date(ts);
      return `${String(d.getHours()).padStart(2,'0')}:00`;
    };
    (sessions || []).forEach(s => {
      if (!s.start_time) return;
      const k = bucket(new Date(s.start_time).getTime());
      if (!grouped[k]) grouped[k] = {};
      const em = s.dominant_emotion;
      if (em) grouped[k][em] = (grouped[k][em] || 0) + 1;
    });
    (results || []).forEach(r => {
      if (!r.timestamp) return;
      const k = bucket(r.timestamp * 1000);
      if (!grouped[k]) grouped[k] = {};
      (r.face_emotions || []).forEach(fe => {
        if (fe.emotion) grouped[k][fe.emotion] = (grouped[k][fe.emotion] || 0) + 1;
      });
    });
  } else {
    // Group by date: key = "MM-DD"
    const bucket = ts => new Date(ts).toISOString().substring(5, 10);
    (sessions || []).forEach(s => {
      if (!s.start_time) return;
      const k = bucket(new Date(s.start_time).getTime());
      if (!grouped[k]) grouped[k] = {};
      const em = s.dominant_emotion;
      if (em) grouped[k][em] = (grouped[k][em] || 0) + 1;
    });
    (results || []).forEach(r => {
      if (!r.timestamp) return;
      const k = bucket(r.timestamp * 1000);
      if (!grouped[k]) grouped[k] = {};
      (r.face_emotions || []).forEach(fe => {
        if (fe.emotion) grouped[k][fe.emotion] = (grouped[k][fe.emotion] || 0) + 1;
      });
    });
  }

  const labels = Object.keys(grouped).sort().slice(-48); // max 48 buckets
  _renderTrendChart(ctxChart, labels, grouped, true);
}

function _renderTrendChart(ctxChart, labels, grouped, hasRealData) {
  const datasets = EMOTIONS_ORDER.map(em => ({
    label:            EMOTION_LABELS_MAP[em] || em,
    data:             labels.map(l => grouped[l]?.[em] || 0),
    borderColor:      EMOTION_COLORS[em],
    backgroundColor:  EMOTION_COLORS[em] + '33',
    borderWidth:      hasRealData ? 2.5 : 2,
    tension:          0.4,
    fill:             false,
    pointRadius:      labels.length <= 8 ? 5 : labels.length <= 24 ? 3 : 1,
    pointHoverRadius: 7,
  }));

  trendChart = new Chart(ctxChart, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { color: '#94a3b8', boxWidth: 12, padding: 15, font: { family: 'Inter', size: 11 } } },
        tooltip: { mode: 'index', intersect: false },
      },
      scales: {
        x: { ticks: { color: '#64748b', font: { size: 11 }, maxRotation: 45 }, grid: { color: 'rgba(148,163,184,0.1)' } },
        y: { ticks: { color: '#64748b', font: { size: 11 } }, grid: { color: 'rgba(148,163,184,0.1)' }, beginAtZero: true },
      },
      interaction: { mode: 'index', intersect: false },
    },
  });
}

function buildConfChart(labels, confs, colors) {
  const canvasEl = document.getElementById('confidenceChart');
  if (!canvasEl) return;
  if (confChart) confChart.destroy();
  confChart = new Chart(canvasEl.getContext('2d'), {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Avg Confidence %', data: confs,
        backgroundColor: colors.map(c => c + '80'), borderColor: colors, borderWidth: 2, borderRadius: 6,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: '#64748b', font: { size: 11 } }, grid: { color: 'rgba(148,163,184,0.1)' } },
        y: { ticks: { color: '#64748b', font: { size: 11 } }, grid: { color: 'rgba(148,163,184,0.1)' }, beginAtZero: true, max: 100 },
      },
    },
  });
}

function buildDistChart(labels, counts, colors) {
  const canvasEl = document.getElementById('distributionChart');
  if (!canvasEl) return;
  if (distChart) distChart.destroy();
  distChart = new Chart(canvasEl.getContext('2d'), {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data: counts, backgroundColor: colors.map(c => c + 'cc'),
        borderColor: 'rgba(15,23,42,0.8)', borderWidth: 2, hoverOffset: 8,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { color: '#94a3b8', boxWidth: 12, padding: 12, font: { family: 'Inter', size: 11 } } },
      },
      cutout: '65%',
    },
  });
}

function renderPlaceholderCharts() {
  const labels = ['Happy', 'Neutral', 'Sad', 'Angry', 'Surprised', 'Fearful', 'Disgusted'];
  const confs  = [82, 75, 78, 71, 80, 69, 65];
  const counts = [247, 248, 134, 129, 36, 75, 35];
  const colors = EMOTIONS_ORDER.map(em => EMOTION_COLORS[em]);
  buildConfChart(labels, confs, colors);
  buildDistChart(labels, counts, colors);
  buildTrendChart([], []);  // will render sample data
}


// ═════════════════════════════════════════════════════════════════════════════
// SESSION TIMELINE (F6) — loadSessionTrend + buildSessionTrendChart
// ═════════════════════════════════════════════════════════════════════════════

async function loadSessionTrend(sessionId, windowSec = 60) {
  if (!sessionId) {
    showToast('Please enter a session ID', 'warn');
    return;
  }

  showToast('Loading session trends...', 'info');

  // First try backend endpoint
  const data = await apiFetch(`/api/session/${encodeURIComponent(sessionId)}/trends?window=${windowSec}`);

  if (data && Array.isArray(data.windows) && data.windows.length > 0) {
    buildSessionTrendChart(data.windows, sessionId);
    showToast(`Session trends loaded — ${data.windows.length} time windows ✓`);
    return;
  }

  // Backend offline or no data — try to reconstruct from IndexedDB
  try {
    const localResults = await EmotiDB.getResults(sessionId, 1000);
    if (localResults && localResults.length > 0) {
      const windows = aggregateLocalResults(localResults, windowSec);
      if (windows.length > 0) {
        buildSessionTrendChart(windows, sessionId + ' (local)');
        showToast(`Session trends loaded from local data — ${windows.length} windows ✓`);
        return;
      }
    }
  } catch (e) {
    console.warn('[dashboard] IndexedDB session lookup failed:', e);
  }

  // Nothing found
  showToast('No trend data found for this session. Run a live session first.', 'warn');
  buildSessionTrendChart([], sessionId);
}

/**
 * Aggregates an array of IndexedDB result records into time windows.
 */
function aggregateLocalResults(results, windowSec) {
  if (!results.length) return [];
  const sorted = [...results].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  const startTs = sorted[0].timestamp || 0;
  const winMap  = {};

  for (const r of sorted) {
    const elapsed = (r.timestamp || 0) - startTs;
    const idx     = Math.floor(elapsed / windowSec);
    if (!winMap[idx]) winMap[idx] = { scores_sum: {}, count: 0, faces: 0 };
    const wd = winMap[idx];
    wd.count++;
    const faces = r.face_emotions || [];
    if (faces.length > 0) {
      wd.faces++;
      const scores = faces[0].scores || {};
      for (const [em, v] of Object.entries(scores)) {
        wd.scores_sum[em] = (wd.scores_sum[em] || 0) + v;
      }
    }
  }

  return Object.entries(winMap).sort((a, b) => +a[0] - +b[0]).map(([idxStr, wd]) => {
    const idx    = +idxStr;
    const winSec = idx * windowSec;
    const mm     = Math.floor(winSec / 60).toString().padStart(2, '0');
    const ss     = (winSec % 60).toString().padStart(2, '0');
    const avg_scores = {};
    if (wd.faces > 0) {
      for (const [em, total] of Object.entries(wd.scores_sum)) {
        avg_scores[em] = Math.round((total / wd.faces) * 10000) / 10000;
      }
    }
    const dominant = Object.keys(avg_scores).length
      ? Object.entries(avg_scores).sort((a, b) => b[1] - a[1])[0][0]
      : 'neutral';
    return { t: winSec, label: `${mm}:${ss}`, avg_scores, dominant, frame_count: wd.count };
  });
}

function buildSessionTrendChart(windows, sessionId) {
  const canvasEl = document.getElementById('sessionTrendChart');
  if (!canvasEl) return;
  const ctxChart = canvasEl.getContext('2d');
  if (sessionTrendChartObj) sessionTrendChartObj.destroy();

  // Update subtitle
  const subtitle = document.getElementById('sessionTrendSubtitle');
  if (subtitle) subtitle.textContent = sessionId ? `Session: ${sessionId}` : '';

  if (!windows || windows.length === 0) {
    // Draw empty-state message on canvas
    ctxChart.clearRect(0, 0, canvasEl.width, canvasEl.height);
    ctxChart.fillStyle = '#64748b';
    ctxChart.font = '14px Inter, sans-serif';
    ctxChart.textAlign = 'center';
    ctxChart.fillText('No data. Enter a session ID and click Load.', canvasEl.width / 2, canvasEl.height / 2);
    return;
  }

  const labels   = windows.map(w => w.label);
  const datasets = EMOTIONS_ORDER.map(em => ({
    label:           EMOTION_LABELS_MAP[em] || em,
    data:            windows.map(w => (w.avg_scores[em] || 0) * 100),  // convert to %
    borderColor:     EMOTION_COLORS[em],
    backgroundColor: EMOTION_COLORS[em] + '55',
    fill:            true,
    tension:         0.4,
    borderWidth:     1.5,
    pointRadius:     windows.length < 20 ? 3 : 0,
    pointHoverRadius: 5,
  }));

  sessionTrendChartObj = new Chart(ctxChart, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { color: '#94a3b8', boxWidth: 12, padding: 12, font: { family: 'Inter', size: 11 } } },
        tooltip: {
          mode: 'index', intersect: false,
          callbacks: {
            label: ctx => `${ctx.dataset.label}: ${ctx.parsed.y.toFixed(1)}%`,
          },
        },
      },
      scales: {
        x: { ticks: { color: '#64748b', font: { size: 11 } }, grid: { color: 'rgba(148,163,184,0.1)' } },
        y: {
          stacked: false,
          min: 0,
          max: 100,
          ticks: { color: '#64748b', font: { size: 11 }, callback: v => v + '%' },
          grid: { color: 'rgba(148,163,184,0.1)' },
        },
      },
      interaction: { mode: 'index', intersect: false },
    },
  });
}


// ═════════════════════════════════════════════════════════════════════════════
// SESSIONS TABLE
// ═════════════════════════════════════════════════════════════════════════════

function renderSessionsTable(sessions) {
  const tbody = document.getElementById('sessionsTable');
  if (!tbody) return;

  const start = (currentPage - 1) * PAGE_SIZE;
  const page  = sessions.slice(start, start + PAGE_SIZE);
  const total = Math.ceil(sessions.length / PAGE_SIZE) || 1;

  const pageInfo = document.getElementById('pageInfo');
  if (pageInfo) pageInfo.textContent = `Page ${currentPage} of ${total}`;

  if (page.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--text-secondary);padding:30px;">
      <i class="fas fa-inbox" style="font-size:2rem;display:block;margin-bottom:8px;opacity:0.5"></i>
      No sessions yet. Start a live analysis to see data here.
    </td></tr>`;
    return;
  }

  tbody.innerHTML = page.map(s => {
    const date  = s.start_time ? new Date(s.start_time).toLocaleDateString() : '—';
    const dur   = s.duration_seconds ? formatDuration(s.duration_seconds) : (s.status === 'active' ? '🔴 Active' : '—');
    const frames = s.total_frames ?? s.frame_count ?? '—';
    const dom   = s.dominant_emotion || '—';
    const color = EMOTION_COLORS[dom] || '#94a3b8';
    const emotionLabel = EMOTION_LABELS_MAP[dom] || dom;
    const conf  = s.emotion_distribution?.[dom]
      ? `${Math.round(s.emotion_distribution[dom] * 100)}%` : '—';
    const sid   = s.session_id || '';
    return `
      <tr>
        <td>${date}</td>
        <td>${dur}</td>
        <td>${frames}</td>
        <td><span style="color:${color};font-weight:600">${emotionLabel}</span></td>
        <td>${conf}</td>
        <td><button class="btn btn-sm btn-secondary" onclick="fillTrendSession('${sid}')" title="Load timeline for this session"><i class="fas fa-chart-area"></i></button></td>
      </tr>`;
  }).join('');
}

/** Called from session table row — fills the trend input and loads */
function fillTrendSession(sessionId) {
  const input = document.getElementById('trendSessionId');
  if (input) input.value = sessionId;
  loadSessionTrend(sessionId);
  document.getElementById('sessionTrendChart')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function formatDuration(s) {
  return s >= 3600 ? `${(s / 3600).toFixed(1)}h`
    : s >= 60 ? `${Math.round(s / 60)}m`
    : `${Math.round(s)}s`;
}


// ═════════════════════════════════════════════════════════════════════════════
// EXPORT
// ═════════════════════════════════════════════════════════════════════════════

function exportTable() {
  if (!allSessions.length) { showToast('No data to export', 'warn'); return; }
  const fmt = settings.get('exportFormat') || 'csv';

  if (fmt === 'csv') {
    const headers = ['date', 'duration', 'frames', 'emotion', 'confidence', 'status'];
    const rows = allSessions.map(s => {
      const date = s.start_time ? new Date(s.start_time).toLocaleDateString() : '';
      const dur  = s.duration_seconds ? formatDuration(s.duration_seconds) : '';
      const dom  = s.dominant_emotion || '';
      const conf = s.emotion_distribution?.[dom] ? Math.round(s.emotion_distribution[dom] * 100) + '%' : '';
      return [date, dur, s.total_frames || '', dom, conf, s.status || ''];
    });
    exportToCSV(headers, rows, `emotiscan_sessions_${Date.now()}.csv`);
  } else {
    exportToJSON({
      exported_at: new Date().toISOString(),
      total_sessions: allSessions.length,
      sessions: allSessions,
    }, `emotiscan_sessions_${Date.now()}.json`);
  }
  showToast('Exported ✓');
}


// ═════════════════════════════════════════════════════════════════════════════
// INIT
// ═════════════════════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
  loadDashboard();

  // Session trend load button
  document.getElementById('loadSessionTrendBtn')?.addEventListener('click', () => {
    const sid = document.getElementById('trendSessionId')?.value.trim();
    loadSessionTrend(sid);
  });

  // Also allow Enter key in the input
  document.getElementById('trendSessionId')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      loadSessionTrend(e.target.value.trim());
    }
  });

  document.getElementById('refreshData')?.addEventListener('click', () => {
    currentPage = 1;
    loadDashboard();
  });
  document.getElementById('exportTable')?.addEventListener('click', exportTable);

  document.getElementById('prevPage')?.addEventListener('click', () => {
    if (currentPage > 1) { currentPage--; renderSessionsTable(allSessions); }
  });
  document.getElementById('nextPage')?.addEventListener('click', () => {
    const max = Math.ceil(allSessions.length / PAGE_SIZE) || 1;
    if (currentPage < max) { currentPage++; renderSessionsTable(allSessions); }
  });

  document.getElementById('timeRange')?.addEventListener('change', e => {
    const now = Date.now();
    const cutoffs = { today: 86400000, week: 604800000, month: 2592000000, all: Infinity };
    const ms = cutoffs[e.target.value] || Infinity;
    const filtered = allSessions.filter(s => {
      if (!s.start_time) return true;
      return (now - new Date(s.start_time).getTime()) <= ms;
    });
    currentPage = 1;
    renderSessionsTable(filtered);
  });

  // Chart Line / Area toggle for the Emotion Trends chart
  document.querySelectorAll('.chart-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.chart-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      if (trendChart) {
        const isFill = btn.dataset.type === 'area';
        trendChart.data.datasets.forEach(ds => { ds.fill = isFill; });
        trendChart.update();
      }
    });
  });
});
