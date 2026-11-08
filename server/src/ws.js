'use strict';

/**
 * 轻量 RFC6455 WebSocket 服务端实现（无第三方依赖）。
 * 仅实现本项目需要的部分：文本/二进制消息、分片、ping/pong、close。
 */

const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE_BYTES = 1024 * 1024; // 1MB，SDP 远小于此
const CLOSE_TIMEOUT_MS = 3000;

const OPCODE = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
};

function encodeFrame(opcode, payload) {
  const length = payload.length;
  let header;

  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}

function closePayload(code, reason) {
  const reasonBuf = reason ? Buffer.from(reason, 'utf8').slice(0, 123) : Buffer.alloc(0);
  const buf = Buffer.alloc(2 + reasonBuf.length);
  buf.writeUInt16BE(code || 1000, 0);
  reasonBuf.copy(buf, 2);
  return buf;
}

class WebSocketConnection extends EventEmitter {
  constructor(socket, req, options = {}) {
    super();
    this.socket = socket;
    this.req = req;
    this.id = options.id || crypto.randomBytes(8).toString('hex');
    this.isAlive = true;
    this.closed = false;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = null;
    this.fragmentBytes = 0;
    this.remoteAddress = options.remoteAddress || socket.remoteAddress || '';
    this.userAgent = req.headers['user-agent'] || '';
    this.protocol = req.headers['sec-websocket-protocol'] || '';
    this.meta = {};
    this.createdAt = Date.now();

    socket.setNoDelay(true);
    socket.setTimeout(0);
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this._onSocketClose());
    socket.on('error', (err) => {
      this.emit('error', err);
      this.terminate();
    });
  }

  _onData(chunk) {
    if (this.closed) return;
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;

    // 防止恶意超长缓冲
    if (this.buffer.length > MAX_MESSAGE_BYTES + 14) {
      this.close(1009, 'message too big');
      return;
    }

    while (this._parseFrame()) {
      // 循环解析所有完整帧
    }
  }

  _parseFrame() {
    const buf = this.buffer;
    if (buf.length < 2) return false;

    const fin = (buf[0] & 0x80) !== 0;
    const rsv = buf[0] & 0x70;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let length = buf[1] & 0x7f;
    let offset = 2;

    if (rsv !== 0) {
      this.close(1002, 'reserved bits set');
      return false;
    }
    if (!masked) {
      // 客户端必须掩码
      this.close(1002, 'client frame must be masked');
      return false;
    }

    if (length === 126) {
      if (buf.length < offset + 2) return false;
      length = buf.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (buf.length < offset + 8) return false;
      const big = buf.readBigUInt64BE(offset);
      if (big > BigInt(MAX_MESSAGE_BYTES)) {
        this.close(1009, 'message too big');
        return false;
      }
      length = Number(big);
      offset += 8;
    }

    if (length > MAX_MESSAGE_BYTES) {
      this.close(1009, 'message too big');
      return false;
    }

    if (buf.length < offset + 4 + length) return false;

    const mask = buf.subarray(offset, offset + 4);
    offset += 4;
    const payload = Buffer.allocUnsafe(length);
    for (let i = 0; i < length; i += 1) {
      payload[i] = buf[offset + i] ^ mask[i & 3];
    }
    offset += length;
    this.buffer = buf.subarray(offset);

    this.isAlive = true;
    this._handleFrame(fin, opcode, payload);
    return this.buffer.length >= 2 && !this.closed;
  }

  _handleFrame(fin, opcode, payload) {
    if (opcode === OPCODE.PING) {
      this._sendFrame(OPCODE.PONG, payload);
      return;
    }
    if (opcode === OPCODE.PONG) {
      this.emit('pong');
      return;
    }
    if (opcode === OPCODE.CLOSE) {
      let code = 1000;
      let reason = '';
      if (payload.length >= 2) {
        code = payload.readUInt16BE(0);
        reason = payload.subarray(2).toString('utf8');
      }
      this._sendFrame(OPCODE.CLOSE, closePayload(code, reason));
      this.emit('close', code, reason);
      this.terminate();
      return;
    }

    if (opcode === OPCODE.CONTINUATION) {
      if (this.fragmentOpcode === null) {
        this.close(1002, 'unexpected continuation');
        return;
      }
      this.fragments.push(payload);
      this.fragmentBytes += payload.length;
      if (this.fragmentBytes > MAX_MESSAGE_BYTES) {
        this.close(1009, 'message too big');
        return;
      }
      if (fin) {
        const message = Buffer.concat(this.fragments);
        const originalOpcode = this.fragmentOpcode;
        this.fragments = [];
        this.fragmentBytes = 0;
        this.fragmentOpcode = null;
        this._dispatch(originalOpcode, message);
      }
      return;
    }

    if (opcode === OPCODE.TEXT || opcode === OPCODE.BINARY) {
      if (!fin) {
        this.fragmentOpcode = opcode;
        this.fragments = [payload];
        this.fragmentBytes = payload.length;
        return;
      }
      this._dispatch(opcode, payload);
      return;
    }

    this.close(1002, 'unsupported opcode');
  }

  _dispatch(opcode, payload) {
    if (opcode === OPCODE.TEXT) {
      const text = payload.toString('utf8');
      this.emit('message', text);
    } else {
      this.emit('binary', payload);
    }
  }

  _sendFrame(opcode, payload) {
    if (this.closed || this.socket.destroyed) return false;
    try {
      this.socket.write(encodeFrame(opcode, payload));
      return true;
    } catch (err) {
      this.terminate();
      return false;
    }
  }

  send(data) {
    const text = typeof data === 'string' ? data : JSON.stringify(data);
    return this._sendFrame(OPCODE.TEXT, Buffer.from(text, 'utf8'));
  }

  ping() {
    this.isAlive = false;
    this._sendFrame(OPCODE.PING, Buffer.alloc(0));
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    this._sendFrame(OPCODE.CLOSE, closePayload(code, reason));
    this.closed = true;
    this.emit('close', code, reason);
    const socket = this.socket;
    setTimeout(() => {
      try {
        socket.end();
      } catch (err) {
        // ignore
      }
    }, 50).unref?.();
    setTimeout(() => {
      try {
        socket.destroy();
      } catch (err) {
        // ignore
      }
    }, CLOSE_TIMEOUT_MS).unref?.();
  }

  terminate() {
    if (!this.socket.destroyed) {
      try {
        this.socket.destroy();
      } catch (err) {
        // ignore
      }
    }
    this._onSocketClose();
  }

  _onSocketClose() {
    if (this._closeEmitted) return;
    this._closeEmitted = true;
    this.closed = true;
    this.emit('close', 1006, 'socket closed');
  }
}

/**
 * 把 http.Server 的 upgrade 事件接到 WebSocket 服务上。
 * @param {import('http').Server} server
 * @param {{path?: string, verifyClient?: Function, onConnection: Function}} options
 */
function attachWebSocket(server, options = {}) {
  const pathname = options.path || '/ws';

  server.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch (err) {
      socket.destroy();
      return;
    }

    if (url.pathname !== pathname) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const key = req.headers['sec-websocket-key'];
    const version = req.headers['sec-websocket-version'];
    if (!key || version !== '13') {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const remoteAddress =
      (options.trustProxy && (req.headers['x-forwarded-for'] || '').split(',')[0].trim()) ||
      req.socket.remoteAddress ||
      '';

    if (typeof options.verifyClient === 'function') {
      const verdict = options.verifyClient(req, url);
      if (verdict !== true) {
        const message = typeof verdict === 'string' ? verdict : 'Forbidden';
        socket.write(`HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n${message}`);
        socket.destroy();
        return;
      }
    }

    const accept = crypto
      .createHash('sha1')
      .update(key + GUID)
      .digest('base64');

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );

    const ws = new WebSocketConnection(socket, req, { remoteAddress });
    if (head && head.length) ws._onData(head);
    options.onConnection(ws, url, req);
  });
}

module.exports = { attachWebSocket, WebSocketConnection, encodeFrame };
