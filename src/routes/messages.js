/**
 * 消息：发送、编辑、撤回、转发、搜索。
 * 读取列表在 routes/conversations.js 的 /:id/messages。
 */
import { Router } from 'express';
import { config } from '../config.js';
import { db, now, conversationById, isMember, memberIds, fileById } from '../db.js';
import { requireAuth } from '../auth.js';
import { getMessage, listMessages } from '../serialize.js';
import { conversationSummary } from '../conv.js';
import { sendToUsers } from '../presence.js';
import { wrap, bad, forbidden, notFound, str, intId, HttpError } from '../http.js';
import { rateLimiter } from '../util.js';

export const messagesRouter = Router();
messagesRouter.use(requireAuth);

const sendLimit = rateLimiter({ windowMs: 60_000, max: 180 });
const SEND_KINDS = new Set(['text', 'image', 'audio', 'video', 'file']);

/** 取消息并做可见性 + 身份校验 */
function mustOwn(req) {
  const id = intId(req.params.id, '消息');
  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
  if (!row) throw notFound('消息不存在');
  if (!isMember(row.conversation_id, req.user.id)) throw forbidden('你不在这个会话里');
  return row;
}

/** 广播一条消息给会话内所有人，并把各自的会话摘要一起带上，列表就能直接更新 */
function broadcastMessage(message, { exceptUserId } = {}) {
  const conv = conversationById(message.conversationId);
  if (!conv) return;
  for (const uid of memberIds(conv.id)) {
    if (uid === exceptUserId) continue;
    sendToUsers([uid], {
      t: 'message:new',
      message,
      conversation: conversationSummary(conv, uid),
    });
  }
}

/** 把 meta 里的数值字段收敛到合理范围，避免前端拿到离谱值撑破布局 */
function sanitizeMeta(meta) {
  if (!meta || typeof meta !== 'object') return null;
  const out = {};
  const num = (v, lo, hi) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null;
  };
  const w = num(meta.width, 1, 40000);
  const h = num(meta.height, 1, 40000);
  const d = num(meta.durationMs, 0, 24 * 3600_000);
  if (w) out.width = Math.round(w);
  if (h) out.height = Math.round(h);
  if (d !== null) out.durationMs = Math.round(d);
  if (Array.isArray(meta.waveform)) {
    // 语音波形，最多 64 个 0-1 之间的采样点
    out.waveform = meta.waveform
      .slice(0, 64)
      .map((v) => Math.min(1, Math.max(0, Number(v) || 0)));
  }
  return Object.keys(out).length ? out : null;
}

/* ------------------------------------------------------------------ */
/* 发送                                                                */
/* ------------------------------------------------------------------ */

messagesRouter.post(
  '/conversations/:id/messages',
  wrap(async (req, res) => {
    if (!sendLimit(String(req.user.id))) {
      throw new HttpError(429, '发得太快了，缓一下', 'rate_limited');
    }

    const convId = intId(req.params.id, '会话');
    const conv = conversationById(convId);
    if (!conv) throw notFound('会话不存在');
    if (!isMember(convId, req.user.id)) throw forbidden('你不在这个会话里');

    const kind = String(req.body?.kind || 'text');
    if (!SEND_KINDS.has(kind)) throw bad('不支持的消息类型');

    const body = req.body?.body == null ? '' : String(req.body.body).slice(0, 4000);
    if (kind === 'text' && !body.trim()) throw bad('消息不能是空的');

    // 带文件的消息：文件必须是自己传的，且已经完成上传
    let file = null;
    let meta = sanitizeMeta(req.body?.meta);
    if (kind !== 'text') {
      const fileId = str(req.body?.fileId, '文件', { max: 64 });
      file = fileById(fileId);
      if (!file) throw bad('文件不存在或还没上传完');
      if (file.owner_id !== req.user.id) throw forbidden('只能发送自己上传的文件');
      // 图片尺寸以服务端嗅探的结果为准，不信任前端传来的值
      if (file.width && file.height) {
        meta = { ...(meta || {}), width: file.width, height: file.height };
      }
    }

    // 回复目标必须和本条消息在同一个会话里
    let replyTo = null;
    if (req.body?.replyTo) {
      const rid = intId(req.body.replyTo, '回复目标');
      const target = db
        .prepare('SELECT id, conversation_id, deleted_at FROM messages WHERE id = ?')
        .get(rid);
      if (!target || target.conversation_id !== convId) throw bad('要回复的消息不在这个会话里');
      if (target.deleted_at) throw bad('这条消息已经被撤回了');
      replyTo = rid;
    }

    const t = now();
    const id = db.transaction(() => {
      const info = db
        .prepare(
          `INSERT INTO messages (conversation_id, sender_id, kind, body, file_id, reply_to, meta, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(convId, req.user.id, kind, body, file?.id ?? null, replyTo, meta ? JSON.stringify(meta) : null, t);
      const mid = Number(info.lastInsertRowid);
      db.prepare('UPDATE conversations SET last_message_at = ? WHERE id = ?').run(t, convId);
      // 自己发的消息直接算已读
      db.prepare(
        'UPDATE conversation_members SET last_read_message_id = ? WHERE conversation_id = ? AND user_id = ?',
      ).run(mid, convId, req.user.id);
      // 新消息让被隐藏的会话重新出现
      db.prepare('DELETE FROM conversation_hidden WHERE conversation_id = ?').run(convId);
      return mid;
    })();

    const message = getMessage(id);
    broadcastMessage(message);
    res.status(201).json({ message, conversation: conversationSummary(conversationById(convId), req.user.id) });
  }),
);

/* ------------------------------------------------------------------ */
/* 编辑                                                                */
/* ------------------------------------------------------------------ */

messagesRouter.patch(
  '/messages/:id',
  wrap(async (req, res) => {
    const row = mustOwn(req);
    if (row.sender_id !== req.user.id) throw forbidden('只能编辑自己发的消息');
    if (row.deleted_at) throw bad('已撤回的消息不能编辑');
    if (row.kind !== 'text') throw bad('只有文字消息能编辑');

    const body = str(req.body?.body ?? '', '消息内容', { min: 1, max: 4000, trim: false });
    if (!body.trim()) throw bad('消息不能是空的');

    db.prepare('UPDATE messages SET body = ?, edited_at = ? WHERE id = ?').run(body, now(), row.id);
    const message = getMessage(row.id);
    for (const uid of memberIds(row.conversation_id)) {
      sendToUsers([uid], { t: 'message:update', message });
    }
    res.json({ message });
  }),
);

/* ------------------------------------------------------------------ */
/* 撤回                                                                */
/* ------------------------------------------------------------------ */

messagesRouter.post(
  '/messages/:id/recall',
  wrap(async (req, res) => {
    const row = mustOwn(req);
    if (row.sender_id !== req.user.id) throw forbidden('只能撤回自己发的消息');
    if (row.deleted_at) return res.json({ message: getMessage(row.id) });

    if (config.recallWindowSeconds > 0) {
      const age = (now() - row.created_at) / 1000;
      if (age > config.recallWindowSeconds) {
        throw bad(`超过 ${config.recallWindowSeconds} 秒的消息不能撤回了`);
      }
    }

    db.prepare('UPDATE messages SET deleted_at = ?, deleted_by = ?, body = ?, file_id = NULL, meta = NULL WHERE id = ?')
      .run(now(), req.user.id, '', row.id);

    const message = getMessage(row.id);
    for (const uid of memberIds(row.conversation_id)) {
      sendToUsers([uid], {
        t: 'message:update',
        message,
        conversation: conversationSummary(conversationById(row.conversation_id), uid),
      });
    }
    res.json({ message });
  }),
);

/* ------------------------------------------------------------------ */
/* 转发                                                                */
/* ------------------------------------------------------------------ */

messagesRouter.post(
  '/messages/:id/forward',
  wrap(async (req, res) => {
    const row = mustOwn(req);
    if (row.deleted_at) throw bad('已撤回的消息不能转发');

    const raw = Array.isArray(req.body?.conversationIds) ? req.body.conversationIds : [];
    const targets = [...new Set(raw.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (targets.length === 0) throw bad('请选择要转发到的会话');

    const t = now();
    const created = [];
    for (const cid of targets) {
      const conv = conversationById(cid);
      if (!conv || !isMember(cid, req.user.id)) continue;
      const info = db
        .prepare(
          `INSERT INTO messages (conversation_id, sender_id, kind, body, file_id, meta, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(cid, req.user.id, row.kind, row.body, row.file_id, row.meta, t);
      const mid = Number(info.lastInsertRowid);
      db.prepare('UPDATE conversations SET last_message_at = ? WHERE id = ?').run(t, cid);
      db.prepare(
        'UPDATE conversation_members SET last_read_message_id = ? WHERE conversation_id = ? AND user_id = ?',
      ).run(mid, cid, req.user.id);
      db.prepare('DELETE FROM conversation_hidden WHERE conversation_id = ?').run(cid);
      const message = getMessage(mid);
      created.push(message);
      broadcastMessage(message);
    }
    if (created.length === 0) throw bad('没有可转发到的会话');
    res.status(201).json({ messages: created });
  }),
);

/* ------------------------------------------------------------------ */
/* 搜索                                                                */
/* ------------------------------------------------------------------ */

messagesRouter.get(
  '/messages/search',
  wrap(async (req, res) => {
    const q = str(req.query.q ?? '', '关键词', { min: 1, max: 60 });
    const convFilter = req.query.conversationId ? intId(req.query.conversationId, '会话') : null;
    const limit = Math.min(60, Math.max(1, Number(req.query.limit) || 30));

    // 只在当前用户所属的会话里搜
    const scope = db
      .prepare('SELECT conversation_id FROM conversation_members WHERE user_id = ?')
      .all(req.user.id)
      .map((r) => r.conversation_id);
    if (scope.length === 0) return res.json({ results: [] });

    let ids = scope;
    if (convFilter) {
      if (!scope.includes(convFilter)) throw forbidden('你不在这个会话里');
      ids = [convFilter];
    }

    const placeholders = ids.map(() => '?').join(',');
    // LIKE 通配符转义，避免用户输入的 % 把整表扫出来
    const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    const rows = db
      .prepare(
        `SELECT m.id, m.conversation_id, m.body, m.kind, m.created_at, m.sender_id, u.display_name
           FROM messages m
           LEFT JOIN users u ON u.id = m.sender_id
          WHERE m.conversation_id IN (${placeholders})
            AND m.deleted_at IS NULL
            AND m.kind IN ('text','image','file','audio','video')
            AND m.body LIKE ? ESCAPE '\\'
          ORDER BY m.id DESC
          LIMIT ?`,
      )
      .all(...ids, like, limit);

    res.json({
      results: rows.map((r) => ({
        messageId: r.id,
        conversationId: r.conversation_id,
        body: r.body,
        kind: r.kind,
        createdAt: r.created_at,
        senderName: r.display_name || '已注销',
      })),
    });
  }),
);

/** 未读汇总，用于标题栏的小红点 */
messagesRouter.get(
  '/unread',
  wrap(async (req, res) => {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n
           FROM messages m
           JOIN conversation_members cm
             ON cm.conversation_id = m.conversation_id AND cm.user_id = ?
          WHERE m.id > cm.last_read_message_id
            AND m.sender_id IS NOT ?
            AND m.deleted_at IS NULL
            AND cm.muted = 0`,
      )
      .get(req.user.id, req.user.id);
    res.json({ unread: row.n });
  }),
);

export { listMessages };
