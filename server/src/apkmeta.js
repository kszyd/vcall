'use strict';

const fs = require('fs');
const zlib = require('zlib');

/**
 * 从 APK 中读取真实的 versionCode / versionName。
 * 只依赖 Node 内置模块：手动解析 ZIP 中央目录 + Android 二进制 XML（AXML）。
 */
function readZipEntry(buf, wanted) {
  const eocdSig = 0x06054b50;
  let eocd = -1;
  const min = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === eocdSig) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;

  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  let p = cdOffset;
  for (let i = 0; i < count; i += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) return null;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (name === wanted) {
      const lhNameLen = buf.readUInt16LE(localOffset + 26);
      const lhExtraLen = buf.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + lhNameLen + lhExtraLen;
      const data = buf.subarray(start, start + compSize);
      if (method === 0) return data;
      try {
        return zlib.inflateRawSync(data);
      } catch (err) {
        return null;
      }
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

function readStringPool(axml, offset) {
  const count = axml.readUInt32LE(offset + 8);
  const flags = axml.readUInt32LE(offset + 16);
  const stringsStart = axml.readUInt32LE(offset + 20);
  const utf8 = (flags & 0x100) !== 0;
  const base = offset + stringsStart;
  const strings = [];
  for (let i = 0; i < count; i += 1) {
    const off = axml.readUInt32LE(offset + 28 + i * 4);
    let q = base + off;
    if (utf8) {
      let len = axml[q];
      q += 1;
      if (len & 0x80) {
        len = ((len & 0x7f) << 8) | axml[q];
        q += 1;
      }
      let blen = axml[q];
      q += 1;
      if (blen & 0x80) {
        blen = ((blen & 0x7f) << 8) | axml[q];
        q += 1;
      }
      strings.push(axml.toString('utf8', q, q + blen));
    } else {
      let len = axml.readUInt16LE(q);
      q += 2;
      if (len & 0x8000) {
        len = ((len & 0x7fff) << 16) | axml.readUInt16LE(q);
        q += 2;
      }
      strings.push(axml.toString('utf16le', q, q + len * 2));
    }
  }
  return strings;
}

function parseManifest(axml) {
  if (!axml || axml.length < 8) return null;
  if (axml.readUInt16LE(0) !== 0x0003) return null;

  let strings = [];
  let p = 8;
  while (p + 8 <= axml.length) {
    const type = axml.readUInt16LE(p);
    const size = axml.readUInt32LE(p + 4);
    if (size <= 0) break;

    if (type === 0x0001) {
      strings = readStringPool(axml, p);
    } else if (type === 0x0102 && p + 36 <= axml.length) {
      const name = strings[axml.readUInt32LE(p + 20)];
      if (name === 'manifest') {
        const attrStart = axml.readUInt16LE(p + 24);
        const attrSize = axml.readUInt16LE(p + 26);
        const attrCount = axml.readUInt16LE(p + 28);
        let versionCode = 0;
        let versionName = '';
        for (let i = 0; i < attrCount; i += 1) {
          const a = p + 16 + attrStart + i * attrSize;
          if (a + 20 > axml.length) break;
          const attrName = strings[axml.readUInt32LE(a + 4)];
          const raw = axml.readInt32LE(a + 8);
          if (attrName === 'versionCode') {
            versionCode = axml.readUInt32LE(a + 16) | 0;
          } else if (attrName === 'versionName') {
            if (raw >= 0 && strings[raw]) versionName = strings[raw];
          }
        }
        return { versionCode, versionName };
      }
    }
    p += size;
  }
  return null;
}

function readApkMeta(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    const manifest = readZipEntry(buf, 'AndroidManifest.xml');
    if (!manifest) return null;
    return parseManifest(manifest);
  } catch (err) {
    return null;
  }
}

module.exports = { readApkMeta };
