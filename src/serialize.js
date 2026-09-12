/**
 * 数据库行 -> API 输出形状。
 *
 * 只在这里定义对外的字段名，前端就永远不用知道表结构。
 * 所有对外 id 保持数字/字符串原样，不做额外混淆：这是私人站点，
 * 访问控制靠会话和成员校验，而不是靠猜不到 id。
 */
import { db, parseJSON, fileById } from './db.js';
import { isOnline } from './presence.js';

/* ------------------------------------------------------------------ */
/* 用户                                                                */
/* ------------------------------------------------------------------ */

export function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name || user.username,
    avatarUrl: user.avatar_file_id ? `/api/files/${user.avatar_file_id}` : null,
    about: user.about || '',
    isAdmin: !!user.is_admin,
    online: isOnline(user.id),
    lastSeenAt: user.last_seen_at || 0,
  };
}

/** 联系人视角：多一个备注名 */
export function publicContact(user, alias) {
  const base = publicUser(user);
  if (!base) return null;
  return { ...base, alias: alias || null, name: alias || base.displayName };
}

/* ------------------------------------------------------------------ */
/* 文件                                                                */
/* ------------------------------------------------------------------ */

export function publicFile(file) {
  if (!file) return null;
  return {
    id: file.id,
    name: file.name,
    mime: file.mime,
    size: file.size,
    kind: file.kind,
    width: file.width || null,
    height: file.height || null,
    durationMs: file.duration_ms || null,
    url: `/api/files/${file.id}`,
  };
}

/* ------------------------------------------------------------------ */
/* 消息                                                                */
/* ------------------------------------------------------------------ */

const MESSAGE_SELECT = `
  SELECT m.*,
         u.username       AS u_username,
         u.display_name   AS u_display_name,
         u.avatar_file_id AS u_avatar_file_id,
         u.is_admin       AS u_is_admin,
         u.last_seen_at   AS u_last_seen_at,
         f.name        AS f_name,
         f.mime        AS f_mime,
         f.size        AS f_size,
         f.kind        AS f_kind,
         f.width       AS f_width,
         f.height      AS f_height,
         f.duration_ms AS f_duration_ms
    FROM messages m
    LEFT JOIN users u ON u.id = m.sender_id
    LEFT JOIN files f ON f.id = m.file_id
`;

/** 组装消息对象。replyTo 由调用方批量填好，避免 N+1 查询。 */
function shape(row, replyTo = null) {
  const meta = parseJSON(row.meta, null);
  const deleted = !!row.deleted_at;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    kind: deleted ? 'deleted' : row.kind,
    body: deleted ? '' : row.body || '',
    meta,
    // 关联查询里没有文件时，f_name 为 NULL
    file:
      deleted || !row.f_name
        ? null
        : publicFile({
            id: row.file_id,
            name: row.f_name,
            mime: row.f_mime,
            size: row.f_size,
            kind: row.f_kind,
            width: row.f_width,
            height: row.f_height,
            duration_ms: row.f_duration_ms,
          }),
    sender: row.sender_id
      ? publicUser({
          id: row.sender_id,
          username: row.u_username || '已注销',
          display_name: row.u_display_name || '已注销用户',
          avatar_file_id: row.u_avatar_file_id,
          is_admin: row.u_is_admin,
          last_seen_at: row.u_last_seen_at,
        })
      : null,
    replyTo,
    createdAt: row.created_at,
    editedAt: row.edited_at || null,
    deletedAt: row.deleted_at || null,
  };
}

/**
 * 批量取一组消息，按 id 升序返回。
 * @param {number[]} ids
 * @returns {Map<number, object>}
 */
export function messagesByIds(ids) {
  const out = new Map();
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return out;
  const placeholders = unique.map(() => '?').join(',');
  const rows = db.prepare(`${MESSAGE_SELECT} WHERE m.id IN (${placeholders})`).all(...unique);
  // 二级引用（回复的回复）只展开一层，避免无限递归
  for (const r of rows) out.set(r.id, shape(r, null));
  return out;
}

/**
 * 按会话分页取消息。
 * @param {number} conversationId
 * @param {{before?: number, after?: number, limit?: number}} opts
 * @returns {{messages: object[], hasMore: boolean}}
 */
export function listMessages(conversationId, { before, after, limit = 50 } = {}) {
  // 收口在这里：LIMIT 拿到非整数 SQLite 会直接抛 SQLITE_MISMATCH，
  // 所以不管调用方传了什么，先落成一个 1..200 的整数。
  const asked = Number(limit);
  const n = Number.isFinite(asked) ? Math.max(1, Math.min(200, Math.trunc(asked))) : 50;
  let rows;
  if (after) {
    rows = db
      .prepare(`${MESSAGE_SELECT} WHERE m.conversation_id = ? AND m.id > ? ORDER BY m.id ASC LIMIT ?`)
      .all(conversationId, after, n);
  } else {
    rows = db
      .prepare(`${MESSAGE_SELECT} WHERE m.conversation_id = ? AND m.id < ? ORDER BY m.id DESC LIMIT ?`)
      .all(conversationId, before ?? Number.MAX_SAFE_INTEGER, n);
    rows.reverse();
  }

  // 批量补齐被回复的消息
  const replyIds = rows.map((r) => r.reply_to).filter(Boolean);
  const replies = messagesByIds(replyIds);

  const messages = rows.map((r) => shape(r, r.reply_to ? replies.get(r.reply_to) || null : null));

  const hasMore =
    after
      ? false
      : db
          .prepare('SELECT 1 FROM messages WHERE conversation_id = ? AND id < ? LIMIT 1')
          .get(conversationId, messages[0]?.id ?? Number.MAX_SAFE_INTEGER) != null;

  return { messages, hasMore };
}

/** 单条消息（发完之后回给客户端用），签名与 listMessages 一致 */
export function getMessage(id) {
  const row = db.prepare(`${MESSAGE_SELECT} WHERE m.id = ?`).get(id);
  if (!row) return null;
  const reply = row.reply_to ? messagesByIds([row.reply_to]).get(row.reply_to) || null : null;
  return shape(row, reply);
}
