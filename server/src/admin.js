'use strict';

const crypto = require('crypto');

const LOGIN_WINDOW_MS = 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 6;

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(input) {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded, 'base64').toString('utf8');
}

class AdminService {
  constructor({ config, logger, signaling }) {
    this.config = config;
    this.logger = logger;
    this.signaling = signaling;
    this.secret = config.adminSecret || crypto.randomBytes(32).toString('hex');
    if (!config.adminSecret) {
      this.logger.warn('未设置 VCALL_ADMIN_SECRET，本次启动使用随机密钥（重启后管理登录失效）');
    }
    this.attempts = new Map(); // ip -> { count, resetAt }
  }

  issueToken(username) {
    const payload = {
      sub: username,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + this.config.adminTokenTtl,
    };
    const body = base64url(JSON.stringify(payload));
    const sig = this._sign(body);
    return { token: `${body}.${sig}`, expiresIn: this.config.adminTokenTtl, payload };
  }

  _sign(body) {
    return base64url(crypto.createHmac('sha256', this.secret).update(body).digest());
  }

  verifyToken(token) {
    if (typeof token !== 'string' || !token.includes('.')) return null;
    const [body, sig] = token.split('.');
    if (!body || !sig) return null;
    const expected = this._sign(body);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    try {
      const payload = JSON.parse(fromBase64url(body));
      if (!payload.exp || payload.exp * 1000 < Date.now()) return null;
      return payload;
    } catch (err) {
      return null;
    }
  }

  checkLoginRate(ip) {
    const now = Date.now();
    let entry = this.attempts.get(ip);
    if (!entry || entry.resetAt < now) {
      entry = { count: 0, resetAt: now + LOGIN_WINDOW_MS };
      this.attempts.set(ip, entry);
    }
    entry.count += 1;
    return entry.count <= LOGIN_MAX_ATTEMPTS;
  }

  async handle(req, res, url, body) {
    const path = url.pathname;

    if (path === '/api/health' && req.method === 'GET') {
      return this.json(res, 200, {
        ok: true,
        name: this.config.name,
        version: this.config.version,
        uptime: Math.round(process.uptime()),
        time: Date.now(),
      });
    }

    if (path === '/api/config' && req.method === 'GET') {
      return this.json(res, 200, {
        name: this.config.name,
        version: this.config.version,
        iceServers: this.config.iceServers,
        maxCallMembers: this.config.maxCallMembers,
        allowWebClient: this.config.allowWebClient,
        announcement: this.config.announcement,
        serverTime: Date.now(),
      });
    }

    if (path === '/api/admin/login' && req.method === 'POST') {
      const ip = this.clientIp(req);
      if (!this.checkLoginRate(ip)) {
        return this.json(res, 429, { ok: false, error: '尝试过于频繁，请 1 分钟后再试' });
      }
      const username = typeof body.username === 'string' ? body.username.trim() : '';
      const password = typeof body.password === 'string' ? body.password : '';
      const okUser = username === this.config.adminUser;
      const okPass = password === this.config.adminPassword;
      if (!okUser || !okPass) {
        this.logger.warn('管理登录失败', { ip, username });
        return this.json(res, 401, { ok: false, error: '用户名或密码错误' });
      }
      this.attempts.delete(ip);
      this.logger.info('管理登录成功', { ip, username });
      const issued = this.issueToken(username);
      return this.json(res, 200, {
        ok: true,
        token: issued.token,
        expiresIn: issued.expiresIn,
        username,
      });
    }

    // 以下接口需要鉴权
    if (path.startsWith('/api/admin/')) {
      const payload = this.auth(req);
      if (!payload) return this.json(res, 401, { ok: false, error: '未登录或登录已过期' });

      if (path === '/api/admin/overview' && req.method === 'GET') {
        return this.json(res, 200, { ok: true, overview: this.signaling.overview() });
      }

      if (path === '/api/admin/calls' || path === '/api/admin/rooms') {
        return this.json(res, 200, { ok: true, calls: this.signaling.listCalls() });
      }

      if (path === '/api/admin/terminals' || path === '/api/admin/devices') {
        return this.json(res, 200, { ok: true, terminals: this.signaling.listTerminals() });
      }

      if (path === '/api/admin/metrics' && req.method === 'GET') {
        return this.json(res, 200, { ok: true, ...this.signaling.metrics() });
      }

      if (path === '/api/admin/logs' && req.method === 'GET') {
        const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 500);
        const level = url.searchParams.get('level') || undefined;
        return this.json(res, 200, { ok: true, logs: this.logger.recent(limit, level) });
      }

      if (path === '/api/admin/settings' && req.method === 'POST') {
        const updated = {};
        if (typeof body.announcement === 'string') {
          this.config.announcement = body.announcement.slice(0, 200);
          updated.announcement = this.config.announcement;
        }
        if (body.maxCallMembers !== undefined || body.maxRoomMembers !== undefined) {
          const raw = body.maxCallMembers !== undefined ? body.maxCallMembers : body.maxRoomMembers;
          const value = Number(raw);
          if (!Number.isInteger(value) || value < 2 || value > 12) {
            return this.json(res, 400, { ok: false, error: 'maxCallMembers 需为 2-12 的整数' });
          }
          this.config.maxCallMembers = value;
          updated.maxCallMembers = value;
        }
        this.saveSettings(updated);
        this.logger.info('管理端更新设置', updated);
        return this.json(res, 200, { ok: true, settings: updated });
      }

      const kickMatch = path.match(/^\/api\/admin\/(?:terminals|devices)\/([^/]+)\/kick$/);
      if (kickMatch && req.method === 'POST') {
        const terminalId = decodeURIComponent(kickMatch[1]);
        const result = this.signaling.kick(terminalId);
        if (!result.ok) return this.json(res, 404, { ok: false, error: result.error });
        return this.json(res, 200, { ok: true, name: result.name });
      }

      return this.json(res, 404, { ok: false, error: 'not_found' });
    }

    return this.json(res, 404, { ok: false, error: 'not_found' });
  }

  auth(req) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    return this.verifyToken(token);
  }

  clientIp(req) {
    if (this.config.trustProxy) {
      const forwarded = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (forwarded) return forwarded;
    }
    return req.socket.remoteAddress || '';
  }

  saveSettings(settings) {
    if (!Object.keys(settings).length) return;
    try {
      const fs = require('fs');
      const path = require('path');
      fs.mkdirSync(this.config.dataDir, { recursive: true });
      fs.writeFileSync(
        path.join(this.config.dataDir, 'settings.json'),
        JSON.stringify(settings, null, 2)
      );
    } catch (err) {
      this.logger.warn('保存设置失败', { error: String(err && err.message) });
    }
  }

  json(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  }
}

module.exports = AdminService;
