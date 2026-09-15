import re

with open('scripts/dashboard.js', 'r', encoding='utf-8') as f:
    content = f.read()

# Add global var for the new chart
content = content.replace('let trendChart, confChart, distChart;', 'let trendChart, confChart, distChart, sessionTrendChartObj;')

code_to_add = '''

// -----------------------------------------------------------------------------
// SESSION TREND (F6)
// -----------------------------------------------------------------------------

async function loadSessionTrend(sessionId, windowSec = 60) {
  if (!sessionId) return;
  showToast('Loading session trends...', 'info');
  try {
    const data = await apiFetch(/api/session//trends?window=);
    if (data && data.windows) {
      buildSessionTrendChart(data.windows);
      showToast('Session trends loaded ?');
    } else {
      showToast('No trend data found for this session', 'warn');
    }
  } catch (err) {
    showToast('Failed to load trends', 'error');
  }
}

function buildSessionTrendChart(windows) {
  const canvasEl = document.getElementById('sessionTrendChart');
  if (!canvasEl) return;
  const ctxChart = canvasEl.getContext('2d');
  if (sessionTrendChartObj) sessionTrendChartObj.destroy();
  
  if (!windows || windows.length === 0) {
    // Empty state
    return;
  }

  const labels = windows.map(w => w.label);
  const emotions = ['happy', 'neutral', 'sad', 'angry', 'surprised', 'fearful', 'disgusted'];
  
  const datasets = emotions.map(em => ({
    label: EMOTION_LABELS_MAP[em] || em,
    data: windows.map(w => w.avg_scores[em] || 0),
    borderColor: EMOTION_COLORS[em],
    backgroundColor: EMOTION_COLORS[em] + '80',
    fill: true,
    tension: 0.4,
    borderWidth: 1,
    pointRadius: 0,
    pointHoverRadius: 4,
  }));

  sessionTrendChartObj = new Chart(ctxChart, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { color: '#94a3b8', boxWidth: 12, padding: 15, font: { family: 'Inter', size: 11 } } },
        tooltip: { mode: 'index', intersect: false }
      },
      scales: {
        x: { ticks: { color: '#64748b', font: { size: 11 } }, grid: { color: 'rgba(148,163,184,0.1)' } },
        y: { 
          stacked: true, 
          max: 1.0, 
          ticks: { color: '#64748b', font: { size: 11 }, callback: (v) => Math.round(v*100) + '%' }, 
          grid: { color: 'rgba(148,163,184,0.1)' } 
        },
      },
      interaction: { mode: 'index', intersect: false },
    },
  });
}
'''

# Insert the code before the // INIT block
content = content.replace('// -----------------------------------------------------------------------------\n// INIT', code_to_add + '\n// -----------------------------------------------------------------------------\n// INIT')

init_code_to_add = '''
  document.getElementById('loadSessionTrendBtn')?.addEventListener('click', () => {
    const sid = document.getElementById('trendSessionId')?.value.trim();
    if (sid) loadSessionTrend(sid);
  });
'''

# Insert into DOMContentLoaded
content = content.replace("document.getElementById('refreshData')?.addEventListener('click', () => {", init_code_to_add + "\n  document.getElementById('refreshData')?.addEventListener('click', () => {")

with open('scripts/dashboard.js', 'w', encoding='utf-8') as f:
    f.write(content)
