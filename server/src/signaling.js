'use strict';

const crypto = require('crypto');

const ROOM_RE = /^[0-9A-Za-z_-]{1,32}$/;
const MAX_NAME = 24;
const MAX_DEVICE_FIELD = 48;

function newId() {
  return crypto.randomBytes(5).toString('hex');
}

function cleanText(value, maxLength) {
  if (typeof value !== 'string') return '';
  // 去掉控制字符，压缩空白
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, maxLength);
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
  constructor({ config, logger }) {
    this.config = config;
    this.logger = logger;
    this.peers = new Map(); // id -> peer
    this.rooms = new Map(); // roomId -> room
    this.history = []; // 通话记录
    this.samples = []; // 指标采样
    this.startedAt = Date.now();
    this.totalCalls = 0;
    this.totalConnections = 0;

    this._heartbeat = setInterval(() => this._checkHeartbeats(), 10000);
    this._heartbeat.unref?.();

    this._sampler = setInterval(() => this._sample(), 5000);
    this._sampler.unref?.();
  }

  /* ------------------------------ 连接生命周期 ------------------------------ */

  handleConnection(ws) {
    const peer = {
      id: newId(),
      ws,
      name: '',
      roomId: null,
      device: sanitizeDevice({}),
      ip: ws.remoteAddress,
      userAgent: ws.userAgent,
      joinedAt: Date.now(),
      lastSeen: Date.now(),
      muted: { audio: false, video: false },
      stats: null,
    };
    this.peers.set(peer.id, peer);
    this.totalConnections += 1;

    ws.on('message', (text) => {
      peer.lastSeen = Date.now();
      let msg;
      try {
        msg = JSON.parse(text);
      } catch (err) {
        this._send(peer, { type: 'error', code: 'bad_json', message: '消息格式错误' });
        return;
      }
      if (!msg || typeof msg.type !== 'string') return;
      try {
        this._handleMessage(peer, msg);
      } catch (err) {
        this.logger.error('处理消息失败', { type: msg.type, error: String(err && err.message) });
        this._send(peer, { type: 'error', code: 'internal', message: '服务器处理失败' });
      }
    });

    ws.on('close', () => this._disconnect(peer, 'connection_closed'));
    ws.on('error', () => this._disconnect(peer, 'socket_error'));

    this._send(peer, {
      type: 'welcome',
      id: peer.id,
      serverVersion: this.config.version,
      serverTime: Date.now(),
      iceServers: this.config.iceServers,
      maxRoomMembers: this.config.maxRoomMembers,
      heartbeatSeconds: this.config.heartbeatSeconds,
      defaultRoom: this.config.defaultRoom,
      announcement: this.config.announcement,
      allowWebClient: this.config.allowWebClient,
    });
  }

  _disconnect(peer, reason) {
    if (!this.peers.has(peer.id)) return;
    this.peers.delete(peer.id);
    if (peer.roomId) this._leaveRoom(peer, reason);
  }

  /* -------------------------------- 消息处理 -------------------------------- */

  _handleMessage(peer, msg) {
    switch (msg.type) {
      case 'join':
        this._join(peer, msg);
        break;
      case 'offer':
      case 'answer':
      case 'ice':
        this._relay(peer, msg);
        break;
      case 'hangup':
        this._hangup(peer, msg);
        break;
      case 'state':
        this._peerState(peer, msg);
        break;
      case 'stats':
        this._peerStats(peer, msg);
        break;
      case 'ping':
        this._send(peer, { type: 'pong', t: msg.t, serverTime: Date.now() });
        break;
      case 'leave':
        if (peer.roomId) this._leaveRoom(peer, 'client_leave');
        break;
      default:
        this._send(peer, { type: 'error', code: 'unknown_type', message: '未知消息类型' });
    }
  }

  _join(peer, msg) {
    const roomId = cleanText(msg.room, 32);
    const name = cleanText(msg.name, MAX_NAME) || '未命名设备';

    if (!ROOM_RE.test(roomId)) {
      this._send(peer, {
        type: 'error',
        code: 'bad_room',
        message: '房间号只能包含字母、数字、下划线和短横线（1-32 位）',
      });
      return;
    }

    let room = this.rooms.get(roomId);
    if (!room) {
      if (this.rooms.size >= this.config.maxRooms) {
        this._send(peer, { type: 'error', code: 'server_busy', message: '服务器房间数已达上限' });
        return;
      }
      room = {
        id: roomId,
        members: new Map(),
        createdAt: Date.now(),
        callStartedAt: 0,
        lastActiveAt: Date.now(),
        totalJoins: 0,
      };
      this.rooms.set(roomId, room);
    }

    if (room.members.size >= this.config.maxRoomMembers && !room.members.has(peer.id)) {
      this._send(peer, {
        type: 'error',
        code: 'room_full',
        message: `房间已满（最多 ${this.config.maxRoomMembers} 人）`,
      });
      this.logger.warn('房间已满，拒绝加入', { room: roomId, peer: peer.name || peer.id });
      return;
    }

    // 若已在其他房间，先退出
    if (peer.roomId && peer.roomId !== roomId) this._leaveRoom(peer, 'switch_room');

    peer.roomId = roomId;
    peer.name = name;
    peer.device = sanitizeDevice(msg.device);
    peer.joinedAt = Date.now();
    peer.muted = { audio: false, video: false };
    peer.stats = null;
    room.members.set(peer.id, peer);
    room.lastActiveAt = Date.now();
    room.totalJoins += 1;
    if (room.members.size >= 2 && !room.callStartedAt) {
      room.callStartedAt = Date.now();
      this.totalCalls += 1;
    }

    const others = [];
    for (const member of room.members.values()) {
      if (member.id === peer.id) continue;
      others.push(this._publicPeer(member));
    }

    this._send(peer, {
      type: 'joined',
      room: roomId,
      self: { id: peer.id, name: peer.name },
      peers: others,
      callStartedAt: room.callStartedAt || 0,
      maxRoomMembers: this.config.maxRoomMembers,
    });

    for (const member of room.members.values()) {
      if (member.id === peer.id) continue;
      this._send(member, { type: 'peer-joined', peer: this._publicPeer(peer) });
    }

    this.logger.info('设备加入房间', {
      room: roomId,
      device: peer.name,
      platform: peer.device.platform,
      members: room.members.size,
    });
  }

  _publicPeer(peer) {
    return {
      id: peer.id,
      name: peer.name,
      device: peer.device,
      muted: peer.muted,
      joinedAt: peer.joinedAt,
    };
  }

  _relay(peer, msg) {
    if (!peer.roomId) {
      this._send(peer, { type: 'error', code: 'not_in_room', message: '尚未加入房间' });
      return;
    }
    const target = this.peers.get(msg.to);
    if (!target || target.roomId !== peer.roomId) {
      this._send(peer, { type: 'error', code: 'peer_not_found', message: '对端已离线' });
      return;
    }

    const payload = { type: msg.type, from: peer.id };
    if (msg.type === 'ice') payload.candidate = msg.candidate;
    else payload.sdp = msg.sdp;

    this._send(target, payload);
  }

  _hangup(peer, msg) {
    if (!peer.roomId) return;
    const room = this.rooms.get(peer.roomId);
    if (!room) return;
    const target = msg.to ? this.peers.get(msg.to) : null;
    for (const member of room.members.values()) {
      if (member.id === peer.id) continue;
      if (target && member.id !== target.id) continue;
      this._send(member, { type: 'peer-hangup', id: peer.id, name: peer.name });
    }
    this.logger.info('设备挂断', { room: peer.roomId, device: peer.name });
  }

  _peerState(peer, msg) {
    const muted = msg.muted && typeof msg.muted === 'object' ? msg.muted : {};
    peer.muted = { audio: Boolean(muted.audio), video: Boolean(muted.video) };
    if (!peer.roomId) return;
    const room = this.rooms.get(peer.roomId);
    if (!room) return;
    for (const member of room.members.values()) {
      if (member.id === peer.id) continue;
      this._send(member, { type: 'peer-state', id: peer.id, muted: peer.muted });
    }
  }

  _peerStats(peer, msg) {
    peer.stats = {
      rtt: Number(msg.rtt) || 0,
      bitrate: Number(msg.bitrate) || 0,
      width: Number(msg.width) || 0,
      height: Number(msg.height) || 0,
      fps: Number(msg.fps) || 0,
      updatedAt: Date.now(),
    };
  }

  _leaveRoom(peer, reason) {
    const room = this.rooms.get(peer.roomId);
    peer.roomId = null;
    if (!room) return;
    room.members.delete(peer.id);
    room.lastActiveAt = Date.now();

    for (const member of room.members.values()) {
      this._send(member, { type: 'peer-left', id: peer.id, name: peer.name, reason });
    }

    this.logger.info('设备离开房间', {
      room: room.id,
      device: peer.name,
      reason,
      members: room.members.size,
    });

    if (room.members.size === 0) {
      this._closeRoom(room);
    } else if (room.members.size < 2 && room.callStartedAt) {
      // 通话结束（对端离开/被踢），立即归档
      this._archiveCall(room);
      room.callStartedAt = 0;
    }
  }

  _archiveCall(room) {
    if (!room.callStartedAt) return;
    const endedAt = Date.now();
    this.history.unshift({
      room: room.id,
      startedAt: room.callStartedAt,
      endedAt,
      duration: Math.max(1, Math.round((endedAt - room.callStartedAt) / 1000)),
      members: room.totalJoins,
    });
    if (this.history.length > 100) this.history.pop();
    room.callStartedAt = 0;
  }

  _closeRoom(room) {
    this.rooms.delete(room.id);
    this._archiveCall(room);
  }

  _send(peer, payload) {
    try {
      peer.ws.send(payload);
    } catch (err) {
      // 连接已断开，忽略
    }
  }

  _checkHeartbeats() {
    const now = Date.now();
    const timeout = this.config.heartbeatTimeoutSeconds * 1000;
    for (const peer of this.peers.values()) {
      if (now - peer.lastSeen > timeout) {
        this.logger.warn('心跳超时，断开连接', { device: peer.name || peer.id, room: peer.roomId });
        try {
          peer.ws.close(4000, 'heartbeat timeout');
        } catch (err) {
          // ignore
        }
        this._disconnect(peer, 'heartbeat_timeout');
      } else {
        try {
          peer.ws.ping();
        } catch (err) {
          // ignore
        }
      }
    }
  }

  _sample() {
    this.samples.push({
      t: Date.now(),
      online: this.peers.size,
      rooms: this.rooms.size,
      calls: this.activeCalls(),
    });
    if (this.samples.length > 180) this.samples.shift();
  }

  activeCalls() {
    let count = 0;
    for (const room of this.rooms.values()) {
      if (room.members.size >= 2) count += 1;
    }
    return count;
  }

  /* -------------------------------- 管理接口 -------------------------------- */

  kick(roomId, peerId) {
    const room = this.rooms.get(roomId);
    if (!room) return { ok: false, error: 'room_not_found' };
    const peer = room.members.get(peerId);
    if (!peer) return { ok: false, error: 'peer_not_found' };
    this._send(peer, { type: 'kicked', reason: '管理员已将设备移出房间' });
    this.logger.warn('管理员踢出设备', { room: roomId, device: peer.name });
    const left = peer.name;
    // 先移除成员，确保日志与事件使用 kicked 作为原因
    this._disconnect(peer, 'kicked');
    try {
      peer.ws.close(4001, 'kicked by admin');
    } catch (err) {
      // ignore
    }
    return { ok: true, name: left };
  }

  overview() {
    const now = Date.now();
    let peak = 0;
    for (const sample of this.samples) peak = Math.max(peak, sample.online);
    return {
      serverTime: now,
      startedAt: this.startedAt,
      uptimeSeconds: Math.round((now - this.startedAt) / 1000),
      onlineDevices: this.peers.size,
      activeRooms: this.rooms.size,
      activeCalls: this.activeCalls(),
      totalCalls: this.totalCalls,
      totalConnections: this.totalConnections,
      peakOnline: Math.max(peak, this.peers.size),
      maxRoomMembers: this.config.maxRoomMembers,
      version: this.config.version,
      announcement: this.config.announcement,
    };
  }

  listRooms() {
    const now = Date.now();
    const rooms = [];
    for (const room of this.rooms.values()) {
      rooms.push({
        id: room.id,
        createdAt: room.createdAt,
        durationSeconds: Math.round((now - room.createdAt) / 1000),
        callDurationSeconds: room.callStartedAt ? Math.round((now - room.callStartedAt) / 1000) : 0,
        inCall: room.members.size >= 2,
        members: [...room.members.values()].map((peer) => ({
          id: peer.id,
          name: peer.name,
          ip: peer.ip,
          platform: peer.device.platform,
          model: peer.device.model,
          os: peer.device.os,
          appVersion: peer.device.appVersion,
          isTv: peer.device.isTv,
          muted: peer.muted,
          joinedAt: peer.joinedAt,
          stats: peer.stats,
        })),
      });
    }
    return rooms.sort((a, b) => b.createdAt - a.createdAt);
  }

  listDevices() {
    const now = Date.now();
    return [...this.peers.values()]
      .map((peer) => ({
        id: peer.id,
        name: peer.name,
        room: peer.roomId,
        ip: peer.ip,
        platform: peer.device.platform,
        model: peer.device.model,
        os: peer.device.os,
        appVersion: peer.device.appVersion,
        isTv: peer.device.isTv,
        muted: peer.muted,
        onlineSeconds: Math.round((now - peer.joinedAt) / 1000),
        stats: peer.stats,
      }))
      .sort((a, b) => (a.room === b.room ? 0 : a.room ? -1 : 1));
  }

  metrics() {
    return {
      samples: this.samples,
      history: this.history.slice(0, 50),
    };
  }
}

module.exports = { SignalingService, cleanText, sanitizeDevice };
