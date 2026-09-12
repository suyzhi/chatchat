/**
 * 会话：私聊、群聊、成员管理、已读位置、隐藏。
 * 消息本身在 routes/messages.js。
 */
import { Router } from 'express';
import { db, now, conversationById, isMember, memberIds, addMember, findOrCreateDM, userById } from '../db.js';
import { requireAuth } from '../auth.js';
import { conversationSummary } from '../conv.js';
import { publicUser, listMessages } from '../serialize.js';
import { sendToUsers } from '../presence.js';
import { wrap, bad, forbidden, notFound, str, optStr, intId, HttpError } from '../http.js';
import { rateLimiter } from '../util.js';

export const conversationsRouter = Router();
conversationsRouter.use(requireAuth);

const typingLimit = rateLimiter({ windowMs: 10_000, max: 40 });

/** 取会话并断言当前用户是成员 */
function mustMember(req) {
  const id = intId(req.params.id, '会话');
  const conv = conversationById(id);
  if (!conv) throw notFound('会话不存在');
  if (!isMember(id, req.user.id)) throw forbidden('你不在这个会话里');
  return conv;
}

const summary = (conv, viewerId) => conversationSummary(conv, viewerId);

/** 群聊管理员校验 */
function mustGroupAdmin(conv, userId) {
  if (conv.type !== 'group') throw bad('私聊没有成员管理');
  const me = db
    .prepare('SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?')
    .get(conv.id, userId);
  if (me?.role !== 'owner' && me?.role !== 'admin' && !userById(userId)?.is_admin) {
    throw forbidden('只有群主和管理员能做这个操作');
  }
}

/**
 * 群主离开之后，把群主转给还在群里、加入最早的那个人。
 *
 * 不转会把这个群永久卡死：mustGroupAdmin 只认 owner / admin / 站点管理员，
 * 而 role='admin' 全项目没有任何地方会写、也没有提权接口 —— 于是改名、
 * 拉人、踢人全部 403，谁都救不回来。
 *
 * @returns {number|null} 新群主的 id；没有可转的人（群空了）返回 null
 */
function transferOwnershipIfNeeded(conversationId) {
  const stillOwned = db
    .prepare("SELECT 1 FROM conversation_members WHERE conversation_id = ? AND role = 'owner' LIMIT 1")
    .get(conversationId);
  if (stillOwned) return null;
  const next = db
    .prepare(
      `SELECT user_id FROM conversation_members
        WHERE conversation_id = ?
        ORDER BY joined_at ASC, user_id ASC LIMIT 1`,
    )
    .get(conversationId);
  if (!next) return null;
  db.prepare(
    "UPDATE conversation_members SET role = 'owner' WHERE conversation_id = ? AND user_id = ?",
  ).run(conversationId, next.user_id);
  return next.user_id;
}

/* ------------------------------------------------------------------ */
/* 列表                                                                */
/* ------------------------------------------------------------------ */

conversationsRouter.get(
  '/conversations',
  wrap(async (req, res) => {
    const rows = db
      .prepare(
        `SELECT c.* FROM conversations c
           JOIN conversation_members cm ON cm.conversation_id = c.id
          WHERE cm.user_id = ?
          ORDER BY COALESCE(c.last_message_at, c.created_at) DESC`,
      )
      .all(req.user.id);
    const list = rows.map((c) => summary(c, req.user.id));
    res.json({ conversations: list.filter((c) => !c.hidden) });
  }),
);

/* ------------------------------------------------------------------ */
/* 创建                                                                */
/* ------------------------------------------------------------------ */

conversationsRouter.post(
  '/conversations',
  wrap(async (req, res) => {
    const type = req.body?.type === 'group' ? 'group' : 'dm';

    if (type === 'dm') {
      const peerId = intId(req.body?.userId, '用户');
      if (peerId === req.user.id) throw bad('不能和自己私聊');
      if (!userById(peerId)) throw notFound('用户不存在');

      const { conversation, created } = findOrCreateDM(req.user.id, peerId);
      // 重新打开被隐藏的会话
      db.prepare('DELETE FROM conversation_hidden WHERE conversation_id = ? AND user_id = ?')
        .run(conversation.id, req.user.id);

      if (created) {
        sendToUsers([req.user.id, peerId], {
          t: 'conversation:new',
          conversation: { forUser: peerId, data: summary(conversation, peerId) },
        });
      }
      return res.status(created ? 201 : 200).json({
        conversation: summary(conversation, req.user.id),
        created,
      });
    }

    // 群聊
    const title = str(req.body?.title ?? '新群聊', '群名', { min: 1, max: 40 });
    const raw = Array.isArray(req.body?.memberIds) ? req.body.memberIds : [];
    const ids = [...new Set(raw.map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0))];
    const valid = ids.filter((id) => id !== req.user.id && userById(id));
    if (valid.length === 0) throw bad('至少要选一位成员');

    const t = now();
    const convId = db.transaction(() => {
      const info = db
        .prepare(
          `INSERT INTO conversations (type, title, created_by, created_at, last_message_at)
           VALUES ('group', ?, ?, ?, ?)`,
        )
        .run(title, req.user.id, t, t);
      const id = Number(info.lastInsertRowid);
      addMember(id, req.user.id, 'owner');
      for (const uid of valid) addMember(id, uid, 'member');
      const sys = db
        .prepare(
          `INSERT INTO messages (conversation_id, sender_id, kind, body, created_at)
           VALUES (?, ?, 'system', ?, ?)`,
        )
        .run(id, req.user.id, `${req.user.display_name} 创建了群聊`, t);
      // 「谁创建了群聊」这条不该让刚被拉进来的人一进群就顶着红点
      db.prepare(
        'UPDATE conversation_members SET last_read_message_id = ? WHERE conversation_id = ?',
      ).run(Number(sys.lastInsertRowid), id);
      return id;
    })();

    const conv = conversationById(convId);
    sendToUsers(memberIds(convId), {
      t: 'conversation:new',
      conversation: { broadcast: true, id: convId, title },
    });
    res.status(201).json({ conversation: summary(conv, req.user.id) });
  }),
);

/* ------------------------------------------------------------------ */
/* 详情 / 修改                                                         */
/* ------------------------------------------------------------------ */

conversationsRouter.get(
  '/conversations/:id',
  wrap(async (req, res) => {
    const conv = mustMember(req);
    res.json({ conversation: summary(conv, req.user.id) });
  }),
);

conversationsRouter.patch(
  '/conversations/:id',
  wrap(async (req, res) => {
    const conv = mustMember(req);
    if (conv.type === 'group') mustGroupAdmin(conv, req.user.id);

    const fields = [];
    const values = [];
    if (req.body?.title !== undefined) {
      fields.push('title = ?');
      values.push(str(req.body.title, '群名', { min: 1, max: 40 }));
    }
    if (req.body?.avatarFileId !== undefined) {
      if (req.body.avatarFileId === null || req.body.avatarFileId === '') {
        fields.push('avatar_file_id = ?');
        values.push(null);
      } else {
        const fid = str(req.body.avatarFileId, '群头像', { max: 64 });
        const f = db.prepare('SELECT id, owner_id, kind FROM files WHERE id = ?').get(fid);
        if (!f) throw bad('文件不存在');
        if (f.owner_id !== req.user.id) throw forbidden('只能用自己的上传当群头像');
        if (f.kind !== 'image') throw bad('群头像必须是图片');
        fields.push('avatar_file_id = ?');
        values.push(fid);
      }
    }
    if (fields.length === 0) throw bad('没有要修改的内容');

    values.push(conv.id);
    db.prepare(`UPDATE conversations SET ${fields.join(', ')} WHERE id = ?`).run(...values);

    const updated = conversationById(conv.id);
    for (const uid of memberIds(conv.id)) {
      sendToUsers([uid], { t: 'conversation:update', conversation: summary(updated, uid) });
    }
    res.json({ conversation: summary(updated, req.user.id) });
  }),
);

/* ------------------------------------------------------------------ */
/* 成员                                                                */
/* ------------------------------------------------------------------ */

conversationsRouter.post(
  '/conversations/:id/members',
  wrap(async (req, res) => {
    const conv = mustMember(req);
    if (conv.type !== 'group') throw bad('私聊不能加人');
    mustGroupAdmin(conv, req.user.id);

    const raw = Array.isArray(req.body?.userIds) ? req.body.userIds : [];
    const ids = [...new Set(raw.map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0))];
    const t = now();
    const added = db.transaction(() => {
      const out = [];
      let lastId = 0;
      for (const uid of ids) {
        const person = userById(uid);
        if (!person || isMember(conv.id, uid)) continue;
        addMember(conv.id, uid, 'member');
        out.push(uid);
        lastId = Number(
          db
            .prepare(
              `INSERT INTO messages (conversation_id, sender_id, kind, body, created_at)
               VALUES (?, ?, 'system', ?, ?)`,
            )
            .run(conv.id, req.user.id, `${person.display_name} 加入了群聊`, t).lastInsertRowid,
        );
      }
      if (out.length === 0) return out;

      /*
       * 和「建群」那条路径保持一致：被拉进来的人不该一进群就顶着满屏红点。
       * 之前这里没写 last_read_message_id，新成员的默认值是 0，
       * 于是他要替进群之前的所有历史消息背一次未读。
       */
      const marks = out.map(() => '?').join(',');
      db.prepare(
        `UPDATE conversation_members SET last_read_message_id = ?
          WHERE conversation_id = ? AND user_id IN (${marks})`,
      ).run(lastId, conv.id, ...out);
      db.prepare('UPDATE conversations SET last_message_at = ? WHERE id = ?').run(t, conv.id);
      return out;
    })();
    if (added.length === 0) throw bad('没有可添加的成员');

    const conv2 = conversationById(conv.id);
    for (const uid of memberIds(conv.id)) {
      sendToUsers([uid], { t: 'conversation:update', conversation: summary(conv2, uid) });
    }
    // 被拉进来的人要立刻看到这个群
    for (const uid of added) {
      sendToUsers([uid], { t: 'conversation:new', conversation: { broadcast: true, id: conv.id } });
    }
    res.json({ conversation: summary(conv2, req.user.id), added });
  }),
);

conversationsRouter.delete(
  '/conversations/:id/members/:userId',
  wrap(async (req, res) => {
    const conv = mustMember(req);
    if (conv.type !== 'group') throw bad('私聊不能移除成员');
    const targetId = intId(req.params.userId, '用户');
    // 自己退群走 /leave；群主可以移除任何人，其他人只能移除自己
    if (targetId !== req.user.id) mustGroupAdmin(conv, req.user.id);
    if (!isMember(conv.id, targetId)) throw notFound('这个人不在群里');

    const target = userById(targetId);
    const t = now();
    db.prepare('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?').run(
      conv.id,
      targetId,
    );
    db.prepare('DELETE FROM conversation_hidden WHERE conversation_id = ? AND user_id = ?').run(
      conv.id,
      targetId,
    );
    const left = memberIds(conv.id);
    if (left.length > 0) {
      db.prepare(
        `INSERT INTO messages (conversation_id, sender_id, kind, body, created_at)
         VALUES (?, ?, 'system', ?, ?)`,
      ).run(
        conv.id,
        req.user.id,
        targetId === req.user.id
          ? `${target?.display_name || '有人'} 退出了群聊`
          : `${target?.display_name || '有人'} 被移出了群聊`,
        t,
      );
      db.prepare('UPDATE conversations SET last_message_at = ? WHERE id = ?').run(t, conv.id);
    }
    // 群主走了（或自己被移除）就把群主交出去，别让这个群以后没人能管
    transferOwnershipIfNeeded(conv.id);

    sendToUsers([targetId], { t: 'conversation:removed', conversationId: conv.id });
    const conv2 = conversationById(conv.id);
    if (conv2) {
      for (const uid of memberIds(conv.id)) {
        sendToUsers([uid], { t: 'conversation:update', conversation: summary(conv2, uid) });
      }
    }
    res.json({ ok: true });
  }),
);

conversationsRouter.post(
  '/conversations/:id/leave',
  wrap(async (req, res) => {
    const conv = mustMember(req);
    if (conv.type !== 'group') throw bad('私聊不能退出，只能删除会话');

    const me = userById(req.user.id);
    const t = now();
    db.prepare('UPDATE conversations SET last_message_at = ? WHERE id = ?').run(t, conv.id);
    db.prepare(
      `INSERT INTO messages (conversation_id, sender_id, kind, body, created_at)
       VALUES (?, ?, 'system', ?, ?)`,
    ).run(conv.id, req.user.id, `${me.display_name} 退出了群聊`, t);
    db.prepare('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?').run(
      conv.id,
      req.user.id,
    );
    db.prepare('DELETE FROM conversation_hidden WHERE conversation_id = ? AND user_id = ?').run(
      conv.id,
      req.user.id,
    );
    // 退群的就是群主的话，把群主交给群里剩下最早加入的那个人
    transferOwnershipIfNeeded(conv.id);

    const conv2 = conversationById(conv.id);
    if (conv2) {
      for (const uid of memberIds(conv.id)) {
        sendToUsers([uid], { t: 'conversation:update', conversation: summary(conv2, uid) });
      }
    }
    res.json({ ok: true });
  }),
);

/* ------------------------------------------------------------------ */
/* 已读 / 隐藏 / 免打扰 / 正在输入                                      */
/* ------------------------------------------------------------------ */

conversationsRouter.post(
  '/conversations/:id/read',
  wrap(async (req, res) => {
    const conv = mustMember(req);
    // 已读位置只允许落在本会话的消息区间里。原样接受任意 id 的话，
    // 一个乱序的客户端（或者故意构造的请求）就能把别的会话、甚至还不存在的
    // 消息 id 写成这里的「已读到哪」，未读数会直接算错。
    const maxId = db
      .prepare('SELECT COALESCE(MAX(id), 0) AS n FROM messages WHERE conversation_id = ?')
      .get(conv.id).n;
    // 允许不传 messageId，表示「全部标记为已读」
    const upto = Math.min(
      req.body?.messageId ? intId(req.body.messageId, '消息') : maxId,
      maxId,
    );

    const cur = db
      .prepare('SELECT last_read_message_id FROM conversation_members WHERE conversation_id = ? AND user_id = ?')
      .get(conv.id, req.user.id).last_read_message_id;

    if (upto > cur) {
      db.prepare(
        'UPDATE conversation_members SET last_read_message_id = ? WHERE conversation_id = ? AND user_id = ?',
      ).run(upto, conv.id, req.user.id);
      // 告诉其他人「对方读到这里了」，用于显示已读回执
      const others = memberIds(conv.id).filter((id) => id !== req.user.id);
      sendToUsers(others, {
        t: 'read',
        conversationId: conv.id,
        userId: req.user.id,
        messageId: upto,
        at: now(),
      });
    }
    res.json({ ok: true, lastReadMessageId: Math.max(upto, cur) });
  }),
);

conversationsRouter.post(
  '/conversations/:id/hide',
  wrap(async (req, res) => {
    const conv = mustMember(req);
    const lastId =
      db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM messages WHERE conversation_id = ?').get(conv.id).n;
    db.prepare(
      `INSERT INTO conversation_hidden (conversation_id, user_id, hidden_before) VALUES (?, ?, ?)
       ON CONFLICT(conversation_id, user_id) DO UPDATE SET hidden_before = excluded.hidden_before`,
    ).run(conv.id, req.user.id, lastId);
    res.json({ ok: true });
  }),
);

conversationsRouter.post(
  '/conversations/:id/unhide',
  wrap(async (req, res) => {
    const conv = mustMember(req);
    db.prepare('DELETE FROM conversation_hidden WHERE conversation_id = ? AND user_id = ?').run(
      conv.id,
      req.user.id,
    );
    res.json({ conversation: summary(conv, req.user.id) });
  }),
);

conversationsRouter.post(
  '/conversations/:id/mute',
  wrap(async (req, res) => {
    const conv = mustMember(req);
    const muted = req.body?.muted ? 1 : 0;
    db.prepare(
      'UPDATE conversation_members SET muted = ? WHERE conversation_id = ? AND user_id = ?',
    ).run(muted, conv.id, req.user.id);
    res.json({ ok: true, muted: !!muted });
  }),
);

/** 输入中。走 HTTP 而不是 WebSocket，因为要限流，且丢一两个包无所谓。 */
conversationsRouter.post(
  '/conversations/:id/typing',
  wrap(async (req, res) => {
    if (!typingLimit(String(req.user.id))) return res.json({ ok: true, throttled: true });
    const conv = mustMember(req);
    const others = memberIds(conv.id).filter((id) => id !== req.user.id);
    sendToUsers(others, {
      t: 'typing',
      conversationId: conv.id,
      userId: req.user.id,
      name: req.user.display_name,
      until: now() + 5000,
    });
    res.json({ ok: true });
  }),
);

/* ------------------------------------------------------------------ */
/* 消息分页                                                            */
/* ------------------------------------------------------------------ */

conversationsRouter.get(
  '/conversations/:id/messages',
  wrap(async (req, res) => {
    const conv = mustMember(req);
    const before = req.query.before ? intId(req.query.before, '游标') : undefined;
    const after = req.query.after ? intId(req.query.after, '游标') : undefined;
    // 一定要取整：limit=2.5 会一路进到 SQL 的 LIMIT，SQLite 直接报
    // SQLITE_MISMATCH，一个手写的查询串就能把接口变成 500。
    const raw = Number.parseInt(req.query.limit ?? '', 10);
    const limit = Number.isSafeInteger(raw) ? Math.min(200, Math.max(1, raw)) : 50;
    const { messages, hasMore } = listMessages(conv.id, { before, after, limit });
    res.json({ messages, hasMore, conversation: summary(conv, req.user.id) });
  }),
);

export { HttpError };
