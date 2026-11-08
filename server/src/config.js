'use strict';

const path = require('path');
const pkg = require('../package.json');

function readEnvFile(file) {
  const fs = require('fs');
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function int(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) ? value : fallback;
}

function bool(name, fallback) {
  const value = (process.env[name] || '').toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  return fallback;
}

/**
 * 支持两种写法：
 *   VCALL_ICE_SERVERS='[{"urls":"stun:stun.example.com:3478"},{"urls":"turn:1.2.3.4:3478","username":"u","credential":"p"}]'
 *   VCALL_STUN_URLS='stun:stun.example.com:3478'
 *   VCALL_TURN_URL / VCALL_TURN_USER / VCALL_TURN_PASS
 */
function resolveIceServers() {
  const list = [];
  const raw = (process.env.VCALL_ICE_SERVERS || '').trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item && item.urls) list.push(item);
        }
      }
    } catch (err) {
      // 忽略非法 JSON，回退到分项配置
    }
  }

  const stunUrls = (process.env.VCALL_STUN_URLS || '').trim();
  if (stunUrls) {
    for (const url of stunUrls.split(',').map((s) => s.trim()).filter(Boolean)) {
      list.push({ urls: url });
    }
  }

  const turnUrl = (process.env.VCALL_TURN_URL || '').trim();
  if (turnUrl) {
    for (const url of turnUrl.split(',').map((s) => s.trim()).filter(Boolean)) {
      const server = { urls: url };
      if (process.env.VCALL_TURN_USER) server.username = process.env.VCALL_TURN_USER;
      if (process.env.VCALL_TURN_PASS) server.credential = process.env.VCALL_TURN_PASS;
      list.push(server);
    }
  }
  return list;
}

readEnvFile(path.resolve(__dirname, '..', '.env'));
readEnvFile(path.resolve(__dirname, '..', '..', '.env'));

const config = {
  version: pkg.version,
  name: process.env.VCALL_NAME || 'VCall',
  port: int('VCALL_PORT', int('PORT', 9002)),
  host: process.env.VCALL_HOST || '0.0.0.0',
  publicUrl: (process.env.VCALL_PUBLIC_URL || '').trim(),

  adminUser: process.env.VCALL_ADMIN_USER || 'admin',
  adminPassword: process.env.VCALL_ADMIN_PASSWORD || 'vcall@2026',
  adminTokenTtl: int('VCALL_ADMIN_TOKEN_TTL', 12 * 3600),
  adminSecret: process.env.VCALL_ADMIN_SECRET || '',

  maxRoomMembers: int('VCALL_MAX_ROOM_MEMBERS', 2),
  roomIdleSeconds: int('VCALL_ROOM_IDLE_SECONDS', 300),
  maxRooms: int('VCALL_MAX_ROOMS', 200),
  heartbeatSeconds: int('VCALL_HEARTBEAT_SECONDS', 30),
  heartbeatTimeoutSeconds: int('VCALL_HEARTBEAT_TIMEOUT_SECONDS', 90),

  iceServers: resolveIceServers(),
  defaultRoom: process.env.VCALL_DEFAULT_ROOM || '1001',

  dataDir: process.env.VCALL_DATA_DIR || path.resolve(__dirname, '..', 'data'),
  logToFile: bool('VCALL_LOG_TO_FILE', false),
  logLevel: (process.env.VCALL_LOG_LEVEL || 'info').toLowerCase(),
  trustProxy: bool('VCALL_TRUST_PROXY', true),

  announcement: process.env.VCALL_ANNOUNCEMENT || '',
  allowWebClient: bool('VCALL_ALLOW_WEB_CLIENT', true),
};

module.exports = config;
