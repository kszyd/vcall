'use strict';

/**
 * VCall 信令服务 v2
 * 模型：连接 -> 注册终端 -> 在线通讯录 -> 点选呼叫（支持多人，Mesh 信令）
 * 不再使用房间号，每个终端由服务器分配唯一 ID（客户端可带 deviceId 复用）。
 */

const crypto = require('crypto');

const MAX_NAME = 24;
const MAX_DEVICE_FIELD = 48;
const RING_TIMEOUT_MS = 45 * 1000;
const ID_RE = /^[0-9A-Za-z_-]{4,16}$/;

function newId(prefix) {
  return (prefix || '') + crypto.randomBytes(4).toString('hex');
}

function cleanText(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function sanitizeDevice(device) {
  const source = device && typeof device === 'object' ? device : {};
  return {
    model: cleanText(source.model, MAX_DEVICE_FIELD),
    brand: cleanText(source.brand, MAX_DEVICE_FIELD),
    os: cleanText(source.os, MAX_DEVICE_FIELD),
    appVersion: cleanText(source.appVersion, MAX_DEVICE_FIELD),
    platform: cleanText(source.platform, MAX_DEVICE_FIELD) || 'unknown',
    isTv: Boolean(source.isTv),
  };
}

class SignalingService {
  constructor({ config, logger, apk }) {
    this.config = config;
    this.logger = logger;
    this.apk = apk || null;
    this.terminals = new Map(); // id -> terminal
    this.calls = new Map(); // callId -> call
    this.history = [];
    this.samples = [];
    this.startedAt = Date.now();
    this.totalCalls = 0;
    this.totalConnections = 0;

    setInterval(() => this._checkHeartbeats(), 10000).unref?.();
    setInterval(() => this._sample(), 5000).unref?.();
  }

  /* ------------------------------ 连接 ------------------------------ */

  handleConnection(ws) {
    const terminal = {
      id: newId('t'),
      ws,
      name: '',
      device: sanitizeDevice({}),
      state: 'idle',
      callId: null,
      registered: false,
      connectedAt: Date.now(),
      lastSeen: Date.now(),
      muted: { audio: false, video: false },
      stats: null,
      ip: ws.remoteAddress,
    };
    this.terminals.set(terminal.id, terminal);
    this.totalConnections += 1;

    ws.on('message', (text) => {
      terminal.lastSeen = Date.now();
      let msg;
      try {
        msg = JSON.parse(text);
      } catch (err) {
        this._sendError(terminal, 'bad_json', '消息格式错误');
        return;
      }
      if (!msg || typeof msg.type !== 'string') return;
      try {
        this._handleMessage(terminal, msg);
      } catch (err) {
        this.logger.error('处理消息失败', { type: msg.type, error: String(err && err.message) });
        this._sendError(terminal, 'internal', '服务器处理失败');
      }
    });
    ws.on('pong', () => {
      terminal.lastSeen = Date.now();
    });
    ws.on('close', () => this._disconnect(terminal, 'connection_closed'));
    ws.on('error', () => this._disconnect(terminal, 'socket_error'));

    this._send(terminal, {
      type: 'welcome',
      id: terminal.id,
      serverVersion: this.config.version,
      serverTime: Date.now(),
      iceServers: this.config.iceServers,
      maxCallMembers: this.config.maxCallMembers,
      ringTimeoutSeconds: Math.round(RING_TIMEOUT_MS / 1000),
      allowWebClient: this.config.allowWebClient,
      announcement: this.config.announcement,
      apk: this.apk ? this.apk.latest() : null,
    });
  }

  _disconnect(terminal, reason) {
    if (!this.terminals.has(terminal.id)) return;
    if (terminal.callId) this._leaveCall(terminal, terminal.callId, reason);

    this.terminals.delete(terminal.id);
    if (terminal.registered) {
      this.logger.info('终端离线', { id: terminal.id, name: terminal.name, reason });
      this._broadcastDirectory();
    }
  }

  /* ------------------------------ 消息分发 ------------------------------ */

  _handleMessage(terminal, msg) {
    switch (msg.type) {
      case 'register':
        this._register(terminal, msg);
        break;
      case 'call-invite':
        this._invite(terminal, msg);
        break;
      case 'call-accept':
        this._accept(terminal, msg);
        break;
      case 'call-reject':
        this._reject(terminal, msg);
        break;
      case 'call-cancel':
        this._cancel(terminal, msg);
        break;
      case 'call-leave':
      case 'hangup':
        this._leaveCall(terminal, msg.callId || terminal.callId, 'hangup');
        break;
      case 'offer':
      case 'answer':
      case 'ice':
        this._relay(terminal, msg);
        break;
      case 'state':
        this._state(terminal, msg);
        break;
      case 'stats':
        this._stats(terminal, msg);
        break;
      case 'ping':
        this._send(terminal, { type: 'pong', t: msg.t, serverTime: Date.now() });
        break;
      default:
        this._sendError(terminal, 'unknown_type', '未知消息类型');
    }
  }

  /* ------------------------------ 注册 ------------------------------ */

  _register(terminal, msg) {
    const name = cleanText(msg.name, MAX_NAME) || '未命名终端';
    const requested = cleanText(msg.deviceId, 16);

    if (requested && ID_RE.test(requested) && requested !== terminal.id && !this.terminals.has(requested)) {
      this.terminals.delete(terminal.id);
      terminal.id = requested;
      this.terminals.set(requested, terminal);
    }

    terminal.name = name;
    terminal.device = sanitizeDevice(msg.device);
    terminal.registered = true;

    this.logger.info('终端注册', {
      id: terminal.id,
      name,
      platform: terminal.device.platform,
      tv: terminal.device.isTv,
    });

    this._send(terminal, {
      type: 'registered',
      self: this._publicTerminal(terminal, true),
      apk: this.apk ? this.apk.latest() : null,
    });
    this._broadcastDirectory();
  }

  _broadcastDirectory() {
    const all = [...this.terminals.values()].filter((t) => t.registered);
    for (const viewer of all) {
      this._send(viewer, {
        type: 'directory',
        self: this._publicTerminal(viewer, true),
        terminals: all
          .filter((t) => t.id !== viewer.id)
          .map((t) => this._publicTerminal(t)),
      });
    }
  }

  _publicTerminal(terminal, self) {
    const base = {
      id: terminal.id,
      name: terminal.name,
      platform: terminal.device.platform,
      isTv: terminal.device.isTv,
      appVersion: terminal.device.appVersion,
      state: terminal.state,
      callId: terminal.callId,
      muted: terminal.muted,
    };
    if (self) base.model = terminal.device.model;
    return base;
  }

  /* ------------------------------ 呼叫 ------------------------------ */

  _invite(caller, msg) {
    if (!this._requireRegistered(caller)) return;
    if (caller.state !== 'idle') {
      this._sendError(caller, 'busy', '你当前正在通话中');
      return;
    }

    const rawTargets = Array.isArray(msg.targets) ? msg.targets : msg.to ? [msg.to] : [];
    const ids = [...new Set(rawTargets.map((x) => String(x)))].filter((id) => id && id !== caller.id);
    if (!ids.length) {
      this._sendError(caller, 'no_target', '请选择要呼叫的终端');
      return;
    }

    const max = this.config.maxCallMembers;

    // 目标全部处于同一个进行中的通话 -> 直接加入该通话（可随时进入）
    const busyInCall = ids
      .map((id) => this.terminals.get(id))
      .filter((t) => t && t.registered && t.state === 'busy' && t.callId);
    const callIds = new Set(busyInCall.map((t) => t.callId));
    if (busyInCall.length === ids.length && callIds.size === 1) {
      const targetCall = this.calls.get([...callIds][0]);
      if (targetCall) {
        this._joinExistingCall(caller, targetCall);
        return;
      }
    }

    const valid = [];
    for (const id of ids) {
      const target = this.terminals.get(id);
      if (!target || !target.registered) {
        this._send(caller, { type: 'call-failed', target: id, reason: 'offline' });
        continue;
      }
      if (target.state !== 'idle') {
        this._send(caller, { type: 'call-failed', target: id, reason: 'busy', name: target.name });
        continue;
      }
      valid.push(target);
    }
    if (!valid.length) {
      this._sendError(caller, 'no_available', '对方正忙或已离线');
      return;
    }
    if (valid.length + 1 > max) {
      this._sendError(caller, 'too_many', `最多同时通话 ${max} 人`);
      return;
    }

    const call = {
      id: newId('c'),
      video: msg.video !== false,
      createdAt: Date.now(),
      startedAt: 0,
      members: new Map([[caller.id, caller]]),
      names: new Set([caller.name]),
      invited: new Map(),
    };
    this.calls.set(call.id, call);

    caller.state = 'busy';
    caller.callId = call.id;

    for (const target of valid) {
      target.state = 'ringing';
      target.callId = call.id;
      const timer = setTimeout(() => this._ringTimeout(call.id, target.id), RING_TIMEOUT_MS);
      timer.unref?.();
      call.invited.set(target.id, { terminal: target, timer });
    }

    this._send(caller, {
      type: 'call-created',
      callId: call.id,
      video: call.video,
      members: [...call.members.values()].map((t) => this._publicTerminal(t)),
      invited: valid.map((t) => this._publicTerminal(t)),
      maxMembers: max,
    });

    for (const target of valid) {
      this._send(target, {
        type: 'call-incoming',
        callId: call.id,
        video: call.video,
        group: valid.length > 1,
        from: this._publicTerminal(caller),
        members: [...call.members.values()].map((t) => this._publicTerminal(t)),
      });
    }

    this.logger.info('发起呼叫', {
      call: call.id,
      from: caller.name,
      targets: valid.map((t) => t.name),
    });
    this._broadcastDirectory();
  }

  /** 已注册终端加入正在进行的通话（第三方可随时进入） */
  _joinExistingCall(caller, call) {
    if (call.members.has(caller.id)) {
      this._sendError(caller, 'already_in_call', '你已在该通话中');
      return;
    }
    const max = this.config.maxCallMembers;
    if (call.members.size + 1 > max) {
      this._sendError(caller, 'too_many', `该通话已达 ${max} 人上限`);
      return;
    }

    call.members.set(caller.id, caller);
    call.names.add(caller.name);
    caller.state = 'busy';
    caller.callId = call.id;
    if (!call.startedAt && call.members.size >= 2) {
      call.startedAt = Date.now();
      this.totalCalls += 1;
    }

    const others = [...call.members.values()].filter((t) => t.id !== caller.id);
    this._send(caller, {
      type: 'call-joined',
      callId: call.id,
      video: call.video,
      members: others.map((t) => this._publicTerminal(t)),
    });
    for (const member of others) {
      this._send(member, {
        type: 'call-member-joined',
        callId: call.id,
        member: this._publicTerminal(caller),
      });
    }

    this.logger.info('终端加入通话', {
      call: call.id,
      terminal: caller.name,
      members: call.members.size,
    });
    this._broadcastDirectory();
  }

  _accept(terminal, msg) {
    const call = this.calls.get(msg.callId);
    if (!call) {
      this._sendError(terminal, 'call_not_found', '通话已结束');
      return;
    }
    const invite = call.invited.get(terminal.id);
    if (!invite) {
      this._sendError(terminal, 'not_invited', '邀请已失效');
      return;
    }

    clearTimeout(invite.timer);
    call.invited.delete(terminal.id);
    call.members.set(terminal.id, terminal);
    call.names.add(terminal.name);
    terminal.state = 'busy';
    terminal.callId = call.id;
    if (!call.startedAt && call.members.size >= 2) {
      call.startedAt = Date.now();
      this.totalCalls += 1;
    }

    const others = [...call.members.values()].filter((t) => t.id !== terminal.id);
    this._send(terminal, {
      type: 'call-joined',
      callId: call.id,
      video: call.video,
      members: others.map((t) => this._publicTerminal(t)),
    });
    for (const other of others) {
      this._send(other, {
        type: 'call-member-joined',
        callId: call.id,
        member: this._publicTerminal(terminal),
      });
    }

    this.logger.info('接听', { call: call.id, terminal: terminal.name, members: call.members.size });
    this._broadcastDirectory();
  }

  _reject(terminal, msg) {
    const call = this.calls.get(msg.callId);
    if (!call) return;
    const invite = call.invited.get(terminal.id);
    if (invite) {
      clearTimeout(invite.timer);
      call.invited.delete(terminal.id);
    }
    terminal.state = 'idle';
    terminal.callId = null;

    for (const member of call.members.values()) {
      this._send(member, {
        type: 'call-rejected',
        callId: call.id,
        id: terminal.id,
        name: terminal.name,
      });
    }
    if (call.members.size <= 1 && call.invited.size === 0) this._endCall(call, 'rejected');
    this._broadcastDirectory();
  }

  _cancel(terminal, msg) {
    const call = this.calls.get(msg.callId || terminal.callId);
    if (!call) return;
    if (!call.members.has(terminal.id)) return;
    this._endCall(call, 'cancelled');
  }

  _leaveCall(terminal, callId, reason) {
    const call = callId ? this.calls.get(callId) : null;
    if (!call) {
      terminal.state = 'idle';
      terminal.callId = null;
      return;
    }

    // 被邀请者直接离开 = 拒绝
    if (call.invited.has(terminal.id)) {
      const invite = call.invited.get(terminal.id);
      clearTimeout(invite.timer);
      call.invited.delete(terminal.id);
      terminal.state = 'idle';
      terminal.callId = null;
      for (const member of call.members.values()) {
        this._send(member, {
          type: 'call-rejected',
          callId: call.id,
          id: terminal.id,
          name: terminal.name,
        });
      }
      if (call.members.size <= 1 && call.invited.size === 0) this._endCall(call, 'rejected');
      this._broadcastDirectory();
      return;
    }

    if (!call.members.has(terminal.id)) return;

    call.members.delete(terminal.id);
    terminal.state = 'idle';
    terminal.callId = null;

    for (const member of call.members.values()) {
      this._send(member, {
        type: 'call-member-left',
        callId: call.id,
        id: terminal.id,
        name: terminal.name,
        reason,
      });
    }

    if (call.members.size === 0) {
      this._endCall(call, 'empty');
      return;
    }
    if (call.members.size === 1) {
      this._endCall(call, 'last_left');
      return;
    }
    this._broadcastDirectory();
  }

  _endCall(call, reason) {
    if (!this.calls.has(call.id)) return;

    for (const invite of call.invited.values()) {
      clearTimeout(invite.timer);
      invite.terminal.state = 'idle';
      invite.terminal.callId = null;
      this._send(invite.terminal, { type: 'call-cancelled', callId: call.id, reason });
    }
    call.invited.clear();

    for (const member of call.members.values()) {
      member.state = 'idle';
      member.callId = null;
      this._send(member, { type: 'call-ended', callId: call.id, reason });
    }

    if (call.startedAt) {
      const endedAt = Date.now();
      const names = [...(call.names || [])].map((n) => (n || '').trim()).filter(Boolean);
      if (!names.length) {
        for (const m of call.members.values()) {
          const n = (m.alias || m.name || '').trim();
          if (n) names.push(n);
        }
      }
      this.history.unshift({
        id: call.id,
        startedAt: call.startedAt,
        endedAt,
        duration: Math.max(1, Math.round((endedAt - call.startedAt) / 1000)),
        members: call.members.size,
        names,
      });
      if (this.history.length > 100) this.history.pop();
    }

    this.calls.delete(call.id);
    this.logger.info('通话结束', { call: call.id, reason, members: call.members.size });
    this._broadcastDirectory();
  }

  _ringTimeout(callId, terminalId) {
    const call = this.calls.get(callId);
    if (!call) return;
    const invite = call.invited.get(terminalId);
    if (!invite) return;

    call.invited.delete(terminalId);
    invite.terminal.state = 'idle';
    invite.terminal.callId = null;
    this._send(invite.terminal, { type: 'call-cancelled', callId, reason: 'timeout' });

    for (const member of call.members.values()) {
      this._send(member, {
        type: 'call-timeout',
        callId,
        id: terminalId,
        name: invite.terminal.name,
      });
    }
    if (call.members.size <= 1 && call.invited.size === 0) this._endCall(call, 'timeout');
    this._broadcastDirectory();
  }

  _relay(terminal, msg) {
    if (!terminal.callId) {
      this._sendError(terminal, 'not_in_call', '不在通话中');
      return;
    }
    const target = this.terminals.get(msg.to);
    if (!target || target.callId !== terminal.callId) {
      this._sendError(terminal, 'peer_not_found', '对方已离开通话');
      return;
    }
    const payload = { type: msg.type, from: terminal.id, callId: terminal.callId };
    if (msg.type === 'ice') payload.candidate = msg.candidate;
    else payload.sdp = msg.sdp;
    this._send(target, payload);
  }

  _state(terminal, msg) {
    const muted = msg.muted && typeof msg.muted === 'object' ? msg.muted : {};
    terminal.muted = { audio: Boolean(muted.audio), video: Boolean(muted.video) };
    if (!terminal.callId) return;
    const call = this.calls.get(terminal.callId);
    if (!call) return;
    for (const member of call.members.values()) {
      if (member.id === terminal.id) continue;
      this._send(member, { type: 'member-state', callId: call.id, id: terminal.id, muted: terminal.muted });
    }
  }

  _stats(terminal, msg) {
    terminal.stats = {
      rtt: Number(msg.rtt) || 0,
      bitrate: Number(msg.bitrate) || 0,
      width: Number(msg.width) || 0,
      height: Number(msg.height) || 0,
      fps: Number(msg.fps) || 0,
      updatedAt: Date.now(),
    };
  }

  _requireRegistered(terminal) {
    if (!terminal.registered) {
      this._sendError(terminal, 'not_registered', '请先登录');
      return false;
    }
    return true;
  }

  _send(terminal, payload) {
    try {
      terminal.ws.send(payload);
    } catch (err) {
      // 连接已断开
    }
  }

  _sendError(terminal, code, message) {
    this._send(terminal, { type: 'error', code, message });
  }

  _checkHeartbeats() {
    const now = Date.now();
    for (const terminal of this.terminals.values()) {
      if (now - terminal.lastSeen > this.config.heartbeatTimeoutSeconds * 1000) {
        this.logger.warn('心跳超时', { id: terminal.id, name: terminal.name });
        try {
          terminal.ws.close(4000, 'heartbeat timeout');
        } catch (err) {
          // ignore
        }
        this._disconnect(terminal, 'heartbeat_timeout');
      } else {
        try {
          terminal.ws.ping();
        } catch (err) {
          // ignore
        }
      }
    }
  }

  _sample() {
    this.samples.push({
      t: Date.now(),
      online: this.onlineCount(),
      calls: this.activeCalls(),
    });
    if (this.samples.length > 180) this.samples.shift();
  }

  onlineCount() {
    let count = 0;
    for (const terminal of this.terminals.values()) if (terminal.registered) count += 1;
    return count;
  }

  activeCalls() {
    let count = 0;
    for (const call of this.calls.values()) if (call.members.size >= 2) count += 1;
    return count;
  }

  /* ------------------------------ 管理接口 ------------------------------ */

  kick(terminalId) {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) return { ok: false, error: 'terminal_not_found' };
    const name = terminal.name;
    this._send(terminal, { type: 'kicked', reason: '管理员已将终端下线' });
    this.logger.warn('管理员下线终端', { id: terminal.id, name });
    this._disconnect(terminal, 'kicked');
    try {
      terminal.ws.close(4001, 'kicked by admin');
    } catch (err) {
      // ignore
    }
    return { ok: true, name };
  }

  overview() {
    const now = Date.now();
    let peak = 0;
    for (const sample of this.samples) peak = Math.max(peak, sample.online);
    return {
      serverTime: now,
      startedAt: this.startedAt,
      uptimeSeconds: Math.round((now - this.startedAt) / 1000),
      onlineTerminals: this.onlineCount(),
      activeCalls: this.activeCalls(),
      totalCalls: this.totalCalls,
      totalConnections: this.totalConnections,
      peakOnline: Math.max(peak, this.onlineCount()),
      maxCallMembers: this.config.maxCallMembers,
      version: this.config.version,
      announcement: this.config.announcement,
    };
  }

  listTerminals() {
    const now = Date.now();
    return [...this.terminals.values()]
      .filter((t) => t.registered)
      .map((t) => ({
        id: t.id,
        name: t.name,
        ip: t.ip,
        platform: t.device.platform,
        model: t.device.model,
        os: t.device.os,
        appVersion: t.device.appVersion,
        isTv: t.device.isTv,
        state: t.state,
        callId: t.callId,
        muted: t.muted,
        onlineSeconds: Math.round((now - t.connectedAt) / 1000),
        stats: t.stats,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  listCalls() {
    const now = Date.now();
    return [...this.calls.values()]
      .map((call) => ({
        id: call.id,
        createdAt: call.createdAt,
        inCall: call.members.size >= 2,
        durationSeconds: call.startedAt ? Math.round((now - call.startedAt) / 1000) : 0,
        members: [...call.members.values()].map((t) => ({
          id: t.id,
          name: t.name,
          ip: t.ip,
          platform: t.device.platform,
          model: t.device.model,
          isTv: t.device.isTv,
          muted: t.muted,
          stats: t.stats,
        })),
        invited: [...call.invited.values()].map((invite) => ({
          id: invite.terminal.id,
          name: invite.terminal.name,
        })),
      }))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /** 把公告即时推送到所有在线终端 */
  broadcastAnnouncement(text) {
    const message = typeof text === 'string' ? text : '';
    let count = 0;
    for (const terminal of this.terminals.values()) {
      if (!terminal.registered) continue;
      this._send(terminal, { type: 'announcement', text: message });
      count += 1;
    }
    this.logger.info('已推送公告', { terminals: count, text: message });
    return count;
  }

  /** 推送新版本 APK 给所有在线终端 */
  broadcastApkUpdate(info) {
    if (!info) return 0;
    let count = 0;
    for (const terminal of this.terminals.values()) {
      if (!terminal.registered) continue;
      this._send(terminal, { type: 'apk-update', ...info });
      count += 1;
    }
    this.logger.info('已推送 APK 更新', { terminals: count, version: info.version });
    return count;
  }

  metrics() {
    return { samples: this.samples, history: this.history.slice(0, 50) };
  }
}

module.exports = { SignalingService, cleanText, sanitizeDevice };
