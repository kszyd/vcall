'use strict';

/**
 * VCall 网页端 v2：登录 -> 在线通讯录 -> 点选呼叫（支持多人 Mesh）
 */
(function () {
  const $ = (id) => document.getElementById(id);

  const state = {
    ws: null,
    selfId: '',
    name: '',
    localStream: null,
    receiveOnly: false,
    devices: [],
    selected: new Set(),
    callId: null,
    callVideo: true,
    peers: new Map(), // peerId -> { pc, name, pendingIce }
    peerNames: new Map(),
    micOn: true,
    camOn: true,
    callStartAt: 0,
    timer: null,
    statsTimer: null,
  };

  function toast(message) {
    const node = $('toast');
    node.textContent = message;
    node.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => node.classList.add('hidden'), 2600);
  }

  function isSecure() {
    return Boolean(navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function');
  }

  async function openMedia(withAudio) {
    if (!isSecure()) {
      const err = new Error('浏览器要求 HTTPS 或 localhost 才能访问摄像头/麦克风');
      err.code = 'insecure';
      throw err;
    }
    return navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
      audio: withAudio,
    });
  }

  function serverHost() {
    const raw = ($('server').value || '').trim().replace(/\/+$/, '');
    if (!raw) return location.host;
    return raw.replace(/^https?:\/\//, '').replace(/^wss?:\/\//, '');
  }

  /* ------------------------------ 登录 ------------------------------ */

  async function connect() {
    $('loginError').textContent = '';
    const name = ($('name').value || '').trim() || '网页终端';
    const host = serverHost();
    if (!host) {
      $('loginError').textContent = '请填写服务器地址';
      return;
    }

    const btn = $('connectBtn');
    btn.disabled = true;
    btn.textContent = '连接中…';

    try {
      state.name = name;
      localStorage.setItem('vcall.server', $('server').value.trim());
      localStorage.setItem('vcall.name', name);

      const config = await fetch(location.origin + '/api/config')
        .then((r) => r.json())
        .catch(() => ({ iceServers: [] }));
      state.iceServers = config.iceServers || [];

      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      let wsHost = host;
      if (proto === 'wss') {
        // HTTPS 页面必须走 9443（TLS），9002 只有明文 ws
        const idx = host.lastIndexOf(':');
        const onlyHost = idx === -1 ? host : host.slice(0, idx);
        const port = idx === -1 ? '' : host.slice(idx + 1);
        if (!port || port === '9002') wsHost = onlyHost + ':9443';
      }
      const ws = new WebSocket(proto + '://' + wsHost + '/ws');
      state.ws = ws;
      bindSocket(ws);
    } catch (err) {
      $('loginError').textContent = '连接失败：' + (err && err.message ? err.message : err);
      btn.disabled = false;
      btn.textContent = '进入通讯录';
    }
  }

  /**
   * 进入通讯录时不采集，真正发起或接听通话时才打开摄像头/麦克风。
   */
  async function ensureMedia() {
    if (state.localStream) return true;
    if (state.receiveOnly) return false;
    try {
      state.localStream = await openMedia(true);
      state.micOn = true;
      $('localVideo').srcObject = state.localStream;
      $('secureHint').classList.add('hidden');
      return true;
    } catch (err) {
      state.receiveOnly = true;
      $('secureHint').classList.remove('hidden');
      if (err && err.code === 'insecure') {
        toast('HTTP 下无法使用摄像头，将以仅接收模式通话');
      } else if (err && err.name === 'NotAllowedError') {
        toast('摄像头/麦克风权限被拒绝，将以仅接收模式通话');
      } else {
        toast('无法打开摄像头/麦克风：' + (err && err.message ? err.message : err));
      }
      return false;
    }
  }

  function bindSocket(ws) {
    ws.onopen = () => {
      ws.send(JSON.stringify(buildRegister()));
    };

    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (err) {
        return;
      }
      handle(msg);
    };

    ws.onclose = () => {
      if (state.callId) leaveCall(true);
      toast('与服务器的连接已断开');
      $('connectBtn').disabled = false;
      $('connectBtn').textContent = '进入通讯录';
      showDirectory(false);
    };

    ws.onerror = () => {
      $('loginError').textContent = '无法连接服务器，请检查地址与端口';
    };
  }

  /* ------------------------------ 消息处理 ------------------------------ */

  function handle(msg) {
    switch (msg.type) {
      case 'welcome':
        state.selfId = msg.id;
        setAnnouncement(msg.announcement || '');
        break;

      case 'registered':
        state.selfId = msg.self.id;
        localStorage.setItem('vcall.deviceId', msg.self.id);
        $('myName').textContent = msg.self.name;
        $('myAvatar').textContent = initial(msg.self.name);
        $('myState').textContent = 'ID ' + msg.self.id + ' · 点击昵称可修改';
        showDirectory(true);
        break;

      case 'directory':
        state.devices = msg.terminals || [];
        renderDirectory();
        break;

      case 'call-created':
        state.callId = msg.callId;
        state.callVideo = msg.video !== false;
        state.peerNames.clear();
        for (const m of msg.members || []) state.peerNames.set(m.id, m.name);
        showCall('正在呼叫…');
        break;

      case 'call-incoming':
        showIncoming(msg);
        break;

      case 'call-joined':
        state.callId = msg.callId;
        showCall('通话中');
        for (const m of msg.members || []) {
          state.peerNames.set(m.id, m.name);
          createOffer(m.id);
        }
        break;

      case 'call-member-joined':
        state.peerNames.set(msg.member.id, msg.member.name);
        addPlaceholderTile(msg.member.id, msg.member.name);
        toast((msg.member.name || '对方') + ' 已加入');
        break;

      case 'call-member-left':
        removePeer(msg.id);
        toast((msg.name || '对方') + ' 已离开');
        if (!state.peers.size) $('callTitle').textContent = '等待中…';
        break;

      case 'call-ended':
        toast('通话已结束');
        leaveCall(true);
        break;

      case 'call-cancelled':
        hideIncoming();
        toast(msg.reason === 'timeout' ? '对方无应答' : '呼叫已取消');
        if (!state.peers.size) leaveCall(true);
        break;

      case 'call-rejected':
        toast((msg.name || '对方') + ' 已拒绝');
        if (!state.peers.size) leaveCall(true);
        break;

      case 'call-timeout':
        toast((msg.name || '对方') + ' 无应答');
        break;

      case 'call-failed':
        toast((msg.name || '该终端') + ' 正忙或已离线');
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

      case 'member-state':
        break;

      case 'kicked':
        toast(msg.reason || '已被管理员下线');
        leaveCall(true);
        break;

      case 'announcement':
        setAnnouncement(msg.text || '');
        toast(msg.text ? '公告：' + msg.text : '公告已清除');
        break;

      case 'error':
        toast(msg.message || '发生错误');
        if (msg.code === 'busy' || msg.code === 'no_available') hideIncoming();
        break;

      default:
        break;
    }
  }

  function initial(name) {
    const text = (name || 'V').trim();
    return text ? text.slice(0, 1).toUpperCase() : 'V';
  }

  /* ------------------------------ 界面 ------------------------------ */

  function showDirectory(show) {
    $('login').classList.toggle('hidden', show);
    $('directory').classList.toggle('hidden', !show);
  }

  /* ------------------------------ 昵称 / 备注 / 公告 ------------------------------ */

  function aliasMap() {
    try {
      return JSON.parse(localStorage.getItem('vcall.aliases') || '{}') || {};
    } catch (err) {
      return {};
    }
  }

  function displayName(device, aliases) {
    const alias = aliases && aliases[device.id];
    return alias && alias.trim() ? alias : device.name || '未命名';
  }

  function promptAlias(device) {
    const current = aliasMap()[device.id] || '';
    const value = window.prompt('备注「' + (device.name || '') + '」（留空清除）', current);
    if (value === null) return;
    const map = aliasMap();
    if (value.trim()) map[device.id] = value.trim();
    else delete map[device.id];
    localStorage.setItem('vcall.aliases', JSON.stringify(map));
    renderDirectory();
    toast(value.trim() ? '备注已保存' : '备注已清除');
  }

  function buildRegister() {
    return {
      type: 'register',
      name: state.name,
      deviceId: localStorage.getItem('vcall.deviceId') || '',
      device: {
        platform: 'web',
        os: navigator.platform || 'browser',
        model: (navigator.userAgentData && navigator.userAgentData.platform) || navigator.userAgent.slice(0, 40),
        appVersion: 'web',
      },
    };
  }

  function editNickname() {
    const value = window.prompt('修改昵称', state.name || '');
    if (value === null) return;
    const name = value.trim();
    if (!name) {
      toast('昵称不能为空');
      return;
    }
    state.name = name;
    localStorage.setItem('vcall.name', name);
    $('myName').textContent = name;
    $('myAvatar').textContent = initial(name);
    send(buildRegister());
    toast('昵称已更新');
  }

  function setAnnouncement(text) {
    state.announcement = text || '';
    const login = $('announcement');
    if (login) {
      login.textContent = state.announcement;
      login.classList.toggle('hidden', !state.announcement);
    }
    const bar = $('noticeBar');
    if (bar) {
      bar.textContent = state.announcement ? '公告：' + state.announcement : '';
      bar.classList.toggle('hidden', !state.announcement);
    }
  }

  function renderDirectory() {
    const list = $('terminalList');
    list.textContent = '';
    const aliases = aliasMap();
    const keyword = ($('searchInput').value || '').trim().toLowerCase();
    const items = state.devices.filter((d) => {
      const shown = displayName(d, aliases).toLowerCase();
      return !keyword || shown.includes(keyword) || (d.name || '').toLowerCase().includes(keyword);
    });
    $('onlineCount').textContent = state.devices.length + ' 台';
    $('emptyHint').classList.toggle('hidden', items.length > 0);

    for (const device of items) {
      const li = document.createElement('li');
      li.className = 'terminal-item' + (state.selected.has(device.id) ? ' selected' : '');

      const avatar = document.createElement('div');
      avatar.className = 'avatar';
      avatar.textContent = initial(displayName(device, aliases));
      li.appendChild(avatar);

      const info = document.createElement('div');
      info.className = 'terminal-info';
      const nameRow = document.createElement('div');
      nameRow.className = 'terminal-name';
      nameRow.appendChild(document.createTextNode(displayName(device, aliases)));
      if (device.isTv) {
        const tag = document.createElement('span');
        tag.className = 'tag tv';
        tag.textContent = 'TV';
        nameRow.appendChild(tag);
      }
      if (device.state === 'busy') {
        const tag = document.createElement('span');
        tag.className = 'tag busy';
        tag.textContent = '通话中';
        nameRow.appendChild(tag);
      }
      info.appendChild(nameRow);

      const sub = document.createElement('div');
      sub.className = 'terminal-sub';
      const original = aliases[device.id] ? '原名 ' + (device.name || '') + ' · ' : '';
      sub.textContent = original + (device.platform === 'web' ? '网页' : '手机') + ' · ID ' + device.id;
      info.appendChild(sub);
      li.appendChild(info);

      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'more';
      more.textContent = '备注';
      more.addEventListener('click', (event) => {
        event.stopPropagation();
        promptAlias(device);
      });
      li.appendChild(more);

      const check = document.createElement('div');
      check.className = 'check';
      check.textContent = '✓';
      li.appendChild(check);

      check.addEventListener('click', (event) => {
        event.stopPropagation();
        if (state.selected.has(device.id)) state.selected.delete(device.id);
        else state.selected.add(device.id);
        renderDirectory();
      });

      li.addEventListener('click', () => {
        if (state.selected.size > 0) {
          if (state.selected.has(device.id)) state.selected.delete(device.id);
          else state.selected.add(device.id);
          renderDirectory();
          return;
        }
        // 对方通话中时服务器会把本机直接加入该通话
        invite([device.id]);
      });

      list.appendChild(li);
    }
  }

  async function invite(targets) {
    if (!targets.length) {
      toast('请先选择终端');
      return;
    }
    // 真正发起通话时才申请摄像头/麦克风
    await ensureMedia();
    send({ type: 'call-invite', targets, video: true });
    state.selected.clear();
    renderDirectory();
  }

  function showCall(title) {
    $('directory').classList.add('hidden');
    $('call').classList.remove('hidden');
    $('callTitle').textContent = title;
    if (!state.callStartAt) {
      state.callStartAt = Date.now();
      startTimer();
    }
    startStats();
    updateMicButton();
    updateCamButton();
  }

  function startTimer() {
    clearInterval(state.timer);
    state.timer = setInterval(() => {
      if (!state.callStartAt) return;
      const seconds = Math.floor((Date.now() - state.callStartAt) / 1000);
      const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
      const ss = String(seconds % 60).padStart(2, '0');
      $('callTimer').textContent = mm + ':' + ss;
    }, 1000);
  }

  function stopMedia() {
    if (state.localStream) {
      for (const track of state.localStream.getTracks()) track.stop();
      state.localStream = null;
    }
    $('localVideo').srcObject = null;
    state.receiveOnly = false;
    updateMicButton();
    updateCamButton();
  }

  /** 小窗可拖动；单击在本端/远端之间切换主画面 */
  function setupPip() {
    const pip = $('localVideo');
    let dragging = false;
    let moved = false;
    let startX = 0;
    let startY = 0;
    let originLeft = 0;
    let originTop = 0;

    pip.addEventListener('pointerdown', (e) => {
      dragging = true;
      moved = false;
      startX = e.clientX;
      startY = e.clientY;
      const rect = pip.getBoundingClientRect();
      originLeft = rect.left;
      originTop = rect.top;
      pip.classList.add('dragging');
      try {
        pip.setPointerCapture(e.pointerId);
      } catch (err) {
        // ignore
      }
    });

    pip.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
      const maxLeft = window.innerWidth - pip.offsetWidth - 4;
      const maxTop = window.innerHeight - pip.offsetHeight - 4;
      const left = Math.max(4, Math.min(originLeft + dx, maxLeft));
      const top = Math.max(4, Math.min(originTop + dy, maxTop));
      pip.style.left = left + 'px';
      pip.style.top = top + 'px';
      pip.style.right = 'auto';
      pip.style.bottom = 'auto';
    });

    pip.addEventListener('pointerup', (e) => {
      if (!dragging) return;
      dragging = false;
      pip.classList.remove('dragging');
      try {
        pip.releasePointerCapture(e.pointerId);
      } catch (err) {
        // ignore
      }
      if (!moved) toggleMainView();
    });

    pip.addEventListener('pointercancel', () => {
      dragging = false;
      pip.classList.remove('dragging');
    });
  }

  function toggleMainView() {
    // 一对一才切换，多人网格保持不动
    if (state.peers.size !== 1) return;
    const tile = document.querySelector('#videoGrid .video-tile video');
    if (!tile) return;
    const current = $('localVideo').srcObject;
    $('localVideo').srcObject = tile.srcObject;
    tile.srcObject = current;
    state.swapped = !state.swapped;
    $('localVideo').classList.toggle('remote-view', state.swapped);
    tile.classList.toggle('mirror', state.swapped);
  }

  function leaveCall(silent) {
    if (state.callId) send({ type: 'call-leave', callId: state.callId });
    state.callId = null;
    state.callStartAt = 0;
    clearInterval(state.timer);
    clearInterval(state.statsTimer);
    for (const id of [...state.peers.keys()]) removePeer(id);
    $('videoGrid').textContent = '';
    // 挂断即释放摄像头/麦克风，避免指示灯常亮
    stopMedia();
    state.swapped = false;
    $('localVideo').classList.remove('remote-view');
    $('call').classList.add('hidden');
    $('directory').classList.remove('hidden');
    $('callTimer').textContent = '00:00';
    $('callStats').textContent = '--';
    if (!silent) toast('通话已结束');
  }

  function showIncoming(msg) {
    state.callId = msg.callId;
    state.callVideo = msg.video !== false;
    $('incomingName').textContent = msg.from.name || '对方';
    $('incomingAvatar').textContent = initial(msg.from.name);
    $('incomingHint').textContent = msg.group ? '邀请你加入多人通话' : '邀请你视频通话';
    $('incoming').classList.remove('hidden');
  }

  function hideIncoming() {
    $('incoming').classList.add('hidden');
  }

  /* ------------------------------ WebRTC ------------------------------ */

  function ensurePeer(peerId, name) {
    let entry = state.peers.get(peerId);
    if (entry) return entry;

    const pc = new RTCPeerConnection({ iceServers: state.iceServers || [], bundlePolicy: 'max-bundle' });
    entry = { pc, name: name || state.peerNames.get(peerId) || '对方', pendingIce: [] };
    state.peers.set(peerId, entry);

    if (state.localStream) {
      for (const track of state.localStream.getTracks()) pc.addTrack(track, state.localStream);
    } else {
      pc.addTransceiver('audio', { direction: 'recvonly' });
      pc.addTransceiver('video', { direction: 'recvonly' });
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) send({ type: 'ice', to: peerId, callId: state.callId, candidate: event.candidate });
    };

    pc.ontrack = (event) => {
      attachTile(peerId, entry.name, event.streams[0]);
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        $('callTitle').textContent = '通话中';
      } else if (pc.connectionState === 'failed') {
        pc.restartIce();
      }
    };

    addPlaceholderTile(peerId, entry.name);
    return entry;
  }

  function addPlaceholderTile(peerId, name) {
    if (document.querySelector('[data-peer="' + peerId + '"]')) return;
    const tile = document.createElement('div');
    tile.className = 'video-tile';
    tile.dataset.peer = peerId;

    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    tile.appendChild(video);

    const label = document.createElement('span');
    label.className = 'tile-name';
    label.textContent = name || '对方';
    tile.appendChild(label);

    $('videoGrid').appendChild(tile);
    updateGrid();
  }

  function attachTile(peerId, name, stream) {
    addPlaceholderTile(peerId, name);
    const tile = document.querySelector('[data-peer="' + peerId + '"]');
    if (!tile) return;
    const video = tile.querySelector('video');
    if (stream) video.srcObject = stream;
  }

  function updateGrid() {
    const count = Math.max(1, Math.min(6, state.peers.size));
    $('videoGrid').dataset.count = String(count);
  }

  function removePeer(peerId) {
    const entry = state.peers.get(peerId);
    if (entry) {
      try {
        entry.pc.close();
      } catch (err) {
        // ignore
      }
      state.peers.delete(peerId);
    }
    const tile = document.querySelector('[data-peer="' + peerId + '"]');
    if (tile) tile.remove();
    updateGrid();
  }

  async function createOffer(peerId) {
    const entry = ensurePeer(peerId);
    const offer = await entry.pc.createOffer();
    await entry.pc.setLocalDescription(offer);
    send({ type: 'offer', to: peerId, callId: state.callId, sdp: entry.pc.localDescription.sdp });
  }

  async function handleOffer(from, sdp) {
    const entry = ensurePeer(from);
    await entry.pc.setRemoteDescription({ type: 'offer', sdp });
    const answer = await entry.pc.createAnswer();
    await entry.pc.setLocalDescription(answer);
    send({ type: 'answer', to: from, callId: state.callId, sdp: entry.pc.localDescription.sdp });
    flushIce(entry);
  }

  async function handleAnswer(from, sdp) {
    const entry = state.peers.get(from);
    if (!entry) return;
    await entry.pc.setRemoteDescription({ type: 'answer', sdp });
    flushIce(entry);
  }

  function handleIce(from, candidate) {
    if (!candidate) return;
    const entry = state.peers.get(from);
    if (!entry) return;
    if (!entry.pc.remoteDescription) {
      entry.pendingIce.push(candidate);
      return;
    }
    entry.pc.addIceCandidate(candidate).catch(() => {});
  }

  function flushIce(entry) {
    for (const candidate of entry.pendingIce.splice(0)) {
      entry.pc.addIceCandidate(candidate).catch(() => {});
    }
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
      if (!entry) return;
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
        $('callStats').textContent = parts.join(' · ') || '已连接';
        send({
          type: 'stats',
          rtt: pair && pair.currentRoundTripTime ? Math.round(pair.currentRoundTripTime * 1000) : 0,
          bitrate: 0,
          width: inbound ? inbound.frameWidth || 0 : 0,
          height: inbound ? inbound.frameHeight || 0 : 0,
          fps: inbound ? Math.round(inbound.framesPerSecond || 0) : 0,
        });
      } catch (err) {
        // ignore
      }
    }, 3000);
  }

  /* ------------------------------ 控制 ------------------------------ */

  function updateMicButton() {
    const btn = $('micBtn');
    btn.classList.toggle('off', !state.micOn);
    btn.textContent = state.micOn ? '🎤' : '🔇';
    btn.disabled = !state.localStream;
  }

  function updateCamButton() {
    const btn = $('camBtn');
    btn.classList.toggle('off', !state.camOn);
    btn.textContent = state.camOn ? '📷' : '🚫';
    btn.disabled = !state.localStream;
  }

  function toggleMic() {
    if (!state.localStream) return;
    state.micOn = !state.micOn;
    for (const track of state.localStream.getAudioTracks()) track.enabled = state.micOn;
    updateMicButton();
    send({ type: 'state', muted: { audio: !state.micOn, video: !state.camOn } });
  }

  function toggleCam() {
    if (!state.localStream) return;
    state.camOn = !state.camOn;
    for (const track of state.localStream.getVideoTracks()) track.enabled = state.camOn;
    updateCamButton();
    send({ type: 'state', muted: { audio: !state.micOn, video: !state.camOn } });
  }

  /* ------------------------------ 初始化 ------------------------------ */

  $('server').value = localStorage.getItem('vcall.server') || '';
  $('server').placeholder = location.host || '192.168.199.100:9002';
  $('name').value = localStorage.getItem('vcall.name') || '';
  if (!isSecure()) $('secureHint').classList.remove('hidden');

  $('connectBtn').addEventListener('click', connect);
  $('myName').addEventListener('click', editNickname);

  // 打开页面就先取一次公告，登录前也能看到
  fetch('/api/config')
    .then((r) => r.json())
    .then((cfg) => setAnnouncement(cfg.announcement || ''))
    .catch(() => {});
  $('logoutBtn').addEventListener('click', () => {
    stopMedia();
    if (state.ws) state.ws.close();
  });
  $('searchInput').addEventListener('input', renderDirectory);
  $('groupBtn').addEventListener('click', () => invite([...state.selected]));
  $('acceptBtn').addEventListener('click', async () => {
    if (!state.callId) return;
    // 接听时才申请摄像头/麦克风
    await ensureMedia();
    send({ type: 'call-accept', callId: state.callId });
    hideIncoming();
  });
  $('rejectBtn').addEventListener('click', () => {
    if (!state.callId) return;
    send({ type: 'call-reject', callId: state.callId });
    state.callId = null;
    hideIncoming();
  });
  $('micBtn').addEventListener('click', toggleMic);
  $('camBtn').addEventListener('click', toggleCam);
  setupPip();
  $('hangupBtn').addEventListener('click', () => leaveCall());

  window.addEventListener('beforeunload', () => {
    stopMedia();
    if (state.ws) state.ws.close();
  });
})();
