// =====================================================
// WebRTC Multi-Participant Module — webrtc.js
// Expression Analyser
//
// Handles:
//   - RTCPeerConnection creation per remote peer
//   - WebSocket signalling relay (connects to backend /ws/signal)
//   - Per-participant video tiles with live emotion overlays
//   - Demo mode when no signalling server is available
// =====================================================

class WebRTCManager {
  constructor() {
    this.localStream     = null;
    this.peers           = {};   // peerId -> { pc, stream, videoEl, canvas, intervalId }
    this.signalingWs     = null;
    this.roomId          = null;
    this.localPeerId     = 'peer_' + Math.random().toString(36).substr(2, 8);
    this.isConnected     = false;
    this.analysisMs      = 1200;   // ms between per-participant frames
    this.iceServers      = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ];
  }

  // ─── Connect to signalling WebSocket ─────────────
  connectSignaling(wsUrl) {
    try {
      this.signalingWs = new WebSocket(wsUrl);

      this.signalingWs.onopen = () => {
        this.isConnected = true;
        this._updateStatus('connected', `Connected · ${wsUrl}`);
      };
      this.signalingWs.onmessage = async (evt) => {
        await this._handleSignal(JSON.parse(evt.data));
      };
      this.signalingWs.onclose = () => {
        this.isConnected = false;
        this._updateStatus('disconnected', 'Signalling disconnected');
      };
      this.signalingWs.onerror = () => {
        console.warn('[WebRTC] No signalling server — running demo mode');
        this._updateStatus('demo', 'Demo mode (no server)');
        this._runDemoMode();
      };
    } catch {
      this._updateStatus('demo', 'Demo mode');
      this._runDemoMode();
    }
  }

  _sendSignal(msg) {
    if (this.signalingWs && this.signalingWs.readyState === WebSocket.OPEN) {
      this.signalingWs.send(JSON.stringify({ ...msg, from: this.localPeerId, room: this.roomId }));
    }
  }

  async _handleSignal(msg) {
    const { type, from, sdp, candidate } = msg;
    if (from === this.localPeerId) return;

    if (type === 'joined') {
      await this._createPC(from);
      await this._sendOffer(from);
    } else if (type === 'offer') {
      await this._createPC(from);
      await this.peers[from].pc.setRemoteDescription(new RTCSessionDescription(sdp));
      const answer = await this.peers[from].pc.createAnswer();
      await this.peers[from].pc.setLocalDescription(answer);
      this._sendSignal({ type: 'answer', to: from, sdp: answer });
    } else if (type === 'answer') {
      if (this.peers[from]) await this.peers[from].pc.setRemoteDescription(new RTCSessionDescription(sdp));
    } else if (type === 'ice') {
      if (this.peers[from] && candidate) {
        await this.peers[from].pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
      }
    } else if (type === 'left') {
      this._removePeer(from);
    }
  }

  async joinRoom(roomId, localStream) {
    this.roomId      = roomId;
    this.localStream = localStream;
    this._sendSignal({ type: 'join' });
    this._updateParticipantCount();
  }

  leaveRoom() {
    this._sendSignal({ type: 'leave' });
    Object.keys(this.peers).forEach(id => this._removePeer(id));
    this.roomId = null;
    this._updateParticipantCount();
  }

  async _createPC(peerId) {
    if (this.peers[peerId]) return;
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });

    if (this.localStream) this.localStream.getTracks().forEach(t => pc.addTrack(t, this.localStream));

    pc.onicecandidate = (e) => {
      if (e.candidate) this._sendSignal({ type: 'ice', to: peerId, candidate: e.candidate });
    };
    pc.ontrack = (e) => this._addTile(peerId, e.streams[0]);
    pc.onconnectionstatechange = () => {
      if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) this._removePeer(peerId);
    };

    this.peers[peerId] = { pc, stream: null, videoEl: null, canvas: null, intervalId: null };
  }

  async _sendOffer(peerId) {
    const pc    = this.peers[peerId].pc;
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this._sendSignal({ type: 'offer', to: peerId, sdp: offer });
  }

  // ─── Add video tile for a real remote peer ────────
  _addTile(peerId, stream) {
    const grid = document.getElementById('remoteParticipantsGrid');
    if (!grid) return;
    this.peers[peerId].stream = stream;
    document.getElementById(`tile-${peerId}`)?.remove();

    const tile   = document.createElement('div');
    tile.className = 'participant-tile';
    tile.id = `tile-${peerId}`;

    const video   = document.createElement('video');
    video.autoplay = true; video.playsInline = true; video.srcObject = stream;

    const canvas  = document.createElement('canvas');
    canvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none';

    const label = document.createElement('div');
    label.className = 'participant-tile-label';
    label.innerHTML = `
      <span style="color:var(--text-secondary);font-family:var(--fm);font-size:10px">${peerId.slice(0,12)}</span>
      <span class="participant-emotion-badge" id="badge-${peerId}" style="background:rgba(16,185,129,0.15);color:var(--primary)">—</span>
    `;

    tile.append(video, canvas, label);
    grid.appendChild(tile);

    this.peers[peerId].videoEl = video;
    this.peers[peerId].canvas  = canvas;

    this._startAnalysis(peerId, video, canvas);
    this._updateParticipantCount();
  }

  // ─── Per-participant emotion analysis ─────────────
  _startAnalysis(peerId, videoEl, canvasEl) {
    const id = setInterval(async () => {
      if (!videoEl || videoEl.readyState < 2) return;

      const tmp = document.createElement('canvas');
      tmp.width  = videoEl.videoWidth  || 320;
      tmp.height = videoEl.videoHeight || 240;
      tmp.getContext('2d').drawImage(videoEl, 0, 0);

      const source = document.getElementById('analysisSource')?.value || 'mock';
      let result;
      if (source === 'backend') {
        const url   = document.getElementById('backendUrlInput')?.value || 'http://localhost:5000';
        const frame = tmp.toDataURL('image/jpeg', 0.65).split(',')[1];
        try {
          const res  = await fetch(`${url}/api/analyze`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ frame, participant_id: peerId, method: 'mtcnn' }),
            signal: AbortSignal.timeout(3000),
          });
          const data = await res.json();
          if (data.face_emotions && data.face_emotions.length > 0) {
            const fe = data.face_emotions[0];
            const emotions = {};
            EMOTIONS.forEach(e => { emotions[e] = Math.round((fe.scores[e] || 0) * 100); });
            result = { emotions, dominant: fe.emotion, confidence: Math.round(fe.confidence * 100), timestamp: new Date().toISOString() };
          } else { result = await analyzeExpression(null); }
        } catch { result = await analyzeExpression(null); }
      } else {
        result = await analyzeExpression(null);
      }

      // Update badge
      const badge = document.getElementById(`badge-${peerId}`);
      const color = getEmotionColor(result.dominant, 1);
      if (badge) {
        badge.textContent = `${EMOTION_EMOJIS[result.dominant] || ''} ${result.dominant} ${result.confidence}%`;
        badge.style.background = getEmotionColor(result.dominant, 0.18);
        badge.style.color = color;
      }

      // Draw overlay
      this._drawOverlay(canvasEl, videoEl, result);

    }, this.analysisMs);

    this.peers[peerId].intervalId = id;
  }

  _drawOverlay(canvas, video, result) {
    if (!canvas || !video) return;
    canvas.width  = video.videoWidth  || 320;
    canvas.height = video.videoHeight || 240;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const color = getEmotionColor(result.dominant, 1);
    const w = canvas.width, h = canvas.height;
    const bx = w*0.12, by = h*0.08, bw = w*0.76, bh = h*0.78;
    const cs = 12;

    ctx.strokeStyle = color; ctx.lineWidth = 2;
    [[bx,by,1,1],[bx+bw,by,-1,1],[bx,by+bh,1,-1],[bx+bw,by+bh,-1,-1]].forEach(([cx,cy,dx,dy]) => {
      ctx.beginPath();
      ctx.moveTo(cx, cy+dy*cs); ctx.lineTo(cx, cy); ctx.lineTo(cx+dx*cs, cy);
      ctx.stroke();
    });

    const lbl = `${EMOTION_EMOJIS[result.dominant]||''} ${result.dominant.toUpperCase()}`;
    ctx.fillStyle = 'rgba(4,8,15,0.72)';
    ctx.fillRect(bx, by-20, lbl.length*7.5+10, 20);
    ctx.fillStyle = color; ctx.font = 'bold 10px JetBrains Mono,monospace';
    ctx.fillText(lbl, bx+5, by-6);
  }

  _removePeer(peerId) {
    if (!this.peers[peerId]) return;
    clearInterval(this.peers[peerId].intervalId);
    if (this.peers[peerId].pc) this.peers[peerId].pc.close();
    delete this.peers[peerId];
    document.getElementById(`tile-${peerId}`)?.remove();
    this._updateParticipantCount();
  }

  // ─── Demo mode: simulated participants ────────────
  _runDemoMode() {
    const section = document.getElementById('webrtcParticipantsSection');
    if (section) section.style.display = 'block';

    ['Alice_Chen', 'Bob_Sharma'].forEach((name, i) => {
      setTimeout(() => this._addDemoTile(name), 1500 + i * 900);
    });
  }

  _addDemoTile(peerId) {
    const grid = document.getElementById('remoteParticipantsGrid');
    if (!grid) return;

    const tile = document.createElement('div');
    tile.className = 'participant-tile';
    tile.id = `tile-${peerId}`;
    tile.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;';

    const initials = peerId.split('_').map(p => p[0]).join('');
    tile.innerHTML = `
      <div style="width:56px;height:56px;border-radius:50%;background:linear-gradient(135deg,var(--primary),var(--secondary));display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:800;color:white;font-family:var(--ff)">${initials}</div>
      <div class="participant-tile-label" id="label-${peerId}">
        <span style="color:var(--text-secondary);font-family:var(--fm);font-size:10px">${peerId}</span>
        <span class="participant-emotion-badge" id="badge-${peerId}" style="background:rgba(16,185,129,0.15);color:var(--primary)">—</span>
      </div>
    `;
    grid.appendChild(tile);

    const intervalId = setInterval(async () => {
      const result = await analyzeExpression(null);
      const badge  = document.getElementById(`badge-${peerId}`);
      const color  = getEmotionColor(result.dominant, 1);
      if (badge) {
        badge.textContent = `${EMOTION_EMOJIS[result.dominant]||''} ${result.dominant} ${result.confidence}%`;
        badge.style.background = getEmotionColor(result.dominant, 0.18);
        badge.style.color = color;
      }
    }, 2200);

    this.peers[peerId] = { pc: null, stream: null, videoEl: null, canvas: null, intervalId };
    this._updateParticipantCount();
  }

  _updateStatus(state, text) {
    const dot  = document.getElementById('rtcDot');
    const span = document.getElementById('rtcStatusText');
    if (dot)  dot.className = `rtc-dot ${state === 'connected' ? 'connected' : 'disconnected'}`;
    if (span) {
      span.textContent = text;
      span.style.color = state === 'connected' ? 'var(--success)' : state === 'demo' ? 'var(--warning)' : 'var(--text-secondary)';
    }
  }

  _updateParticipantCount() {
    const el = document.getElementById('participantCount');
    if (el) el.textContent = Object.keys(this.peers).length;
  }
}

// ─── Shared helpers ───────────────────────────────────
const EMOTION_EMOJIS = {
  happy:'😄', sad:'😢', angry:'😠', surprised:'😲',
  fear:'😨',  disgust:'🤢', neutral:'😐'
};

// ─── WebRTC UI wiring ─────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const manager = new WebRTCManager();
  window._webrtcManager = manager;

  const webrtcBar     = document.getElementById('webrtcStatusBar');
  const webrtcSection = document.getElementById('webrtcParticipantsSection');
  const toggleBtn     = document.getElementById('toggleWebRTCMode');
  const joinBtn       = document.getElementById('joinRoomBtn');
  const leaveBtn      = document.getElementById('leaveRoomBtn');
  const roomInput     = document.getElementById('roomIdInput');

  let webrtcMode = false;

  toggleBtn?.addEventListener('click', () => {
    webrtcMode = !webrtcMode;
    if (webrtcBar)     webrtcBar.style.display    = webrtcMode ? 'flex' : 'none';
    if (webrtcSection) webrtcSection.style.display = webrtcMode ? 'block' : 'none';

    if (toggleBtn) {
      toggleBtn.innerHTML = webrtcMode
        ? '<i class="fas fa-users"></i> WebRTC: ON'
        : '<i class="fas fa-users"></i> WebRTC Mode';
      toggleBtn.className = webrtcMode ? 'btn btn-primary' : 'btn btn-secondary';
    }

    if (webrtcMode) {
      const backendUrl = document.getElementById('backendUrlInput')?.value || 'http://localhost:5000';
      const wsUrl = backendUrl.replace(/^http/, 'ws') + '/socket.io/?EIO=4&transport=websocket';
      manager.connectSignaling(wsUrl);
      showToast('WebRTC mode enabled');
    }
  });

  joinBtn?.addEventListener('click', async () => {
    const roomId = roomInput?.value?.trim() || 'default-room';
    const localStream = window._localStream || null;
    await manager.joinRoom(roomId, localStream);
    if (joinBtn)  joinBtn.style.display  = 'none';
    if (leaveBtn) leaveBtn.style.display = '';
    showToast(`Joined room: ${roomId}`);
  });

  leaveBtn?.addEventListener('click', () => {
    manager.leaveRoom();
    if (joinBtn)  joinBtn.style.display  = '';
    if (leaveBtn) leaveBtn.style.display = 'none';
    showToast('Left room');
  });
});
