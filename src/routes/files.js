/**
 * 文件下载 / 内联播放。
 *
 * 两个要点：
 *  1. 鉴权不是可选项。文件路径不可猜测，但仍然必须校验「你是不是这条消息的接收方」。
 *  2. 必须支持 Range 请求，否则音频拖进度条、视频拖动、大文件断点续传全都不能用。
 *     express 的 res.sendFile 已经实现了完整的 Range / ETag / 条件请求，直接用。
 */
import { Router } from 'express';
import { stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { config } from '../config.js';
import { requireAuth } from '../auth.js';
import { fileVisibleTo } from '../conv.js';
import { wrap, notFound, str } from '../http.js';
import { isInlineSafe, contentDisposition, sanitizeFilename } from '../util.js';

export const filesRouter = Router();
filesRouter.use(requireAuth);

filesRouter.get(
  '/files/:id',
  wrap(async (req, res) => {
    const id = str(req.params.id, '文件', { max: 64 });
    const file = fileVisibleTo(id, req.user.id);
    if (!file) throw notFound('文件不存在或你没有访问权限');

    // 双保险：即使数据库被写过奇怪的值，也不允许逃出上传根目录
    const abs = resolve(config.uploadDir, file.path);
    const root = resolve(config.uploadDir);
    if (abs !== root && !abs.startsWith(root + sep)) {
      throw notFound('文件路径异常');
    }

    const info = await stat(abs).catch(() => null);
    if (!info || !info.isFile()) {
      return res.status(410).json({ error: '文件已经不在服务器上了', code: 'gone' });
    }

    // 文件 id 是一次性随机值且内容不可变，可以放心长缓存
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.setHeader('Content-Type', file.mime || 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    /*
     * SVG 是唯一「既是图片、又能当文档跑」的类型。放进 <img> 里没事，
     * 但有人直接把 /api/files/<id> 当页面打开时，它里面的 <script> 就运行在
     * 本站源上。这里给它单独上一道最严的 CSP（会覆盖全局那条），
     * 脚本、表单、外部请求一律掐掉，只留绘制需要的样式和内嵌图片。
     * 走 <img> 加载时这道头根本用不上，所以预览不受影响。
     */
    if (/svg/i.test(file.mime || '')) {
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
      );
    }

    // 非图片/音频/视频一律强制下载；显式带 download=1 也强制下载
    const forceDownload = req.query.download === '1';
    const inline = isInlineSafe(file.kind) && !forceDownload;
    res.setHeader('Content-Disposition', contentDisposition(file.name, inline));

    // 头像之类的图片不需要触发下载面板，也不需要 filename
    res.sendFile(abs, { acceptRanges: true, cacheControl: false }, (err) => {
      if (err && !res.headersSent) {
        res.status(err.status || 500).json({ error: '读取文件失败' });
      }
    });
  }),
);

/** 文件元信息，前端在下载前可以拿它显示确认信息 */
filesRouter.get(
  '/files/:id/info',
  wrap(async (req, res) => {
    const id = str(req.params.id, '文件', { max: 64 });
    const file = fileVisibleTo(id, req.user.id);
    if (!file) throw notFound('文件不存在或你没有访问权限');
    res.json({
      id: file.id,
      name: sanitizeFilename(file.name),
      mime: file.mime,
      size: file.size,
      kind: file.kind,
      sha256: file.sha256,
      createdAt: file.created_at,
    });
  }),
);
