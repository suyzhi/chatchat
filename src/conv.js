/**
 * 会话视图组装。放在单独模块里，因为 HTTP 路由和 WebSocket 推送都要用它，
 * 保证「列表里看到的」和「推送过来的」是同一个形状。
 */
import { db, fileById, memberIds } from './db.js';
import { publicUser, publicFile } from './serialize.js';

/**
 * 会话里最后一条消息的轻量预览（不含 sender 全量信息，列表够用）。
 * @param {number} conversationId
 */
export function lastMessageOf(conversationId) {
  const row = db
    .prepare(
      `SELECT m.id, m.kind, m.body, m.file_id, m.sender_id, m.created_at, m.deleted_at,
              f.kind AS f_kind, f.name AS f_name, f.duration_ms AS f_duration
         FROM messages m
         LEFT JOIN files f ON f.id = m.file_id
        WHERE m.conversation_id = ?
        ORDER BY m.id DESC LIMIT 1`,
    )
    .get(conversationId);
  if (!row) return null;

  let preview;
  if (row.deleted_at) preview = '此消息已撤回';
  else if (row.kind === 'image') preview = '[图片]';
  else if (row.kind === 'audio') preview = '[语音]';
  else if (row.kind === 'video') preview = '[视频]';
  else if (row.kind === 'file') preview = `[文件] ${row.f_name || ''}`.trim();
  else if (row.kind === 'system') preview = row.body || '';
  else preview = (row.body || '').replace(/\s+/g, ' ').slice(0, 120);

  return {
    id: row.id,
    kind: row.deleted_at ? 'deleted' : row.kind,
    preview,
    senderId: row.sender_id,
    createdAt: row.created_at,
  };
}

/**
 * 组装一个会话的完整对外形状。
 * @param {object} conv conversations 表的一行
 * @param {number} viewerId 当前用户
 */
export function conversationSummary(conv, viewerId) {
  const memberRows = db
    .prepare(
      `SELECT cm.user_id, cm.role, cm.last_read_message_id, cm.muted, cm.joined_at, u.*
         FROM conversation_members cm
         JOIN users u ON u.id = cm.user_id
        WHERE cm.conversation_id = ?`,
    )
    .all(conv.id);

  const me = memberRows.find((m) => m.user_id === viewerId);
  const others = memberRows.filter((m) => m.user_id !== viewerId);

  const hidden = db
    .prepare('SELECT hidden_before FROM conversation_hidden WHERE conversation_id = ? AND user_id = ?')
    .get(conv.id, viewerId);

  const last = lastMessageOf(conv.id);

  // 未读数：比我已读位置更新、不是我发的、且没被撤回
  const unread = me
    ? db
        .prepare(
          `SELECT COUNT(*) AS n FROM messages
            WHERE conversation_id = ? AND id > ? AND sender_id IS NOT ? AND deleted_at IS NULL`,
        )
        .get(conv.id, me.last_read_message_id || 0, viewerId).n
    : 0;

  // 对方已读到哪（私聊用来显示「已读」）
  const peerReadId =
    conv.type === 'dm' && others.length ? others[0].last_read_message_id || 0 : null;

  let title = conv.title;
  let avatarUrl = conv.avatar_file_id ? `/api/files/${conv.avatar_file_id}` : null;
  let peer = null;

  if (conv.type === 'dm') {
    const other = others[0];
    if (other) {
      const alias = db
        .prepare('SELECT alias FROM contacts WHERE owner_id = ? AND user_id = ?')
        .get(viewerId, other.user_id)?.alias;
      peer = publicUser(other);
      title = alias || peer.displayName;
      avatarUrl = peer.avatarUrl;
    } else {
      title = '仅自己可见';
    }
  }

  return {
    id: conv.id,
    type: conv.type,
    title: title || '未命名群聊',
    avatarUrl,
    peer,
    memberCount: memberRows.length,
    members:
      conv.type === 'group'
        ? memberRows.map((m) => ({ ...publicUser(m), role: m.role }))
        : undefined,
    myRole: me?.role || 'member',
    muted: !!me?.muted,
    lastReadMessageId: me?.last_read_message_id || 0,
    peerReadMessageId: peerReadId,
    lastMessage: last,
    unread,
    createdAt: conv.created_at,
    updatedAt: conv.last_message_at || conv.created_at,
    // 列表里要不要显示：被自己隐藏、且之后没有新消息
    hidden: hidden ? (last ? last.id <= hidden.hidden_before : true) : false,
  };
}

/** 某个文件是不是被这个用户所在会话引用过（下载鉴权用） */
export function fileVisibleTo(fileId, userId) {
  const file = fileById(fileId);
  if (!file) return null;
  if (file.owner_id === userId) return file;
  const inConv = db
    .prepare(
      `SELECT 1
         FROM messages m
         JOIN conversation_members cm
           ON cm.conversation_id = m.conversation_id AND cm.user_id = ?
        WHERE m.file_id = ?
        LIMIT 1`,
    )
    .get(userId, fileId);
  if (inConv) return file;
  // 群头像：会话成员都该看得到。它不出现在任何 message 里，
  // 所以上面那条查不到，漏掉这里的话除了上传者本人全是 404。
  const asGroupAvatar = db
    .prepare(
      `SELECT 1
         FROM conversations c
         JOIN conversation_members cm
           ON cm.conversation_id = c.id AND cm.user_id = ?
        WHERE c.avatar_file_id = ?
        LIMIT 1`,
    )
    .get(userId, fileId);
  if (asGroupAvatar) return file;
  // 个人头像对所有登录用户可见
  const asAvatar = db
    .prepare('SELECT 1 FROM users WHERE avatar_file_id = ? LIMIT 1')
    .get(fileId);
  return asAvatar ? file : null;
}

export { publicFile, memberIds };
