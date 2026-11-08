'use strict';

(function () {
  const TOKEN_KEY = 'vcall.admin.token';
  const REFRESH_MS = 3000;

  const state = {
    token: sessionStorage.getItem(TOKEN_KEY) || '',
    timer: null,
    overview: null,
    lastRooms: [],
    loading: false,
    failures: 0,
  };

  const $ = (id) => document.getElementById(id);

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  function toast(message) {
    const node = $('toast');
    node.textContent = message;
    node.classList.remove('hidden');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => node.classList.add('hidden'), 2600);
  }

  async function api(path, options = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (state.token) headers.Authorization = 'Bearer ' + state.token;
    const res = await fetch(path, { ...options, headers });
    let data = {};
    try {
      data = await res.json();
    } catch (err) {
      data = {};
    }
    if (res.status === 401) {
      logout(true);
      throw new Error('登录已过期');
    }
    if (!res.ok) throw new Error(data.error || '请求失败 (' + res.status + ')');
    return data;
  }

  /* ------------------------------ 登录 ------------------------------ */

  async function login(event) {
    event.preventDefault();
    const btn = $('loginBtn');
    const error = $('loginError');
    error.textContent = '';
    btn.disabled = true;
    btn.textContent = '登录中…';
    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: $('username').value.trim(),
          password: $('password').value,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.token) throw new Error(data.error || '登录失败');
      state.token = data.token;
      sessionStorage.setItem(TOKEN_KEY, data.token);
      showApp();
      startPolling();
    } catch (err) {
      error.textContent = err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = '登录';
    }
  }

  function logout(silent) {
    state.token = '';
    sessionStorage.removeItem(TOKEN_KEY);
    stopPolling();
    $('appView').classList.add('hidden');
    $('loginView').classList.remove('hidden');
    $('password').value = '';
    if (!silent) toast('已退出登录');
  }

  function showApp() {
    $('loginView').classList.add('hidden');
    $('appView').classList.remove('hidden');
  }

  /* ------------------------------ 轮询 ------------------------------ */

  function startPolling() {
    stopPolling();
    refresh();
    state.timer = setInterval(refresh, REFRESH_MS);
  }

  function stopPolling() {
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
  }

  async function refresh() {
    if (state.loading || !state.token) return;
    state.loading = true;
    try {
      const [overview, rooms, devices, metrics, logs] = await Promise.all([
        api('/api/admin/overview'),
        api('/api/admin/rooms'),
        api('/api/admin/devices'),
        api('/api/admin/metrics'),
        api('/api/admin/logs?limit=80' + (($('logLevel').value) ? '&level=' + $('logLevel').value : '')),
      ]);
      state.failures = 0;
      setConnected(true);
      renderOverview(overview.overview);
      renderRooms(rooms.rooms);
      renderDevices(devices.devices);
      renderMetrics(metrics.samples);
      renderHistory(metrics.history);
      renderLogs(logs.logs);
    } catch (err) {
      state.failures += 1;
      if (state.failures >= 2) setConnected(false);
    } finally {
      state.loading = false;
    }
  }

  function setConnected(ok) {
    const pill = $('connState');
    pill.textContent = ok ? '● 已连接' : '● 连接中断';
    pill.classList.toggle('off', !ok);
  }

  /* ------------------------------ 渲染 ------------------------------ */

  function formatDuration(seconds) {
    const s = Math.max(0, Math.round(seconds || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return h + ' 小时 ' + m + ' 分';
    if (m > 0) return m + ' 分 ' + sec + ' 秒';
    return sec + ' 秒';
  }

  function formatClock(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  function renderOverview(o) {
    state.overview = o;
    $('statOnline').textContent = o.onlineDevices;
    $('statPeak').textContent = '峰值 ' + o.peakOnline;
    $('statRooms').textContent = o.activeRooms;
    $('statCalls').textContent = o.activeCalls;
    $('statTotalCalls').textContent = '累计 ' + o.totalCalls + ' 次';
    $('statUptime').textContent =
      o.uptimeSeconds >= 3600
        ? Math.floor(o.uptimeSeconds / 3600) + 'h'
        : Math.floor(o.uptimeSeconds / 60) + 'm';
    $('statVersion').textContent = 'v' + o.version;
    $('footVersion').textContent = 'v' + o.version;
    $('serverInfo').textContent =
      '运行 ' + formatDuration(o.uptimeSeconds) + ' · 单房间上限 ' + o.maxRoomMembers + ' 人';

    if (document.activeElement !== $('announcement')) $('announcement').value = o.announcement || '';
    if (document.activeElement !== $('maxMembers')) $('maxMembers').value = o.maxRoomMembers;
  }

  function renderRooms(rooms) {
    const body = $('roomsBody');
    body.textContent = '';
    $('roomsMeta').textContent = '共 ' + rooms.length + ' 个';
    state.lastRooms = rooms;

    if (!rooms.length) {
      const tr = el('tr');
      const td = el('td', 'empty', '暂无房间，等待设备加入');
      td.colSpan = 6;
      tr.appendChild(td);
      body.appendChild(tr);
      return;
    }

    for (const room of rooms) {
      const tr = el('tr');

      const tdId = el('td');
      tdId.appendChild(el('span', 'room-id', room.id));
      tr.appendChild(tdId);

      const tdMembers = el('td');
      for (const member of room.members) {
        const line = el('div', 'member');
        line.appendChild(el('span', '', member.name || '未命名'));
        if (member.isTv) line.appendChild(el('span', 'tag tv', 'TV'));
        if (member.muted && member.muted.video) line.appendChild(el('span', 'tag muted', '关视频'));
        if (member.muted && member.muted.audio) line.appendChild(el('span', 'tag muted', '静音'));
        tdMembers.appendChild(line);
      }
      tr.appendChild(tdMembers);

      const tdState = el('td');
      tdState.appendChild(
        el('span', 'tag' + (room.inCall ? ' live' : ''), room.inCall ? '通话中' : '等待中')
      );
      tr.appendChild(tdState);

      const tdDur = el('td', 'mono', room.inCall ? formatDuration(room.callDurationSeconds) : '—');
      tr.appendChild(tdDur);

      const tdMedia = el('td');
      const stats = room.members.find((m) => m.stats)?.stats;
      if (stats) {
        const parts = [];
        if (stats.width && stats.height) parts.push(stats.width + '×' + stats.height);
        if (stats.fps) parts.push(stats.fps + 'fps');
        if (stats.bitrate) parts.push(Math.round(stats.bitrate / 1000) + 'kbps');
        if (stats.rtt) parts.push(stats.rtt + 'ms');
        tdMedia.appendChild(el('span', 'mono', parts.join(' · ') || '—'));
      } else {
        tdMedia.appendChild(el('span', 'mono', '—'));
      }
      tr.appendChild(tdMedia);

      const tdAction = el('td', 'right');
      for (const member of room.members) {
        const btn = el('button', 'btn danger small', '断开 ' + (member.name || '设备'));
        btn.type = 'button';
        btn.addEventListener('click', () => kick(room.id, member.id, member.name));
        btn.style.marginLeft = '6px';
        tdAction.appendChild(btn);
      }
      tr.appendChild(tdAction);
      body.appendChild(tr);
    }
  }

  function renderDevices(devices) {
    const body = $('devicesBody');
    body.textContent = '';
    $('devicesMeta').textContent = devices.length + ' 台';
    if (!devices.length) {
      const tr = el('tr');
      const td = el('td', 'empty', '暂无在线设备');
      td.colSpan = 5;
      tr.appendChild(td);
      body.appendChild(tr);
      return;
    }
    for (const device of devices) {
      const tr = el('tr');
      const tdName = el('td');
      tdName.appendChild(el('div', '', device.name || '未命名'));
      const meta = [device.model, device.appVersion ? 'v' + device.appVersion : '']
        .filter(Boolean)
        .join(' · ');
      if (meta) tdName.appendChild(el('div', 'mono', meta));
      tr.appendChild(tdName);

      const tdPlatform = el('td');
      tdPlatform.appendChild(
        el('span', 'tag' + (device.isTv ? ' tv' : ''), device.isTv ? '电视' : device.platform || '手机')
      );
      tr.appendChild(tdPlatform);

      tr.appendChild(el('td', 'room-id', device.room || '—'));
      tr.appendChild(el('td', 'mono', device.ip || '—'));
      tr.appendChild(el('td', 'mono', formatDuration(device.onlineSeconds)));
      body.appendChild(tr);
    }
  }

  function renderHistory(history) {
    const body = $('historyBody');
    body.textContent = '';
    if (!history || !history.length) {
      const tr = el('tr');
      const td = el('td', 'empty', '暂无通话记录');
      td.colSpan = 4;
      tr.appendChild(td);
      body.appendChild(tr);
      return;
    }
    for (const item of history.slice(0, 20)) {
      const tr = el('tr');
      tr.appendChild(el('td', 'room-id', item.room));
      tr.appendChild(el('td', 'mono', formatClock(item.startedAt)));
      tr.appendChild(el('td', '', formatDuration(item.duration)));
      tr.appendChild(el('td', 'mono', String(item.members || 0)));
      body.appendChild(tr);
    }
  }

  function renderMetrics(samples) {
    const svg = $('chart');
    const width = 600;
    const height = 160;
    const pad = 8;
    svg.textContent = '';
    const data = (samples || []).slice(-120);
    if (data.length < 2) {
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('x', width / 2);
      text.setAttribute('y', height / 2);
      text.setAttribute('fill', '#64748b');
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('font-size', '12');
      text.textContent = '正在采集数据…';
      svg.appendChild(text);
      return;
    }

    const maxOnline = Math.max(1, ...data.map((s) => s.online));
    const maxCalls = Math.max(1, ...data.map((s) => s.calls));
    const max = Math.max(maxOnline, maxCalls);

    const buildPath = (key) =>
      data
        .map((sample, index) => {
          const x = pad + (index / (data.length - 1)) * (width - pad * 2);
          const y = height - pad - (sample[key] / max) * (height - pad * 2);
          return (index === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1);
        })
        .join(' ');

    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    defs.innerHTML =
      '<linearGradient id="fillGrad" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="#3b82f6" stop-opacity="0.28"/>' +
      '<stop offset="100%" stop-color="#3b82f6" stop-opacity="0"/>' +
      '</linearGradient>';
    svg.appendChild(defs);

    const area = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    const linePath = buildPath('online');
    area.setAttribute('d', linePath + ' L' + (width - pad) + ',' + (height - pad) + ' L' + pad + ',' + (height - pad) + ' Z');
    area.setAttribute('fill', 'url(#fillGrad)');
    svg.appendChild(area);

    const online = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    online.setAttribute('d', linePath);
    online.setAttribute('fill', 'none');
    online.setAttribute('stroke', '#3b82f6');
    online.setAttribute('stroke-width', '2');
    online.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(online);

    const calls = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    calls.setAttribute('d', buildPath('calls'));
    calls.setAttribute('fill', 'none');
    calls.setAttribute('stroke', '#22d3ee');
    calls.setAttribute('stroke-width', '1.6');
    calls.setAttribute('stroke-dasharray', '4 3');
    svg.appendChild(calls);
  }

  function renderLogs(logs) {
    const box = $('logs');
    box.textContent = '';
    if (!logs || !logs.length) {
      box.appendChild(el('div', 'log-line', '暂无日志'));
      return;
    }
    for (const entry of logs.slice().reverse()) {
      const line = el('div', 'log-line');
      const time = new Date(entry.ts);
      const pad = (n) => String(n).padStart(2, '0');
      line.appendChild(
        el('span', 'log-time', pad(time.getHours()) + ':' + pad(time.getMinutes()) + ':' + pad(time.getSeconds()))
      );
      line.appendChild(el('span', 'log-level ' + entry.level, entry.level.toUpperCase()));
      line.appendChild(el('span', 'log-msg', entry.message));
      box.appendChild(line);
    }
  }

  /* ------------------------------ 操作 ------------------------------ */

  async function kick(roomId, peerId, name) {
    if (!confirm('确认断开「' + (name || '该设备') + '」？')) return;
    try {
      await api('/api/admin/rooms/' + encodeURIComponent(roomId) + '/kick', {
        method: 'POST',
        body: JSON.stringify({ peerId }),
      });
      toast('已断开 ' + (name || '设备'));
      refresh();
    } catch (err) {
      toast(err.message);
    }
  }

  async function saveSettings() {
    const btn = $('saveSettings');
    btn.disabled = true;
    try {
      await api('/api/admin/settings', {
        method: 'POST',
        body: JSON.stringify({
          announcement: $('announcement').value,
          maxRoomMembers: Number($('maxMembers').value),
        }),
      });
      $('settingsHint').textContent = '已保存 · ' + formatClock(Date.now());
      toast('设置已保存');
    } catch (err) {
      toast(err.message);
    } finally {
      btn.disabled = false;
    }
  }

  /* ------------------------------ 初始化 ------------------------------ */

  $('loginForm').addEventListener('submit', login);
  $('logoutBtn').addEventListener('click', () => logout(false));
  $('saveSettings').addEventListener('click', saveSettings);
  $('refreshLogs').addEventListener('click', refresh);
  $('logLevel').addEventListener('change', refresh);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopPolling();
    else if (state.token) startPolling();
  });

  if (state.token) {
    showApp();
    startPolling();
  } else {
    $('username').focus();
  }
})();
