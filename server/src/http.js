'use strict';

const fs = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'no-referrer',
};

class StaticServer {
  constructor(publicDir) {
    this.publicDir = path.resolve(publicDir);
  }

  /**
   * @param {import('http').IncomingMessage} req
   * @param {import('http').ServerResponse} res
   * @param {URL} url
   * @returns {boolean} 是否已处理
   */
  serve(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;

    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/' || pathname === '/admin' || pathname === '/admin/') pathname = '/admin/index.html';
    if (pathname === '/call' || pathname === '/call/') pathname = '/call/index.html';
    if (pathname === '/favicon.ico') pathname = '/admin/favicon.svg';

    // 防止目录穿越
    const normalized = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
    const filePath = path.join(this.publicDir, normalized);
    if (!filePath.startsWith(this.publicDir + path.sep) && filePath !== this.publicDir) {
      return false;
    }

    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch (err) {
      return false;
    }
    if (!stat.isFile()) return false;

    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    const etag = `W/"${stat.size}-${stat.mtimeMs}"`;
    const isHtml = ext === '.html';

    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': type,
      'Content-Length': stat.size,
      'Cache-Control': isHtml ? 'no-cache' : 'public, max-age=3600',
      ETag: etag,
      'Content-Security-Policy': isHtml
        ? "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; media-src 'self' blob:; font-src 'self' data:"
        : "default-src 'self'",
    });

    if (req.method === 'HEAD') {
      res.end();
      return true;
    }

    fs.createReadStream(filePath).pipe(res);
    return true;
  }
}

module.exports = StaticServer;
