'use strict';

(function () {
  const $ = (id) => document.getElementById(id);

  const state = {
    ws: null,
    selfId: '',
    room: '',
    name: '',
    localStream: null,
    peers: new Map(), // peerId -> { pc, name, pendingIce: [] }
    iceServers: [],
    micOn: true,
    camOn: true,
    statsTimer: null,
    waitTimer: null,
  };

  function toast(message) {
    const node = $('toast');
    node.textContent = message;
    node.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => node.classList.add('hidden'), 2600);
  }

  function setError(message) {
    $('setupError').textContent = message || '';
  }

  function serverBase() {
    const raw = ($('server').value || '').trim().replace(/\/+$/, '');
    if (!raw) return location.host;
    return raw.replace(/^https?:\/\//, '').replace(/^wss?:\/\//, '');
  }

  /* ------------------------------ 加入流程 ------------------------------ */

  async function join() {
    setError('');
    const room = ($('room').value || '').trim();
    const name = ($('name').value || '').trim() || '网页设备';
    if (!/^[0-9A-Za-z_-]{1,32}$/.test(room)) {
      setError('房间号只能包含字母、数字、下划线、短横线（1-32 位）');
      return;
    }

    const btn = $('joinBtn');
    btn.disabled = true;
    btn.textContent = '正在打开摄像头…';

    try {
      state.room = room;
      state.name = name;
      localStorage.setItem('vcall.server', $('server').value.trim());
      localStorage.setItem('vcall.name', name);
      localStorage.setItem('vcall.room', room);

      if (!state.localStream) {
        const audio = $('joinAudio').checked;
        state.localStream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
          audio,
        });
        state.micOn = audio;
      }
      $('localVideo').srcObject = state.localStream;

      const base = serverBase();
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const config = await fetch(location.origin + '/api/config')
        .then((r) => r.json())
        .catch(() => ({ iceServers: [] }));
      state.iceServers = config.iceServers || [];

      const ws = new WebSocket(`${proto}://${base}/ws`);
      state.ws = ws;
      bindSocket(ws);
    } catch (err) {
      setError('无法打开摄像头/麦克风：' + (err && err.message ? err.message : err));
      btn.disabled = false;
      btn.textContent = '加入房间';
    }
  }

  function bindSocket(ws) {
    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          type: 'join',
          room: state.room,
          name: state.name,
          device: {
            platform: 'web',
            os: navigator.platform || 'browser',
            model: (navigator.userAgentData && navigator.userAgentData.platform) || navigator.userAgent.slice(0, 40),
            appVersion: 'web',
          },
        })
      );
    };

    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (err) {
        return;
      }
      handleMessage(msg);
    };

    ws.onclose = () => {
      if (!$('call').classList.contains('hidden')) {
        toast('与服务器的连接已断开');
        hangup();
      }
    };

    ws.onerror = () => setError('无法连接信令服务器，请检查地址与端口');
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case 'welcome':
        state.selfId = msg.id;
        if (!state.iceServers.length) state.iceServers = msg.iceServers || [];
        $('announcement').textContent = msg.announcement || '';
        break;
      case 'joined':
        showCall(msg);
        // 后加入者主动向已有成员发起 offer，避免双方同时 offer
        for (const peer of msg.peers || []) {
          createOffer(peer.id, peer.name);
        }
        break;
      case 'peer-joined':
        toast((msg.peer.name || '对方') + ' 已加入');
        $('remotePlaceholder').querySelector('p').innerHTML =
          '正在接通 <b>' + escapeHtml(msg.peer.name || '') + '</b>…';
        break;
      case 'offer':
        handleOffer(msg.from, msg.sdp);
        break;
      case 'answer':
        handleAnswer(msg.from, msg.sdp);
        break;
      case 'ice':
        handleIce(msg.from, msg.candidate);
        break;
      case 'peer-left':
      case 'peer-hangup':
        closePeer(msg.id);
        toast((msg.name || '对方') + ' 已离开');
        showWaiting();
        break;
      case 'kicked':
        toast(msg.reason || '已被管理员断开');
        hangup();
        break;
      case 'error':
        if (msg.code === 'room_full') {
          setError(msg.message);
          hangup(true);
        } else {
          toast(msg.message || '发生错误');
        }
        break;
      default:
        break;
    }
  }

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function showCall(msg) {
    $('setup').classList.add('hidden');
    $('call').classList.remove('hidden');
    $('roomBadge').textContent = '房间 ' + (msg.room || state.room);
    $('waitRoom').textContent = msg.room || state.room;
    $('stateBadge').textContent = '等待对方';
    $('localVideo').srcObject = state.localStream;
    updateMicButton();
    updateCamButton();
    startStats();
    if (!msg.peers || !msg.peers.length) showWaiting();
    else $('remotePlaceholder').classList.add('hidden');
    state.waitTimer = setInterval(() => {
      if (state.peers.size === 0) $('stateBadge').textContent = '等待对方加入…';
    }, 3000);
  }

  function showWaiting() {
    $('remotePlaceholder').classList.remove('hidden');
    $('remotePlaceholder').querySelector('p').innerHTML =
      '等待对方加入房间 <b>' + escapeHtml(state.room) + '</b>';
    $('stateBadge').textContent = '等待对方';
  }

  /* ------------------------------ WebRTC ------------------------------ */

  function createPeer(peerId, name) {
    let entry = state.peers.get(peerId);
    if (entry) return entry;

    const pc = new RTCPeerConnection({ iceServers: state.iceServers, bundlePolicy: 'max-bundle' });
    entry = { pc, name: name || '对方', pendingIce: [] };
    state.peers.set(peerId, entry);

    for (const track of state.localStream.getTracks()) {
      pc.addTrack(track, state.localStream);
    }

    pc.onicecandidate = (event) => {
      if (event.candidate && state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify({ type: 'ice', to: peerId, candidate: event.candidate }));
      }
    };

    pc.ontrack = (event) => {
      $('remoteVideo').srcObject = event.streams[0];
      $('remotePlaceholder').classList.add('hidden');
      $('stateBadge').textContent = '已接通';
      clearInterval(state.waitTimer);
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        $('stateBadge').textContent = '已接通';
        $('remotePlaceholder').classList.add('hidden');
      } else if (pc.connectionState === 'failed') {
        toast('连接失败，正在重试…');
        pc.restartIce();
      } else if (pc.connectionState === 'disconnected') {
        $('stateBadge').textContent = '连接不稳定';
      }
    };

    return entry;
  }

  async function createOffer(peerId, name) {
    const entry = createPeer(peerId, name);
    const offer = await entry.pc.createOffer();
    await entry.pc.setLocalDescription(offer);
    send({ type: 'offer', to: peerId, sdp: entry.pc.localDescription.sdp });
  }

  async function handleOffer(from, sdp) {
    const entry = createPeer(from, '对方');
    await entry.pc.setRemoteDescription({ type: 'offer', sdp });
    const answer = await entry.pc.createAnswer();
    await entry.pc.setLocalDescription(answer);
    send({ type: 'answer', to: from, sdp: entry.pc.localDescription.sdp });
    flushIce(entry);
  }

  async function handleAnswer(from, sdp) {
    const entry = state.peers.get(from);
    if (!entry) return;
    await entry.pc.setRemoteDescription({ type: 'answer', sdp });
    flushIce(entry);
  }

  async function handleIce(from, candidate) {
    if (!candidate) return;
    const entry = state.peers.get(from);
    if (!entry) return;
    if (!entry.pc.remoteDescription) {
      entry.pendingIce.push(candidate);
      return;
    }
    try {
      await entry.pc.addIceCandidate(candidate);
    } catch (err) {
      // 忽略个别候选失败
    }
  }

  function flushIce(entry) {
    for (const candidate of entry.pendingIce.splice(0)) {
      entry.pc.addIceCandidate(candidate).catch(() => {});
    }
  }

  function closePeer(peerId) {
    const entry = state.peers.get(peerId);
    if (!entry) return;
    try {
      entry.pc.close();
    } catch (err) {
      // ignore
    }
    state.peers.delete(peerId);
    if (!state.peers.size) $('remoteVideo').srcObject = null;
  }

  function send(payload) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify(payload));
    }
  }

  /* ------------------------------ 统计 ------------------------------ */

  function startStats() {
    clearInterval(state.statsTimer);
    state.statsTimer = setInterval(async () => {
      const entry = [...state.peers.values()][0];
      if (!entry) {
        $('statsBadge').textContent = '--';
        return;
      }
      try {
        const report = await entry.pc.getStats();
        let inbound = null;
        let pair = null;
        report.forEach((item) => {
          if (item.type === 'inbound-rtp' && item.kind === 'video') inbound = item;
          if (item.type === 'candidate-pair' && item.state === 'succeeded') pair = item;
        });
        const parts = [];
        if (inbound && inbound.frameWidth) parts.push(inbound.frameWidth + '×' + inbound.frameHeight);
        if (inbound && inbound.framesPerSecond) parts.push(Math.round(inbound.framesPerSecond) + 'fps');
        if (pair && pair.currentRoundTripTime) parts.push(Math.round(pair.currentRoundTripTime * 1000) + 'ms');
        $('statsBadge').textContent = parts.join(' · ') || '已连接';
      } catch (err) {
        // ignore
      }
    }, 2500);
  }

  /* ------------------------------ 控制 ------------------------------ */

  function updateMicButton() {
    const btn = $('micBtn');
    btn.textContent = state.micOn ? '🎤' : '🔇';
    btn.classList.toggle('off', !state.micOn);
  }

  function updateCamButton() {
    const btn = $('camBtn');
    btn.textContent = state.camOn ? '📷' : '🚫';
    btn.classList.toggle('off', !state.camOn);
  }

  function toggleMic() {
    state.micOn = !state.micOn;
    for (const track of state.localStream.getAudioTracks()) track.enabled = state.micOn;
    updateMicButton();
    send({ type: 'state', muted: { audio: !state.micOn, video: !state.camOn } });
  }

  function toggleCam() {
    state.camOn = !state.camOn;
    for (const track of state.localStream.getVideoTracks()) track.enabled = state.camOn;
    updateCamButton();
    send({ type: 'state', muted: { audio: !state.micOn, video: !state.camOn } });
  }

  function hangup(silent) {
    send({ type: 'leave' });
    for (const peerId of [...state.peers.keys()]) closePeer(peerId);
    if (state.ws) {
      try {
        state.ws.close();
      } catch (err) {
        // ignore
      }
      state.ws = null;
    }
    if (state.localStream) {
      for (const track of state.localStream.getTracks()) track.stop();
      state.localStream = null;
    }
    clearInterval(state.statsTimer);
    clearInterval(state.waitTimer);
    $('remoteVideo').srcObject = null;
    $('localVideo').srcObject = null;
    $('call').classList.add('hidden');
    $('setup').classList.remove('hidden');
    $('joinBtn').disabled = false;
    $('joinBtn').textContent = '加入房间';
    if (!silent) toast('通话已结束');
  }

  /* ------------------------------ 初始化 ------------------------------ */

  const savedServer = localStorage.getItem('vcall.server') || '';
  $('server').value = savedServer;
  $('server').placeholder = location.host || '192.168.199.100:9002';
  $('name').value = localStorage.getItem('vcall.name') || '';
  $('room').value = localStorage.getItem('vcall.room') || '1001';

  $('joinBtn').addEventListener('click', join);
  $('micBtn').addEventListener('click', toggleMic);
  $('camBtn').addEventListener('click', toggleCam);
  $('hangupBtn').addEventListener('click', () => hangup());
  $('speakerBtn').addEventListener('click', () => {
    const video = $('remoteVideo');
    video.muted = !video.muted;
    toast(video.muted ? '已静音对方声音' : '已恢复声音');
  });

  window.addEventListener('beforeunload', () => {
    if (state.ws) state.ws.close();
  });
})();
