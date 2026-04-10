/**
 * dashboard.js — Analytics Dashboard
 * Pulls data from IndexedDB (primary) and backend API (secondary).
 * Renders KPI cards, trend/confidence/distribution charts, session table.
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

let trendChart, confChart, distChart;
let allSessions = [];
let allResults = [];
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

  // Merge data: prefer backend if available, supplement with local
  if (backendSessions?.sessions?.length > 0) {
    allSessions = backendSessions.sessions;
    // Also add local-only sessions
    const backendIds = new Set(allSessions.map(s => s.session_id));
    localStats.sessions.forEach(s => {
      if (!backendIds.has(s.session_id)) allSessions.push(s);
    });
  } else {
    allSessions = localStats.sessions;
  }

  allResults = localStats.results;

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
  // Total Sessions
  const totalSessions = Math.max(allSessions.length, localStats.totalSessions);
  setEl('totalSessions', totalSessions || '—');

  // Total Frames
  const backendFrames = backendStats?.total_frames || 0;
  const totalFrames = Math.max(backendFrames, localStats.totalFrames);
  setEl('totalFrames', totalFrames > 0 ? totalFrames.toLocaleString() : '—');

  // Average Confidence
  let avgConf = 0;
  if (backendStats?.stats?.length) {
    avgConf = Math.round(backendStats.stats.reduce((a, r) => a + r.avg_confidence, 0) / backendStats.stats.length * 100);
  } else if (localStats.avgConfidence > 0) {
    avgConf = Math.round(localStats.avgConfidence * 100);
  }
  setEl('avgConfidence', avgConf > 0 ? `${avgConf}%` : '—');

  // Dominant Emotion Accuracy (% of frames where top emotion > 50% confidence)
  let accurateCount = 0;
  let totalCount = 0;
  allResults.forEach(r => {
    (r.face_emotions || []).forEach(fe => {
      totalCount++;
      if (fe.confidence > 0.5) accurateCount++;
    });
  });
  const accuracy = totalCount > 0 ? Math.round((accurateCount / totalCount) * 100) : 0;
  setEl('avgDuration', accuracy > 0 ? `${accuracy}%` : '—');

  // Update change indicators dynamically
  updateChangeIndicator(totalSessions, totalFrames);
}

function updateChangeIndicator(sessions, frames) {
  // Calculate week-over-week changes from stored data
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
  // Use backend stats if available for emotion distribution
  const hasBackend = backendStats?.stats?.length > 0;

  if (hasBackend) {
    const rows = backendStats.stats;
    const labels = rows.map(r => EMOTION_LABELS_MAP[r.emotion] || r.emotion);
    const counts = rows.map(r => r.count);
    const confs = rows.map(r => Math.round(r.avg_confidence * 100));
    const colors = rows.map(r => EMOTION_COLORS[r.emotion] || '#94a3b8');
    buildConfChart(labels, confs, colors);
    buildDistChart(labels, counts, colors);
  } else if (Object.keys(localStats.emotionCounts).length > 0) {
    // Build from local data
    const entries = Object.entries(localStats.emotionCounts).sort((a, b) => b[1] - a[1]);
    const labels = entries.map(([em]) => EMOTION_LABELS_MAP[em] || em);
    const counts = entries.map(([, c]) => c);
    const colors = entries.map(([em]) => EMOTION_COLORS[em] || '#94a3b8');

    // Compute average confidence per emotion from local results
    const emotionConfs = {};
    const emotionConfCounts = {};
    allResults.forEach(r => {
      (r.face_emotions || []).forEach(fe => {
        const em = fe.emotion;
        emotionConfs[em] = (emotionConfs[em] || 0) + (fe.confidence || 0);
        emotionConfCounts[em] = (emotionConfCounts[em] || 0) + 1;
      });
    });
    const confs = entries.map(([em]) => {
      const total = emotionConfs[em] || 0;
      const count = emotionConfCounts[em] || 1;
      return Math.round((total / count) * 100);
    });

    buildConfChart(labels, confs, colors);
    buildDistChart(labels, counts, colors);
  } else {
    renderPlaceholderCharts();
  }

  // Trend chart from session data
  buildTrendChart(allSessions);
}

function buildTrendChart(sessions) {
  const canvasEl = document.getElementById('trendChart');
  if (!canvasEl) return;
  const ctxChart = canvasEl.getContext('2d');
  if (trendChart) trendChart.destroy();

  // Group sessions by date
  const grouped = {};
  sessions.forEach(s => {
    const d = s.start_time ? s.start_time.substring(0, 10) : 'Unknown';
    if (!grouped[d]) grouped[d] = {};
    const em = s.dominant_emotion;
    if (em) grouped[d][em] = (grouped[d][em] || 0) + 1;
  });

  // Also group from local results by date
  allResults.forEach(r => {
    const d = r.timestamp ? new Date(r.timestamp * 1000).toISOString().substring(0, 10) : null;
    if (!d) return;
    if (!grouped[d]) grouped[d] = {};
    (r.face_emotions || []).forEach(fe => {
      const em = fe.emotion;
      if (em) grouped[d][em] = (grouped[d][em] || 0) + 1;
    });
  });

  const dates = Object.keys(grouped).sort().slice(-14);
  const emotions = ['happy', 'neutral', 'sad', 'angry', 'surprised', 'fearful', 'disgusted'];

  if (dates.length === 0) {
    // Generate placeholder dates
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000).toISOString().substring(0, 10);
      dates.push(d);
    }
  }

  const datasets = emotions.map(em => ({
    label:           EMOTION_LABELS_MAP[em] || em,
    data:            dates.map(d => grouped[d]?.[em] || 0),
    borderColor:     EMOTION_COLORS[em],
    backgroundColor: EMOTION_COLORS[em] + '22',
    borderWidth:     2,
    tension:         0.4,
    fill:            false,
    pointRadius:     3,
    pointHoverRadius: 6,
  }));

  trendChart = new Chart(ctxChart, {
    type: 'line',
    data: { labels: dates.map(d => d.substring(5)), datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { color: '#94a3b8', boxWidth: 12, padding: 15, font: { family: 'Inter', size: 11 } } },
      },
      scales: {
        x: { ticks: { color: '#64748b', font: { size: 11 } }, grid: { color: 'rgba(148,163,184,0.1)' } },
        y: { ticks: { color: '#64748b', font: { size: 11 } }, grid: { color: 'rgba(148,163,184,0.1)' }, beginAtZero: true },
      },
      interaction: { mode: 'index', intersect: false },
    },
  });
}

function buildConfChart(labels, confs, colors) {
  const canvasEl = document.getElementById('confidenceChart');
  if (!canvasEl) return;
  const ctxChart = canvasEl.getContext('2d');
  if (confChart) confChart.destroy();
  confChart = new Chart(ctxChart, {
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
  const ctxChart = canvasEl.getContext('2d');
  if (distChart) distChart.destroy();
  distChart = new Chart(ctxChart, {
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
  const labels = ['Happy', 'Neutral', 'Sad', 'Angry', 'Fearful', 'Disgusted', 'Surprised'];
  const confs = [82, 75, 78, 71, 69, 65, 80];
  const counts = [247, 248, 134, 129, 75, 35, 36];
  const colors = Object.values(EMOTION_COLORS);
  buildConfChart(labels, confs, colors);
  buildDistChart(labels, counts, colors);
  buildTrendChart([]);
}


// ═════════════════════════════════════════════════════════════════════════════
// SESSIONS TABLE
// ═════════════════════════════════════════════════════════════════════════════

function renderSessionsTable(sessions) {
  const tbody = document.getElementById('sessionsTable');
  if (!tbody) return;

  const start = (currentPage - 1) * PAGE_SIZE;
  const page = sessions.slice(start, start + PAGE_SIZE);
  const total = Math.ceil(sessions.length / PAGE_SIZE) || 1;

  const pageInfo = document.getElementById('pageInfo');
  if (pageInfo) pageInfo.textContent = `Page ${currentPage} of ${total}`;

  if (page.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--text-secondary);padding:30px;">
      <i class="fas fa-inbox" style="font-size:2rem;display:block;margin-bottom:8px;opacity:0.5"></i>
      No sessions yet. Start a live analysis to see data here.
    </td></tr>`;
    return;
  }

  tbody.innerHTML = page.map(s => {
    const date = s.start_time ? new Date(s.start_time).toLocaleDateString() : '—';
    const dur = s.duration_seconds ? formatDuration(s.duration_seconds) : (s.status === 'active' ? '🔴 Active' : '—');
    const frames = s.total_frames ?? s.frame_count ?? '—';
    const dom = s.dominant_emotion || '—';
    const cfg = EMOTION_COLORS[dom] || '#94a3b8';
    const emotionLabel = EMOTION_LABELS_MAP[dom] || dom;
    const conf = s.emotion_distribution?.[dom]
      ? `${Math.round(s.emotion_distribution[dom] * 100)}%`
      : (s.emotion_counts ? '—' : '—');
    return `
      <tr>
        <td>${date}</td>
        <td>${dur}</td>
        <td>${frames}</td>
        <td><span style="color:${cfg};font-weight:600">${emotionLabel}</span></td>
        <td>${conf}</td>
      </tr>`;
  }).join('');
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
      const dur = s.duration_seconds ? formatDuration(s.duration_seconds) : '';
      const dom = s.dominant_emotion || '';
      const conf = s.emotion_distribution?.[dom]
        ? Math.round(s.emotion_distribution[dom] * 100) + '%' : '';
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

  // Chart type toggle
  document.querySelectorAll('.chart-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.chart-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      // Rebuild trend chart if type changed
      if (trendChart) {
        const type = btn.dataset.type;
        trendChart.data.datasets.forEach(ds => {
          ds.fill = type === 'area';
        });
        trendChart.update();
      }
    });
  });
});
