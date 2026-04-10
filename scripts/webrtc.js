/**
 * webrtc.js — WebRTC peer-to-peer meeting support
 * Handles: room join/leave, offer/answer/ICE exchange via Socket.IO,
 *          remote participant video rendering + per-participant emotion tracking
 */

const WebRTCManager = {
  enabled: false,
  socket: null,
  room: null,
  localStream: null,
  peers: {},           // peerId → { pc: RTCPeerConnection, stream, videoEl }
  participantEmotions: {},  // peerId → latest emotion result

  ICE_SERVERS: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],

  /**
   * Toggle WebRTC mode on/off
   */
  toggle() {
    this.enabled = !this.enabled;
    const statusBar = document.getElementById('webrtcStatusBar');
    const partSection = document.getElementById('webrtcParticipantsSection');
    const toggleBtn = document.getElementById('toggleWebRTCMode');

    if (statusBar) statusBar.style.display = this.enabled ? 'flex' : 'none';
    if (partSection) partSection.style.display = this.enabled ? 'block' : 'none';
    if (toggleBtn) {
      toggleBtn.classList.toggle('btn-primary', this.enabled);
      toggleBtn.classList.toggle('btn-secondary', !this.enabled);
    }

    if (!this.enabled) {
      this.leaveRoom();
    }
    return this.enabled;
  },

  /**
   * Set the Socket.IO connection for signaling
   */
  setSocket(socket) {
    this.socket = socket;
    if (!socket) return;

    socket.on('signal', (data) => this._handleSignal(data));
  },

  /**
   * Set local media stream
   */
  setLocalStream(stream) {
    this.localStream = stream;
  },

  /**
   * Join a meeting room
   */
  joinRoom(roomId) {
    if (!this.socket?.connected) {
      showToast('Connect to backend first', 'warn');
      return false;
    }
    this.room = roomId;
    this.socket.emit('signal', {
      type: 'join',
      room: roomId,
      peer_id: this.socket.id,
    });

    // Update UI
    this._setConnectionStatus('connected', `Connected to ${roomId}`);
    const joinBtn = document.getElementById('joinRoomBtn');
    const leaveBtn = document.getElementById('leaveRoomBtn');
    if (joinBtn) joinBtn.style.display = 'none';
    if (leaveBtn) leaveBtn.style.display = 'inline-flex';

    showToast(`Joined room: ${roomId}`);
    return true;
  },

  /**
   * Leave the current room
   */
  leaveRoom() {
    if (this.socket?.connected && this.room) {
      this.socket.emit('signal', {
        type: 'leave',
        room: this.room,
        peer_id: this.socket.id,
      });
    }

    // Close all peer connections
    Object.keys(this.peers).forEach(pid => this._removePeer(pid));
    this.peers = {};
    this.room = null;

    // Update UI
    this._setConnectionStatus('disconnected', 'Not connected');
    const joinBtn = document.getElementById('joinRoomBtn');
    const leaveBtn = document.getElementById('leaveRoomBtn');
    if (joinBtn) joinBtn.style.display = 'inline-flex';
    if (leaveBtn) leaveBtn.style.display = 'none';

    this._renderParticipants();
  },

  /**
   * Handle incoming signaling messages
   */
  async _handleSignal(data) {
    const { type, peer_id } = data;
    if (peer_id === this.socket?.id) return; // ignore self

    switch (type) {
      case 'joined':
        console.log(`[WebRTC] Peer joined: ${peer_id}`);
        await this._createOffer(peer_id);
        break;

      case 'left':
        console.log(`[WebRTC] Peer left: ${peer_id}`);
        this._removePeer(peer_id);
        break;

      case 'offer':
        console.log(`[WebRTC] Received offer from: ${peer_id}`);
        await this._handleOffer(peer_id, data.sdp);
        break;

      case 'answer':
        console.log(`[WebRTC] Received answer from: ${peer_id}`);
        await this._handleAnswer(peer_id, data.sdp);
        break;

      case 'ice':
        await this._handleICE(peer_id, data.candidate);
        break;
    }
  },

  /**
   * Create a new peer connection
   */
  _createPC(peerId) {
    const pc = new RTCPeerConnection({ iceServers: this.ICE_SERVERS });

    // Add local tracks
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => {
        pc.addTrack(track, this.localStream);
      });
    }

    // Handle remote stream
    pc.ontrack = (e) => {
      console.log(`[WebRTC] Got remote track from ${peerId}`);
      const peer = this.peers[peerId];
      if (peer) {
        peer.stream = e.streams[0];
        this._renderParticipants();
        // Start analyzing remote participant
        this._startRemoteAnalysis(peerId);
      }
    };

    // ICE candidates
    pc.onicecandidate = (e) => {
      if (e.candidate && this.socket?.connected) {
        this.socket.emit('signal', {
          type: 'ice',
          room: this.room,
          peer_id: this.socket.id,
          target: peerId,
          candidate: e.candidate,
        });
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        this._removePeer(peerId);
      }
    };

    this.peers[peerId] = { pc, stream: null, videoEl: null, analysisTimer: null };
    return pc;
  },

  async _createOffer(peerId) {
    const pc = this._createPC(peerId);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    this.socket.emit('signal', {
      type: 'offer',
      room: this.room,
      peer_id: this.socket.id,
      sdp: offer,
    });
  },

  async _handleOffer(peerId, sdp) {
    const pc = this._createPC(peerId);
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    this.socket.emit('signal', {
      type: 'answer',
      room: this.room,
      peer_id: this.socket.id,
      sdp: answer,
    });
  },

  async _handleAnswer(peerId, sdp) {
    const peer = this.peers[peerId];
    if (peer?.pc) {
      await peer.pc.setRemoteDescription(new RTCSessionDescription(sdp));
    }
  },

  async _handleICE(peerId, candidate) {
    const peer = this.peers[peerId];
    if (peer?.pc && candidate) {
      try {
        await peer.pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.warn('[WebRTC] ICE candidate error:', err);
      }
    }
  },

  _removePeer(peerId) {
    const peer = this.peers[peerId];
    if (!peer) return;
    if (peer.analysisTimer) clearInterval(peer.analysisTimer);
    if (peer.pc) {
      peer.pc.close();
    }
    delete this.peers[peerId];
    delete this.participantEmotions[peerId];
    this._renderParticipants();
  },

  /**
   * Analyze remote participant's video frames
   */
  _startRemoteAnalysis(peerId) {
    const peer = this.peers[peerId];
    if (!peer?.stream) return;
    if (peer.analysisTimer) clearInterval(peer.analysisTimer);

    peer.analysisTimer = setInterval(async () => {
      if (!peer.stream || !peer.videoEl) return;
      try {
        const canvas = document.createElement('canvas');
        canvas.width = peer.videoEl.videoWidth || 320;
        canvas.height = peer.videoEl.videoHeight || 240;
        canvas.getContext('2d').drawImage(peer.videoEl, 0, 0);
        const result = await FaceEngine.analyze(canvas, { participantId: peerId });
        if (result.face_emotions?.length > 0) {
          this.participantEmotions[peerId] = result.face_emotions[0];
          this._updateParticipantCard(peerId);
        }
      } catch { /* skip */ }
    }, 2000);
  },

  /**
   * Render participant video tiles
   */
  _renderParticipants() {
    const grid = document.getElementById('remoteParticipantsGrid');
    if (!grid) return;

    const peerIds = Object.keys(this.peers);
    if (peerIds.length === 0) {
      grid.innerHTML = '<div style="color:var(--text-secondary);padding:20px;text-align:center;font-size:13px;">No remote participants yet</div>';
      return;
    }

    grid.innerHTML = '';
    peerIds.forEach(pid => {
      const peer = this.peers[pid];
      const emo = this.participantEmotions[pid];
      const EMOTION_CONFIG = {
        happy: { icon: '😊', color: '#4ade80' }, sad: { icon: '😢', color: '#60a5fa' },
        angry: { icon: '😠', color: '#f87171' }, surprised: { icon: '😲', color: '#34d399' },
        fearful: { icon: '😨', color: '#a78bfa' }, disgusted: { icon: '🤢', color: '#fb923c' },
        neutral: { icon: '😐', color: '#94a3b8' },
      };
      const cfg = emo ? (EMOTION_CONFIG[emo.emotion] || EMOTION_CONFIG.neutral) : EMOTION_CONFIG.neutral;

      const card = document.createElement('div');
      card.className = 'participant-card';
      card.innerHTML = `
        <div style="position:relative;background:#000;border-radius:6px;overflow:hidden;aspect-ratio:4/3;margin-bottom:8px;">
          <video autoplay playsinline muted id="remote-video-${pid}" style="width:100%;height:100%;object-fit:cover;"></video>
        </div>
        <div style="display:flex;align-items:center;gap:8px;font-size:12px;">
          <span style="font-size:1.2rem">${emo ? cfg.icon : '👤'}</span>
          <div>
            <div style="font-weight:600;color:${cfg.color}">${emo ? emo.emotion : 'Detecting...'}</div>
            <div style="color:var(--text-secondary);font-size:11px;">${pid.substring(0, 8)}...</div>
          </div>
          ${emo ? `<span style="margin-left:auto;font-weight:700;color:${cfg.color}">${Math.round(emo.confidence * 100)}%</span>` : ''}
        </div>`;
      grid.appendChild(card);

      // Attach stream to video
      const videoEl = card.querySelector('video');
      if (peer.stream && videoEl) {
        videoEl.srcObject = peer.stream;
        peer.videoEl = videoEl;
      }
    });
  },

  _updateParticipantCard(peerId) {
    // re-render for simplicity
    this._renderParticipants();
  },

  _setConnectionStatus(status, text) {
    const dot = document.getElementById('rtcDot');
    const txt = document.getElementById('rtcStatusText');
    if (dot) {
      dot.className = `rtc-dot ${status}`;
    }
    if (txt) txt.textContent = text;
  },

  /**
   * Get summary of all participant emotions (for session reports)
   */
  getParticipantSummary() {
    return Object.entries(this.participantEmotions).map(([pid, emo]) => ({
      participant_id: pid,
      emotion: emo.emotion,
      confidence: emo.confidence,
      timestamp: Date.now() / 1000,
    }));
  },
};


// ── Wire up UI on DOM ready ──────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('toggleWebRTCMode')?.addEventListener('click', () => {
    WebRTCManager.toggle();
  });

  document.getElementById('joinRoomBtn')?.addEventListener('click', () => {
    const roomInput = document.getElementById('roomIdInput');
    const roomId = roomInput?.value?.trim() || 'meet-room-001';
    WebRTCManager.joinRoom(roomId);
  });

  document.getElementById('leaveRoomBtn')?.addEventListener('click', () => {
    WebRTCManager.leaveRoom();
  });
});
