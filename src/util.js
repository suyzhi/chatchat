/**
 * 通用工具：MIME 归类、图片尺寸嗅探、磁盘余量、安全的文件名处理。
 * 尽量不引入依赖，图片尺寸直接读文件头，比装一个图像库划算得多。
 */
import { open, statfs } from 'node:fs/promises';
import { config } from './config.js';

/* ------------------------------------------------------------------ */
/* 类型归类                                                            */
/* ------------------------------------------------------------------ */

/** 扩展名兜底表：有些浏览器 / 系统给出的 MIME 是空或 application/octet-stream */
const EXT_MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', heic: 'image/heic', heif: 'image/heif',
  bmp: 'image/bmp', svg: 'image/svg+xml',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg',
  oga: 'audio/ogg', opus: 'audio/opus', wav: 'audio/wav', flac: 'audio/flac',
  weba: 'audio/webm', amr: 'audio/amr',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  mkv: 'video/x-matroska', avi: 'video/x-msvideo',
  pdf: 'application/pdf', zip: 'application/zip', rar: 'application/vnd.rar',
  '7z': 'application/x-7z-compression', tar: 'application/x-tar',
  gz: 'application/gzip', txt: 'text/plain', md: 'text/markdown',
  json: 'application/json', csv: 'text/csv',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export const extOf = (name = '') => {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(name));
  return m ? m[1].toLowerCase() : '';
};

/** 把 mime 规整成可信的值，必要时用扩展名兜底 */
export function normalizeMime(mime, filename) {
  const raw = String(mime || '').split(';')[0].trim().toLowerCase();
  if (raw && raw !== 'application/octet-stream' && raw !== 'binary/octet-stream') return raw;
  return EXT_MIME[extOf(filename)] || 'application/octet-stream';
}

/** 业务上的大类，决定前端怎么渲染 */
export function kindOf(mime, filename) {
  const m = normalizeMime(mime, filename);
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('video/')) return 'video';
  return 'file';
}

/** 允许内联展示的类型（其余一律走下载，避免把浏览器拖进不可预期的渲染） */
export const INLINE_KINDS = new Set(['image', 'audio', 'video']);
export const isInlineSafe = (kind) => INLINE_KINDS.has(kind);

/* ------------------------------------------------------------------ */
/* 图片尺寸嗅探（只读文件头，不解码像素）                               */
/* ------------------------------------------------------------------ */

const u16be = (b, o) => (b[o] << 8) | b[o + 1];
const u16le = (b, o) => b[o] | (b[o + 1] << 8);
const u32be = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const u32le = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

function sniff(buf) {
  if (buf.length < 16) return null;

  // PNG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    if (buf.length < 24) return null;
    return { width: u32be(buf, 16), height: u32be(buf, 20) };
  }

  // GIF
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { width: u16le(buf, 6), height: u16le(buf, 8) };
  }

  // BMP
  if (buf[0] === 0x42 && buf[1] === 0x4d && buf.length >= 26) {
    return { width: Math.abs(u32le(buf, 18)), height: Math.abs(u32le(buf, 22)) };
  }

  // WebP (RIFF....WEBP)
  if (
    buf.length >= 30 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  ) {
    const fourcc = buf.toString('ascii', 12, 16);
    if (fourcc === 'VP8X') {
      const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
      const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
      return { width: w, height: h };
    }
    if (fourcc === 'VP8 ') {
      return { width: u16le(buf, 26) & 0x3fff, height: u16le(buf, 28) & 0x3fff };
    }
    if (fourcc === 'VP8L') {
      const bits = u32le(buf, 21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    return null;
  }

  // JPEG：逐段扫描，找到 SOFn
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = buf[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const len = u16be(buf, i + 2);
      const isSOF =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf);
      if (isSOF) {
        return { height: u16be(buf, i + 5), width: u16be(buf, i + 7) };
      }
      if (len < 2) return null;
      i += 2 + len;
    }
  }

  return null;
}

/**
 * 读取文件头得到宽高。读不到就返回 null，调用方按「尺寸未知」处理。
 * @param {string} absPath
 */
export async function imageSize(absPath) {
  let fh;
  try {
    fh = await open(absPath, 'r');
    const buf = Buffer.alloc(64 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return sniff(buf.subarray(0, bytesRead));
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}

/* ------------------------------------------------------------------ */
/* 磁盘余量                                                            */
/* ------------------------------------------------------------------ */

/** @returns {Promise<number>} 可用字节数；拿不到时返回 Infinity（不阻断上传） */
export async function freeDiskBytes(dir) {
  try {
    const s = await statfs(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export async function hasRoomFor(bytes, dir = config.uploadDir) {
  const free = await freeDiskBytes(dir);
  return free - bytes >= config.minFreeDiskBytes;
}

/* ------------------------------------------------------------------ */
/* 其他                                                                */
/* ------------------------------------------------------------------ */

/** 清掉文件名里的路径分隔符与控制字符，只用于展示和 Content-Disposition */
export function sanitizeFilename(name) {
  const base = String(name || 'file')
    .replace(/[\\/]/g, '_')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/^\.+/, '_')
    .trim();
  return (base || 'file').slice(0, 180);
}

/**
 * 生成 Content-Disposition。同时给出 ASCII 回退和 RFC 5987 的 UTF-8 版本，
 * 中文文件名才不会变成乱码或被截断。
 */
export function contentDisposition(filename, inline = false) {
  const safe = sanitizeFilename(filename);
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** 人类可读的字节数 */
export function humanBytes(n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Number(n) || 0;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/** 简单的内存滑动窗口限流，够单进程用 */
export function rateLimiter({ windowMs, max }) {
  const hits = new Map();
  setInterval(() => {
    const t = Date.now();
    for (const [k, v] of hits) if (t - v.start > windowMs) hits.delete(k);
  }, windowMs).unref?.();
  return (key) => {
    const t = Date.now();
    let rec = hits.get(key);
    if (!rec || t - rec.start > windowMs) {
      rec = { start: t, n: 0 };
      hits.set(key, rec);
    }
    rec.n += 1;
    return rec.n <= max;
  };
}
