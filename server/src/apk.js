'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_SIZE = 200 * 1024 * 1024;

/**
 * 管理端上传的 APK 存放与版本信息。
 * 文件固定为 data/apk/vcall.apk，元信息写 latest.json，便于容器重启后保留。
 */
class ApkStore {
  constructor({ config, logger }) {
    this.config = config;
    this.logger = logger;
    this.dir = path.join(config.dataDir, 'apk');
    this.file = path.join(this.dir, 'vcall.apk');
    this.metaFile = path.join(this.dir, 'latest.json');
    this.info = null;
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.metaFile) && fs.existsSync(this.file)) {
        const meta = JSON.parse(fs.readFileSync(this.metaFile, 'utf8'));
        if (meta && meta.versionCode) this.info = meta;
      }
    } catch (err) {
      this.logger.warn('读取 APK 信息失败', { error: String(err && err.message) });
    }
  }

  latest() {
    if (!this.info) return null;
    return { ...this.info, url: '/api/apk/download' };
  }

  filePath() {
    return this.info ? this.file : null;
  }

  /** 流式接收上传，避免把几十兆全部读进内存 */
  receive(req) {
    return new Promise((resolve, reject) => {
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = this.file + '.uploading';
      const hash = crypto.createHash('sha256');
      const out = fs.createWriteStream(tmp);
      let size = 0;
      let failed = false;

      const fail = (message) => {
        if (failed) return;
        failed = true;
        out.destroy();
        try {
          fs.unlinkSync(tmp);
        } catch (err) {
          // ignore
        }
        reject(new Error(message));
      };

      req.on('data', (chunk) => {
        if (failed) return;
        size += chunk.length;
        if (size > MAX_SIZE) {
          fail('apk_too_large');
          req.destroy();
          return;
        }
        hash.update(chunk);
        if (!out.write(chunk)) {
          req.pause();
          out.once('drain', () => req.resume());
        }
      });

      req.on('end', () => {
        if (failed) return;
        out.end(() => {
          if (size === 0) {
            fail('apk_empty');
            return;
          }
          resolve({ tmp, size, sha256: hash.digest('hex') });
        });
      });

      req.on('error', (err) => fail(err && err.message ? err.message : 'upload_error'));
      out.on('error', (err) => fail(err && err.message ? err.message : 'write_error'));
    });
  }

  commit({ tmp, size, sha256, version, versionCode }) {
    fs.renameSync(tmp, this.file);
    this.info = {
      version,
      versionCode,
      size,
      sha256,
      uploadedAt: Date.now(),
    };
    fs.writeFileSync(this.metaFile, JSON.stringify(this.info, null, 2));
    return this.latest();
  }
}

module.exports = ApkStore;
