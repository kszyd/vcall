'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const config = require('./config');
const Logger = require('./logger');
const { SignalingService } = require('./signaling');
const AdminService = require('./admin');
const StaticServer = require('./http');
const { attachWebSocket } = require('./ws');

const logger = new Logger(config);
const signaling = new SignalingService({ config, logger });
const admin = new AdminService({ config, logger, signaling });
const staticServer = new StaticServer(path.resolve(__dirname, '..', 'public'));

// 读取持久化的管理设置（若存在）
try {
  const settingsPath = path.join(config.dataDir, 'settings.json');
  if (fs.existsSync(settingsPath)) {
    const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    if (typeof saved.announcement === 'string') config.announcement = saved.announcement;
    if (Number.isInteger(saved.maxRoomMembers)) config.maxRoomMembers = saved.maxRoomMembers;
  }
} catch (err) {
  logger.warn('读取持久化设置失败', { error: String(err && err.message) });
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch (err) {
        reject(new Error('bad_json'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch (err) {
    return sendJson(res, 400, { ok: false, error: 'bad_request' });
  }

  // CORS：允许内网其他端口页面调用 API（管理页本身同源）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  if (url.pathname.startsWith('/api/')) {
    let body = {};
    if (req.method === 'POST') {
      try {
        body = await readBody(req);
      } catch (err) {
        const message = err.message === 'body_too_large' ? '请求体过大' : 'JSON 格式错误';
        return sendJson(res, 400, { ok: false, error: message });
      }
    }
    try {
      await admin.handle(req, res, url, body);
    } catch (err) {
      logger.error('API 处理异常', { path: url.pathname, error: String(err && err.message) });
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal_error' });
    }
    return undefined;
  }

  if (staticServer.serve(req, res, url)) return undefined;

  sendJson(res, 404, { ok: false, error: 'not_found' });
  return undefined;
});

attachWebSocket(server, {
  path: '/ws',
  trustProxy: config.trustProxy,
  onConnection: (ws) => signaling.handleConnection(ws),
});

function localAddresses() {
  const list = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) list.push(entry.address);
    }
  }
  return list;
}

server.listen(config.port, config.host, () => {
  logger.info(`VCall 信令服务已启动 v${config.version}`, {
    listen: `${config.host}:${config.port}`,
    iceServers: config.iceServers.length,
  });
  const addresses = localAddresses();
  console.log('');
  console.log('  VCall 服务已就绪');
  console.log(`  管理后台    http://${addresses[0] || '127.0.0.1'}:${config.port}/admin`);
  console.log(`  网页通话    http://${addresses[0] || '127.0.0.1'}:${config.port}/call`);
  console.log(`  信令地址    ws://${addresses[0] || '127.0.0.1'}:${config.port}/ws`);
  if (addresses.length > 1) console.log(`  其他地址    ${addresses.join('  ')}`);
  console.log(`  管理账号    ${config.adminUser} / ${config.adminSecret ? '(已通过环境变量设置)' : config.adminPassword}`);
  console.log('');
});

server.on('error', (err) => {
  logger.error('HTTP 服务启动失败', { error: String(err && err.message) });
  process.exit(1);
});

function shutdown(signal) {
  logger.info('收到退出信号，正在关闭服务', { signal });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  logger.error('未捕获异常', { error: String(err && err.stack) });
});
process.on('unhandledRejection', (err) => {
  logger.error('未处理的 Promise 拒绝', { error: String(err && err) });
});
