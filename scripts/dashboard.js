// ========================================
// Dashboard Page - JavaScript
// ========================================

// let trendChart = null; // Removed trend chart
let distributionChart = null;
let confidenceChart = null;
let comparisonChart = null;
let currentPage = 1;
let sessionsData = [];

// ========================================
// Initialize Page
// ========================================

document.addEventListener('DOMContentLoaded', () => {
  initializeDashboard();
  setupDashboardListeners();
  loadDashboardData();
});

function initializeDashboard() {
  initializeCharts();
  generateHeatmap();
}

function setupDashboardListeners() {
  document.getElementById('timeRange')?.addEventListener('change', (e) => {
    loadDashboardData(e.target.value);
  });
  
  document.getElementById('refreshData')?.addEventListener('click', () => {
    loadDashboardData();
  });
  
  document.getElementById('exportTable')?.addEventListener('click', exportTableData);
  document.getElementById('prevPage')?.addEventListener('click', () => changePage(-1));
  document.getElementById('nextPage')?.addEventListener('click', () => changePage(1));
  
  // Chart type toggles
  document.querySelectorAll('.chart-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const chartType = e.target.dataset.chart;
      toggleChartType(chartType);
      
      // Update active state
      e.target.parentElement.querySelectorAll('.chart-btn').forEach(b => {
        b.classList.remove('active');
      });
      e.target.classList.add('active');
    });
  });
}

// ========================================
// Load Data
// ========================================

function loadDashboardData(timeRange = 'week') {
  // Load sessions from storage
  const allSessions = storage.load('sessions') || [];
  
  // Filter by time range
  const now = Date.now();
  const ranges = {
    today: 24 * 60 * 60 * 1000,
    week: 7 * 24 * 60 * 60 * 1000,
    month: 30 * 24 * 60 * 60 * 1000,
    all: Infinity
  };
  
  const cutoff = now - (ranges[timeRange] || ranges.week);
  sessionsData = allSessions.filter(s => new Date(s.startTime).getTime() > cutoff);
  
  // Always add mock data for demonstration
  if (sessionsData.length < 10) {
    sessionsData = generateMockSessions(15);
  }
  
  updateSummaryCards();
  updateCharts();
  updateTable();
  generateInsights();
}

function generateMockSessions(count) {
  const sessions = [];
  const now = Date.now();
  
  for (let i = 0; i < count; i++) {
    const hoursAgo = Math.random() * 168; // Up to a week ago
    const startTime = new Date(now - hoursAgo * 60 * 60 * 1000);
    const duration = Math.floor(Math.random() * 300) + 60; // 1-6 minutes
    const frameCount = Math.floor(duration / 2) + Math.floor(Math.random() * 50);
    
    const emotions = {};
    let total = 0;
    EMOTIONS.forEach(e => {
      const value = Math.random() * 30 + 20;
      emotions[e] = value;
      total += value;
    });
    
    // Normalize to 100
    EMOTIONS.forEach(e => {
      emotions[e] = Math.round((emotions[e] / total) * 100);
    });
    
    const dominantEmotion = Object.keys(emotions).reduce((a, b) => 
      emotions[a] > emotions[b] ? a : b
    );
    
    sessions.push({
      id: Date.now() + i,
      startTime: startTime.toISOString(),
      duration: duration,
      frameCount: frameCount,
      dominantEmotion: dominantEmotion,
      avgConfidence: Math.floor(Math.random() * 20) + 70,
      emotions: emotions
    });
  }
  
  return sessions.sort((a, b) => new Date(b.startTime) - new Date(a.startTime));
}

// ========================================
// Summary Cards
// ========================================

function updateSummaryCards() {
  const totalSessions = sessionsData.length;
  const totalFrames = sessionsData.reduce((sum, s) => sum + s.frameCount, 0);
  const avgDuration = totalSessions > 0 ? 
    Math.floor(sessionsData.reduce((sum, s) => sum + s.duration, 0) / totalSessions / 60) : 0;
  
  // Find dominant emotion across all sessions
  const emotionCounts = {};
  EMOTIONS.forEach(e => emotionCounts[e] = 0);
  
  sessionsData.forEach(s => {
    if (s.stats && s.stats.dominant) {
      emotionCounts[s.stats.dominant]++;
    }
  });
  
  const dominantEmotion = Object.keys(emotionCounts).reduce((a, b) => 
    emotionCounts[a] > emotionCounts[b] ? a : b
  );
  
  document.getElementById('totalSessions').textContent = totalSessions;
  document.getElementById('totalFrames').textContent = totalFrames.toLocaleString();
  document.getElementById('avgDuration').textContent = avgDuration + 'm';
  document.getElementById('dominantEmotion').textContent = 
    dominantEmotion.charAt(0).toUpperCase() + dominantEmotion.slice(1);
}

// ========================================
// Charts
// ========================================

function initializeCharts() {
  // Trend Chart - Line Chart
  const trendCtx = document.getElementById('trendChart');
  if (trendCtx) {
    trendChart = new Chart(trendCtx, {
      type: 'line',
      data: {
        labels: [],
        datasets: []
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'top',
            labels: {
              color: '#1e293b',
              font: {
                size: 13,
                weight: '600',
                family: "'Inter', sans-serif"
              },
              padding: 15,
              usePointStyle: true,
              pointStyle: 'circle'
            }
          },
          tooltip: {
            backgroundColor: 'rgba(30, 41, 59, 0.95)',
            titleColor: '#ffffff',
            bodyColor: '#ffffff',
            padding: 12,
            titleFont: {
              size: 14,
              weight: 'bold'
            },
            bodyFont: {
              size: 13
            },
            borderColor: 'rgba(255, 255, 255, 0.2)',
            borderWidth: 1,
            displayColors: true
          }
        },
        scales: {
          y: {
            beginAtZero: true,
            max: 100,
            ticks: {
              font: {
                size: 12,
                weight: '600',
                family: "'Inter', sans-serif"
              },
              color: '#475569'
            },
            grid: {
              color: 'rgba(0, 0, 0, 0.06)',
              drawBorder: false
            }
          },
          x: {
            ticks: {
              font: {
                size: 12,
                weight: '600',
                family: "'Inter', sans-serif"
              },
              color: '#1e293b'
            },
            grid: {
              display: false,
              drawBorder: false
            }
          }
        }
      }
    });
  }
  
  // Distribution Chart - Pie Chart
  const distributionCtx = document.getElementById('distributionChart');
  if (distributionCtx) {
    distributionChart = new Chart(distributionCtx, {
      type: 'pie',
      data: {
        labels: EMOTIONS.map(e => e.charAt(0).toUpperCase() + e.slice(1)),
        datasets: [{
          data: [],
          backgroundColor: EMOTIONS.map(e => getEmotionColor(e, 0.8)),
          borderColor: EMOTIONS.map(e => getEmotionColor(e)),
          borderWidth: 3
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'right',
            labels: {
              color: '#1e293b',
              font: {
                size: 13,
                weight: '600',
                family: "'Inter', sans-serif"
              },
              padding: 12,
              usePointStyle: true,
              pointStyle: 'circle'
            }
          },
          tooltip: {
            backgroundColor: 'rgba(30, 41, 59, 0.95)',
            titleColor: '#ffffff',
            bodyColor: '#ffffff',
            padding: 12,
            titleFont: {
              size: 14,
              weight: 'bold'
            },
            bodyFont: {
              size: 13
            },
            borderColor: 'rgba(255, 255, 255, 0.2)',
            borderWidth: 1
          }
        }
      }
    });
  }
  
  // Confidence Chart - Bar Chart
  const confidenceCtx = document.getElementById('confidenceChart');
  if (confidenceCtx) {
    confidenceChart = new Chart(confidenceCtx, {
      type: 'bar',
      data: {
        labels: ['Happy', 'Sad', 'Angry', 'Surprised', 'Fear', 'Disgust', 'Neutral'],
        datasets: [{
          label: 'Average Confidence %',
          data: [85, 72, 65, 78, 58, 62, 88],
          backgroundColor: [
            'rgba(16, 185, 129, 0.8)',
            'rgba(59, 130, 246, 0.8)',
            'rgba(239, 68, 68, 0.8)',
            'rgba(251, 191, 36, 0.8)',
            'rgba(139, 92, 246, 0.8)',
            'rgba(245, 158, 11, 0.8)',
            'rgba(107, 114, 128, 0.8)'
          ],
          borderColor: [
            'rgb(16, 185, 129)',
            'rgb(59, 130, 246)',
            'rgb(239, 68, 68)',
            'rgb(251, 191, 36)',
            'rgb(139, 92, 246)',
            'rgb(245, 158, 11)',
            'rgb(107, 114, 128)'
          ],
          borderWidth: 2,
          borderRadius: 8,
          barThickness: 40
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: false
          },
          tooltip: {
            backgroundColor: 'rgba(30, 41, 59, 0.95)',
            titleColor: '#ffffff',
            bodyColor: '#ffffff',
            padding: 12,
            titleFont: {
              size: 14,
              weight: 'bold'
            },
            bodyFont: {
              size: 13
            },
            borderColor: 'rgba(255, 255, 255, 0.2)',
            borderWidth: 1,
            callbacks: {
              label: function(context) {
                return 'Confidence: ' + context.parsed.y + '%';
              }
            }
          }
        },
        scales: {
          y: {
            beginAtZero: true,
            max: 100,
            ticks: {
              callback: function(value) {
                return value + '%';
              },
              font: {
                size: 13,
                weight: '600',
                family: "'Inter', sans-serif"
              },
              color: '#475569'
            },
            grid: {
              color: 'rgba(0, 0, 0, 0.06)',
              drawBorder: false
            }
          },
          x: {
            ticks: {
              font: {
                size: 13,
                weight: '600',
                family: "'Inter', sans-serif"
              },
              color: '#1e293b'
            },
            grid: {
              display: false,
              drawBorder: false
            }
          }
        },
        animation: {
          duration: 1000,
          easing: 'easeInOutQuart'
        }
      }
    });
  }
}function updateCharts() {
  updateTrendChart();
  updateDistributionChart();
  updateConfidenceChart();
  updateComparisonChart();
}

function updateTrendChart() {
  if (!trendChart) return;
  
  // Generate time-based data for the last 7 days
  const labels = [];
  const now = new Date();
  for (let i = 6; i >= 0; i--) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    labels.push(date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
  }
  
  // Generate realistic trend data for each emotion
  const datasets = EMOTIONS.map(emotion => {
    const baseValue = 30 + Math.random() * 40;
    const data = labels.map((_, index) => {
      const variation = (Math.random() - 0.5) * 20;
      const trend = (index / labels.length) * (Math.random() - 0.5) * 30;
      return Math.max(10, Math.min(90, baseValue + variation + trend));
    });
    
    return {
      label: emotion.charAt(0).toUpperCase() + emotion.slice(1),
      data: data,
      borderColor: getEmotionColor(emotion),
      backgroundColor: getEmotionColor(emotion, 0.1),
      tension: 0.4,
      fill: true,
      borderWidth: 3,
      pointRadius: 4,
      pointHoverRadius: 6,
      pointBackgroundColor: getEmotionColor(emotion),
      pointBorderColor: '#fff',
      pointBorderWidth: 2
    };
  });
  
  trendChart.data.labels = labels;
  trendChart.data.datasets = datasets;
  trendChart.update();
}

function updateDistributionChart() {
  if (!distributionChart) return;
  
  // Calculate emotion distribution from sessions
  const emotionCounts = {};
  EMOTIONS.forEach(e => emotionCounts[e] = 0);
  
  sessionsData.forEach(session => {
    if (session.emotions) {
      EMOTIONS.forEach(e => {
        emotionCounts[e] += session.emotions[e] || 0;
      });
    }
  });
  
  const data = EMOTIONS.map(e => emotionCounts[e]);
  
  distributionChart.data.datasets[0].data = data;
  distributionChart.update();
}

function updateConfidenceChart() {
  if (!confidenceChart) return;
  
  // Calculate average confidence per emotion
  const emotionConfidence = {};
  const emotionCount = {};
  
  EMOTIONS.forEach(e => {
    emotionConfidence[e] = 0;
    emotionCount[e] = 0;
  });
  
  sessionsData.forEach(session => {
    const emotion = session.dominantEmotion;
    if (emotionConfidence[emotion] !== undefined) {
      emotionConfidence[emotion] += session.avgConfidence;
      emotionCount[emotion]++;
    }
  });
  
  const data = EMOTIONS.map(e => {
    return emotionCount[e] > 0 
      ? Math.round(emotionConfidence[e] / emotionCount[e])
      : 0;
  });
  
  confidenceChart.data.datasets[0].data = data;
  confidenceChart.update();
}

// function updateTrendChart() { ... } // Removed trend chart

function updateDistributionChart() {
  if (!distributionChart) return;
  
  const emotionCounts = {};
  EMOTIONS.forEach(e => emotionCounts[e] = 0);
  
  sessionsData.forEach(session => {
    if (session.stats && session.stats.dominant) {
      emotionCounts[session.stats.dominant]++;
    }
  });
  
  distributionChart.data.datasets[0].data = EMOTIONS.map(e => emotionCounts[e]);
  distributionChart.update();
}

function updateConfidenceChart() {
  if (!confidenceChart) return;
  
  const labels = sessionsData.slice(0, 10).map((s, i) => `Session ${sessionsData.length - i}`);
  const data = sessionsData.slice(0, 10).map(s => s.stats?.avgConfidence || 0);
  
  confidenceChart.data.labels = labels.reverse();
  confidenceChart.data.datasets[0].data = data.reverse();
  confidenceChart.update();
}

function updateComparisonChart() {
  if (!comparisonChart || sessionsData.length < 2) return;
  
  // Compare last 3 sessions
  const recentSessions = sessionsData.slice(0, 3);
  
  comparisonChart.data.datasets = recentSessions.map((session, i) => {
    // Calculate average emotions for session
    const avgEmotions = {};
    EMOTIONS.forEach(e => avgEmotions[e] = 0);
    
    if (session.data) {
      session.data.forEach(frame => {
        Object.entries(frame.emotions).forEach(([emotion, value]) => {
          avgEmotions[emotion] += value;
        });
      });
      
      Object.keys(avgEmotions).forEach(e => {
        avgEmotions[e] = Math.round(avgEmotions[e] / session.data.length);
      });
    }
    
    return {
      label: `Session ${sessionsData.length - i}`,
      data: EMOTIONS.map(e => avgEmotions[e]),
      borderColor: getEmotionColor(EMOTIONS[i % EMOTIONS.length]),
      backgroundColor: getEmotionColor(EMOTIONS[i % EMOTIONS.length], 0.1),
      pointBackgroundColor: getEmotionColor(EMOTIONS[i % EMOTIONS.length]),
      borderWidth: 2
    };
  });
  
  comparisonChart.update();
}

// function toggleChartType(type) { ... } // Removed trend chart

function getEmotionColor(emotion, alpha = 1) {
  const colors = {
    happy: `rgba(16, 185, 129, ${alpha})`,
    sad: `rgba(59, 130, 246, ${alpha})`,
    angry: `rgba(239, 68, 68, ${alpha})`,
    surprised: `rgba(245, 158, 11, ${alpha})`,
    fear: `rgba(139, 92, 246, ${alpha})`,
    disgust: `rgba(236, 72, 153, ${alpha})`,
    neutral: `rgba(107, 114, 128, ${alpha})`
  };
  return colors[emotion] || `rgba(110, 231, 183, ${alpha})`;
}

// ========================================
// Heatmap
// ========================================

function generateHeatmap() {
  const heatmap = document.getElementById('heatmap');
  if (!heatmap) return;
  
  // Generate 7x7 grid (7 days x 7 emotions)
  heatmap.innerHTML = '';
  
  for (let i = 0; i < 49; i++) {
    const cell = document.createElement('div');
    cell.className = 'heatmap-cell';
    const intensity = Math.random();
    cell.style.background = `rgba(110, 231, 183, ${intensity * 0.8})`;
    cell.title = `Activity: ${Math.round(intensity * 100)}%`;
    heatmap.appendChild(cell);
  }
}

// ========================================
// Table
// ========================================

function updateTable() {
  const tbody = document.getElementById('sessionsTable');
  if (!tbody) return;
  
  const itemsPerPage = 10;
  const start = (currentPage - 1) * itemsPerPage;
  const end = start + itemsPerPage;
  const pageData = sessionsData.slice(start, end);
  
  tbody.innerHTML = pageData.map((session, i) => `
    <tr>
      <td>${formatDate(session.startTime)}</td>
      <td><span class="badge" style="background: rgba(59, 130, 246, 0.2); color: #3b82f6; padding: 0.25rem 0.75rem; border-radius: 12px;">Live</span></td>
      <td>${formatDuration(session.duration)}</td>
      <td>${session.frameCount}</td>
      <td style="text-transform: capitalize;">${session.stats?.dominant || 'N/A'}</td>
      <td>${session.stats?.avgConfidence || 0}%</td>
      <td>
        <button class="btn btn-sm btn-secondary" onclick="viewSession(${start + i})">
          <i class="fas fa-eye"></i>
        </button>
        <button class="btn btn-sm btn-secondary" onclick="exportSession(${start + i})">
          <i class="fas fa-download"></i>
        </button>
      </td>
    </tr>
  `).join('');
  
  // Update pagination
  const totalPages = Math.ceil(sessionsData.length / itemsPerPage);
  document.getElementById('pageInfo').textContent = `Page ${currentPage} of ${totalPages}`;
  
  document.getElementById('prevPage').disabled = currentPage === 1;
  document.getElementById('nextPage').disabled = currentPage === totalPages;
}

function changePage(delta) {
  currentPage += delta;
  updateTable();
}

window.viewSession = function(index) {
  const session = sessionsData[index];
  if (!session) return;
  
  alert(`Session Details\n\nStart: ${formatDate(session.startTime)}\nDuration: ${formatDuration(session.duration)}\nFrames: ${session.frameCount}\nDominant: ${session.stats?.dominant}\nConfidence: ${session.stats?.avgConfidence}%`);
};

window.exportSession = function(index) {
  const session = sessionsData[index];
  if (!session) return;
  
  const format = settings.get('exportFormat') || 'json';
  const filename = `session_${session.sessionId}`;
  
  if (format === 'json') {
    exportToJSON(session, filename + '.json');
  } else {
    const csvData = session.data.map(item => ({
      timestamp: item.timestamp,
      dominant: item.dominant,
      confidence: item.confidence,
      ...item.emotions
    }));
    exportToCSV(csvData, filename + '.csv');
  }
};

function exportTableData() {
  if (sessionsData.length === 0) {
    alert('No data to export');
    return;
  }
  
  const csvData = sessionsData.map(s => ({
    startTime: s.startTime,
    duration: s.duration,
    frameCount: s.frameCount,
    dominantEmotion: s.stats?.dominant,
    avgConfidence: s.stats?.avgConfidence
  }));
  
  exportToCSV(csvData, 'sessions_summary.csv');
}

// ========================================
// Insights
// ========================================

function generateInsights() {
  // This would use actual ML/analysis in production
  // For now, we'll keep the static insights from the HTML
}
