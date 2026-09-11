/**
 * 分块上传。
 *
 * 为什么要分块：手机拍的视频、几个 G 的压缩包，一次性 POST 会在
 * Nginx 超时、内存爆掉、网络一抖就前功尽弃。分块之后：
 *  - 每块几 MB，能穿过任何反代的体积限制，也能对流式转发；
 *  - 断了只要重传丢失的那几块（init 会返回已收到的块号）；
 *  - 服务端可以边收边写盘，内存占用恒定。
 */
import { Router } from 'express';
import express from 'express';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { config } from '../config.js';
import { db, now, newFileId, fileById } from '../db.js';
import { requireAuth } from '../auth.js';
import { publicFile } from '../serialize.js';
import { wrap, bad, forbidden, notFound, str, intId, HttpError } from '../http.js';
import {
  normalizeMime,
  kindOf,
  imageSize,
  hasRoomFor,
  sanitizeFilename,
  extOf,
  rateLimiter,
} from '../util.js';

export const uploadsRouter = Router();
uploadsRouter.use(requireAuth);

/**
 * 只给分块接口挂 raw body 解析，且限制略大于一块，
 * 这样超大文件也不会把内存吃掉。
 */
const rawChunk = express.raw({
  type: () => true,
  limit: config.chunkBytes + 1024 * 1024,
});

const initLimit = rateLimiter({ windowMs: 60 * 60_000, max: 300 });

const uploadDirOf = (id) => join(config.tmpDir, id);

/** 已收到的块号 */
async function receivedChunks(uploadId) {
  try {
    const names = await readdir(uploadDirOf(uploadId));
    return names
      .map((n) => /^(\d+)\.part$/.exec(n))
      .filter(Boolean)
      .map((m) => Number(m[1]))
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

const uploadRow = (id) => db.prepare('SELECT * FROM uploads WHERE id = ?').get(id);

function mustOwnUpload(req) {
  const id = str(req.params.id, '上传', { max: 64 });
  const row = uploadRow(id);
  if (!row) throw notFound('上传任务不存在或已过期');
  if (row.owner_id !== req.user.id) throw forbidden('这不是你的上传任务');
  return row;
}

/* ------------------------------------------------------------------ */
/* 创建上传任务                                                        */
/* ------------------------------------------------------------------ */

uploadsRouter.post(
  '/uploads/init',
  wrap(async (req, res) => {
    if (!initLimit(String(req.user.id))) {
      throw new HttpError(429, '创建上传任务太频繁了', 'rate_limited');
    }

    const name = sanitizeFilename(str(req.body?.name ?? 'file', '文件名', { max: 200 }));
    const size = Number(req.body?.size);
    if (!Number.isFinite(size) || size < 0) throw bad('文件大小无效');
    if (size === 0) throw bad('不能上传空文件');
    if (size > config.maxFileBytes) {
      throw bad(`文件超过上限 ${(config.maxFileBytes / 1024 / 1024).toFixed(0)} MB`);
    }

    const mime = normalizeMime(req.body?.mime, name);
    const kind = kindOf(mime, name);

    // 配额与磁盘检查，都在创建任务时做，避免白传几个 G 才被拒
    if (config.dailyUploadQuota > 0) {
      const since = new Date().setHours(0, 0, 0, 0);
      const used = db
        .prepare('SELECT COALESCE(SUM(size), 0) AS n FROM files WHERE owner_id = ? AND created_at >= ?')
        .get(req.user.id, since).n;
      if (used + size > config.dailyUploadQuota) {
        throw bad(`今天的上传额度用完了（上限 ${(config.dailyUploadQuota / 1024 / 1024).toFixed(0)} MB）`);
      }
    }
    if (!(await hasRoomFor(size))) {
      throw new HttpError(507, '服务器磁盘空间不足，请联系管理员', 'insufficient_storage');
    }

    const id = newFileId();
    const chunkSize = config.chunkBytes;
    const total = Math.max(1, Math.ceil(size / chunkSize));

    await mkdir(uploadDirOf(id), { recursive: true });
    db.prepare(
      `INSERT INTO uploads (id, owner_id, name, mime, size, kind, chunk_size, total, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, req.user.id, name, mime, size, kind, chunkSize, total, now());

    res.status(201).json({ uploadId: id, chunkSize, totalChunks: total, received: [] });
  }),
);

/* ------------------------------------------------------------------ */
/* 查询进度（断点续传用）                                               */
/* ------------------------------------------------------------------ */

uploadsRouter.get(
  '/uploads/:id',
  wrap(async (req, res) => {
    const row = mustOwnUpload(req);
    res.json({
      uploadId: row.id,
      name: row.name,
      size: row.size,
      chunkSize: row.chunk_size,
      totalChunks: row.total,
      received: await receivedChunks(row.id),
    });
  }),
);

/* ------------------------------------------------------------------ */
/* 上传一块                                                            */
/* ------------------------------------------------------------------ */

uploadsRouter.put(
  '/uploads/:id/chunk/:index',
  rawChunk,
  wrap(async (req, res) => {
    const row = mustOwnUpload(req);
    const index = Number(req.params.index);
    if (!Number.isInteger(index) || index < 0 || index >= row.total) {
      throw bad('分块序号越界');
    }
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.length === 0) throw bad('分块内容为空');

    // 除最后一块外，其余每块必须是完整的 chunkSize
    const expected =
      index === row.total - 1 ? row.size - index * row.chunk_size : row.chunk_size;
    if (buf.length !== expected) {
      throw bad(`第 ${index} 块大小不对：期望 ${expected} 字节，收到 ${buf.length} 字节`);
    }

    const dir = uploadDirOf(row.id);
    await mkdir(dir, { recursive: true });
    // 先写临时名再改名，避免并发重传时读到写了一半的文件
    const finalPath = join(dir, `${index}.part`);
    const tmpPath = join(dir, `${index}.part.tmp`);
    await writeFile(tmpPath, buf);
    await rename(tmpPath, finalPath);

    res.json({ ok: true, index });
  }),
);

/* ------------------------------------------------------------------ */
/* 合并完成                                                            */
/* ------------------------------------------------------------------ */

uploadsRouter.post(
  '/uploads/:id/complete',
  wrap(async (req, res) => {
    const row = mustOwnUpload(req);

    const have = await receivedChunks(row.id);
    if (have.length !== row.total) {
      const missing = [];
      const set = new Set(have);
      for (let i = 0; i < row.total; i += 1) if (!set.has(i)) missing.push(i);
      return res.status(409).json({
        error: '还有分块没传完',
        code: 'incomplete',
        missing: missing.slice(0, 512),
        received: have.length,
        total: row.total,
      });
    }

    const fileId = newFileId();
    const d = new Date();
    const relDir = join(String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'));
    const absDir = join(config.uploadDir, relDir);
    await mkdir(absDir, { recursive: true });

    const ext = extOf(row.name);
    const relPath = join(relDir, ext ? `${fileId}.${ext}` : fileId);
    const absPath = join(config.uploadDir, relPath);

    // 顺序拼接，边写边算 sha256，全程流式，内存恒定
    const hash = createHash('sha256');
    async function* chunks() {
      for (let i = 0; i < row.total; i += 1) {
        const stream = createReadStream(join(uploadDirOf(row.id), `${i}.part`));
        for await (const c of stream) {
          hash.update(c);
          yield c;
        }
      }
    }

    try {
      await pipeline(chunks(), createWriteStream(absPath));
    } catch (err) {
      await rm(absPath, { force: true });
      throw err;
    }

    const { size } = await stat(absPath);
    if (size !== row.size) {
      await rm(absPath, { force: true });
      throw bad(`合并后的文件大小不符：期望 ${row.size}，实际 ${size}`);
    }

    // 图片尺寸由服务端嗅探，前端传的值不采信
    let width = null;
    let height = null;
    if (row.kind === 'image') {
      const dim = await imageSize(absPath);
      if (dim) {
        width = dim.width;
        height = dim.height;
      }
    }

    const t = now();
    db.transaction(() => {
      db.prepare(
        `INSERT INTO files (id, owner_id, name, mime, size, sha256, kind, path, width, height, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        fileId,
        req.user.id,
        row.name,
        row.mime,
        size,
        hash.digest('hex'),
        row.kind,
        relPath,
        width,
        height,
        t,
      );
      db.prepare('DELETE FROM uploads WHERE id = ?').run(row.id);
    })();

    await rm(uploadDirOf(row.id), { recursive: true, force: true });

    res.status(201).json({ file: publicFile(fileById(fileId)) });
  }),
);

/* ------------------------------------------------------------------ */
/* 取消                                                                */
/* ------------------------------------------------------------------ */

uploadsRouter.delete(
  '/uploads/:id',
  wrap(async (req, res) => {
    const row = mustOwnUpload(req);
    db.prepare('DELETE FROM uploads WHERE id = ?').run(row.id);
    await rm(uploadDirOf(row.id), { recursive: true, force: true });
    res.json({ ok: true });
  }),
);

/* ------------------------------------------------------------------ */
/* 清理残留                                                            */
/* ------------------------------------------------------------------ */

/** 删掉超过 24 小时没完成的上传任务，以及它们的临时块 */
export async function sweepStaleUploads(maxAgeMs = 24 * 3600_000) {
  const cutoff = now() - maxAgeMs;
  const stale = db.prepare('SELECT id FROM uploads WHERE created_at < ?').all(cutoff);
  for (const s of stale) {
    db.prepare('DELETE FROM uploads WHERE id = ?').run(s.id);
    await rm(uploadDirOf(s.id), { recursive: true, force: true }).catch(() => {});
  }
  // 顺手清掉没有数据库记录的孤儿目录
  try {
    const dirs = await readdir(config.tmpDir);
    for (const name of dirs) {
      if (uploadRow(name)) continue;
      const info = await stat(join(config.tmpDir, name)).catch(() => null);
      if (info && info.isDirectory() && now() - info.mtimeMs > maxAgeMs) {
        await rm(join(config.tmpDir, name), { recursive: true, force: true }).catch(() => {});
      }
    }
  } catch {
    /* 目录不存在就算了 */
  }
  return stale.length;
}
