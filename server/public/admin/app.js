'use strict';

(function () {
  const TOKEN_KEY = 'vcall.admin.token';
  const REFRESH_MS = 3000;

  const state = {
    token: sessionStorage.getItem(TOKEN_KEY) || '',
    timer: null,
    failures: 0,
    loading: false,
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
      const [overview, calls, terminals, metrics, logs] = await Promise.all([
        api('/api/admin/overview'),
        api('/api/admin/calls'),
        api('/api/admin/terminals'),
        api('/api/admin/metrics'),
        api('/api/admin/logs?limit=80' + ($('logLevel').value ? '&level=' + $('logLevel').value : '')),
      ]);
      state.failures = 0;
      setConnected(true);
      renderOverview(overview.overview);
      renderCalls(calls.calls || []);
      renderTerminals(terminals.terminals || []);
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

  /* ------------------------------ 格式化 ------------------------------ */

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

  /* ------------------------------ 渲染 ------------------------------ */

  function renderOverview(o) {
    $('statOnline').textContent = o.onlineTerminals;
    $('statPeak').textContent = '峰值 ' + o.peakOnline;
    $('statRooms').textContent = o.activeCalls;
    $('statCalls').textContent = o.totalCalls;
    $('statTotalCalls').textContent = '共 ' + o.totalCalls + ' 次';
    $('statUptime').textContent =
      o.uptimeSeconds >= 3600
        ? Math.floor(o.uptimeSeconds / 3600) + 'h'
        : Math.floor(o.uptimeSeconds / 60) + 'm';
    $('statVersion').textContent = 'v' + o.version;
    $('footVersion').textContent = 'v' + o.version;
    $('serverInfo').textContent =
      '运行 ' + formatDuration(o.uptimeSeconds) + ' · 单次通话上限 ' + o.maxCallMembers + ' 人';

    if (document.activeElement !== $('announcement')) $('announcement').value = o.announcement || '';
    if (document.activeElement !== $('maxMembers')) $('maxMembers').value = o.maxCallMembers;
  }

  function stateLabel(state) {
    if (state === 'busy') return '通话中';
    if (state === 'ringing') return '响铃中';
    return '空闲';
  }

  function renderCalls(calls) {
    const body = $('roomsBody');
    body.textContent = '';
    $('roomsMeta').textContent = '共 ' + calls.length + ' 个';

    if (!calls.length) {
      const tr = el('tr');
      const td = el('td', 'empty', '暂无通话，等待终端发起');
      td.colSpan = 6;
      tr.appendChild(td);
      body.appendChild(tr);
      return;
    }

    for (const call of calls) {
      const tr = el('tr');

      const tdId = el('td');
      const memberNames = call.members.map((m) => m.alias || m.name || '未命名');
      const whoText = memberNames.length
        ? memberNames.slice(0, 3).join('、') + (memberNames.length > 3 ? ' 等 ' + memberNames.length + ' 人' : '')
        : '呼叫中';
      const whoEl = el('span', '', whoText);
      whoEl.title = call.id;
      tdId.appendChild(whoEl);
      tr.appendChild(tdId);

      const tdMembers = el('td');
      for (const member of call.members) {
        const line = el('div', 'member');
        line.appendChild(el('span', '', member.name || '未命名'));
        if (member.isTv) line.appendChild(el('span', 'tag tv', 'TV'));
        if (member.muted && member.muted.video) line.appendChild(el('span', 'tag muted', '关视频'));
        if (member.muted && member.muted.audio) line.appendChild(el('span', 'tag muted', '静音'));
        tdMembers.appendChild(line);
      }
      if (call.invited && call.invited.length) {
        tdMembers.appendChild(el('div', 'mono', '邀请中：' + call.invited.map((x) => x.name).join('、')));
      }
      tr.appendChild(tdMembers);

      const tdState = el('td');
      tdState.appendChild(el('span', 'tag' + (call.inCall ? ' live' : ''), call.inCall ? '通话中' : '呼叫中'));
      tr.appendChild(tdState);

      const tdDur = el('td', 'mono', call.inCall ? formatDuration(call.durationSeconds) : '—');
      tr.appendChild(tdDur);

      const tdMedia = el('td');
      const stat = call.members.find((m) => m.stats)?.stats;
      if (stat) {
        const parts = [];
        if (stat.width && stat.height) parts.push(stat.width + '×' + stat.height);
        if (stat.fps) parts.push(stat.fps + 'fps');
        if (stat.bitrate) parts.push(Math.round(stat.bitrate / 1000) + 'kbps');
        if (stat.rtt) parts.push(stat.rtt + 'ms');
        tdMedia.appendChild(el('span', 'mono', parts.join(' · ') || '—'));
      } else {
        tdMedia.appendChild(el('span', 'mono', '—'));
      }
      tr.appendChild(tdMedia);

      const tdAction = el('td', 'right');
      for (const member of call.members) {
        const btn = el('button', 'btn danger small', '下线 ' + (member.name || '终端'));
        btn.type = 'button';
        btn.addEventListener('click', () => kick(member.id, member.name));
        btn.style.marginLeft = '6px';
        tdAction.appendChild(btn);
      }
      tr.appendChild(tdAction);
      body.appendChild(tr);
    }
  }

  function renderTerminals(terminals) {
    const body = $('devicesBody');
    body.textContent = '';
    $('devicesMeta').textContent = terminals.length + ' 台';
    if (!terminals.length) {
      const tr = el('tr');
      const td = el('td', 'empty', '暂无在线终端');
      td.colSpan = 5;
      tr.appendChild(td);
      body.appendChild(tr);
      return;
    }
    for (const item of terminals) {
      const tr = el('tr');
      const tdName = el('td');
      tdName.appendChild(el('div', '', item.name || '未命名'));
      const meta = [item.model, item.appVersion ? 'v' + item.appVersion : ''].filter(Boolean).join(' · ');
      if (meta) tdName.appendChild(el('div', 'mono', meta));
      tr.appendChild(tdName);

      const tdPlatform = el('td');
      tdPlatform.appendChild(el('span', 'tag' + (item.isTv ? ' tv' : ''), item.isTv ? '电视' : item.platform || '手机'));
      tr.appendChild(tdPlatform);

      const tdState = el('td');
      tdState.appendChild(el('span', 'tag' + (item.state === 'busy' ? ' live' : ''), stateLabel(item.state)));
      tr.appendChild(tdState);

      tr.appendChild(el('td', 'mono', item.ip || '—'));
      tr.appendChild(el('td', 'mono', formatDuration(item.onlineSeconds)));
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
      const tdWho = el('td');
      const whoNames = (item.names || []).filter(Boolean);
      const whoEl = el('span', '', whoNames.length ? whoNames.join('、') : item.id);
      whoEl.title = item.id;
      tdWho.appendChild(whoEl);
      tr.appendChild(tdWho);
      tr.appendChild(el('td', 'mono', formatClock(item.startedAt)));
      tr.appendChild(el('td', '', formatDuration(item.duration)));
      tr.appendChild(el('td', 'mono', String(item.members || 0)));
      body.appendChild(tr);
    }
  }

  function renderMetrics(samples) {
    const svg = $('chart');
    const width = 1200;
    const height = 160;
    const pad = 8;
    svg.textContent = '';

    // 背景网格线，避免数据少时画面过空
    for (let i = 1; i <= 3; i += 1) {
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      const y = (height / 4) * i;
      line.setAttribute('x1', pad);
      line.setAttribute('x2', width - pad);
      line.setAttribute('y1', y);
      line.setAttribute('y2', y);
      line.setAttribute('stroke', 'rgba(31, 45, 71, 0.85)');
      line.setAttribute('stroke-width', '1');
      line.setAttribute('stroke-dasharray', '4 6');
      svg.appendChild(line);
    }

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

    const max = Math.max(1, ...data.map((s) => s.online), ...data.map((s) => s.calls));

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

  async function kick(terminalId, name) {
    if (!confirm('确认将「' + (name || '该终端') + '」下线？')) return;
    try {
      await api('/api/admin/terminals/' + encodeURIComponent(terminalId) + '/kick', {
        method: 'POST',
        body: '{}',
      });
      toast('已下线 ' + (name || '终端'));
      refresh();
    } catch (err) {
      toast(err.message);
    }
  }

  async function pushAnnouncement() {
    const btn = $('pushAnnouncement');
    btn.disabled = true;
    try {
      const data = await api('/api/admin/announcement', {
        method: 'POST',
        body: JSON.stringify({ text: $('announcement').value }),
      });
      const online = data.online || 0;
      $('announcementHint').textContent =
        (data.text ? '公告已推送到 ' : '公告已清除，并通知 ') + online + ' 台在线终端 · ' + formatClock(Date.now());
      toast(data.text ? '公告已推送到 ' + online + ' 台在线终端' : '公告已清除');
    } catch (err) {
      toast(err.message);
      $('announcementHint').textContent = '推送失败：' + err.message;
    } finally {
      btn.disabled = false;
    }
  }

  async function saveLimits() {
    const btn = $('saveLimits');
    btn.disabled = true;
    try {
      const data = await api('/api/admin/limits', {
        method: 'POST',
        body: JSON.stringify({ maxCallMembers: Number($('maxMembers').value) }),
      });
      $('maxMembers').value = data.maxCallMembers;
      $('limitsHint').textContent = '已保存：最多 ' + data.maxCallMembers + ' 人 · ' + formatClock(Date.now());
      toast('通话人数上限已保存');
    } catch (err) {
      toast(err.message);
      $('limitsHint').textContent = '保存失败：' + err.message;
    } finally {
      btn.disabled = false;
    }
  }

  /* ------------------------------ 初始化 ------------------------------ */

  $('loginForm').addEventListener('submit', login);
  $('logoutBtn').addEventListener('click', () => logout(false));
  // 网页通话走 HTTPS（9443），按当前访问的主机名自动拼接
  const webCallLink = $('webCallLink');
  if (webCallLink) {
    const host = location.hostname || '192.168.199.100';
    webCallLink.href = 'https://' + host + ':9443/call';
  }
  $('pushAnnouncement').addEventListener('click', pushAnnouncement);
  $('saveLimits').addEventListener('click', saveLimits);
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
