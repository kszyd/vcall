'use strict';

const fs = require('fs');
const path = require('path');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_MEMORY_LOGS = 500;

class Logger {
  constructor(config) {
    this.level = LEVELS[config.logLevel] || LEVELS.info;
    this.buffer = [];
    this.seq = 0;
    this.listeners = new Set();
    this.fileStream = null;

    if (config.logToFile) {
      try {
        fs.mkdirSync(config.dataDir, { recursive: true });
        this.fileStream = fs.createWriteStream(path.join(config.dataDir, 'vcall.log'), {
          flags: 'a',
        });
      } catch (err) {
        // 日志文件不可写时退化为 stdout
      }
    }
  }

  write(level, message, meta) {
    if ((LEVELS[level] || 0) < this.level) return;
    const entry = {
      id: ++this.seq,
      ts: new Date().toISOString(),
      level,
      message,
      meta: meta || undefined,
    };
    this.buffer.push(entry);
    if (this.buffer.length > MAX_MEMORY_LOGS) this.buffer.shift();

    const suffix = meta ? ' ' + JSON.stringify(meta) : '';
    const line = `[${entry.ts}] ${level.toUpperCase().padEnd(5)} ${message}${suffix}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);

    if (this.fileStream) this.fileStream.write(line + '\n');

    for (const listener of this.listeners) {
      try {
        listener(entry);
      } catch (err) {
        // 监听器异常不影响主流程
      }
    }
  }

  debug(message, meta) {
    this.write('debug', message, meta);
  }

  info(message, meta) {
    this.write('info', message, meta);
  }

  warn(message, meta) {
    this.write('warn', message, meta);
  }

  error(message, meta) {
    this.write('error', message, meta);
  }

  recent(limit = 100, level) {
    let items = this.buffer;
    if (level) items = items.filter((item) => item.level === level);
    return items.slice(-limit);
  }

  onEntry(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

module.exports = Logger;
