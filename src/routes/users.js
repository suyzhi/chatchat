/**
 * 用户目录与联系人。
 *
 * 这是私人站点，所以 /api/users 会返回全部已注册成员，方便互相加好友。
 * 如果你想更封闭，把 DIRECTORY_OPEN 关掉即可，但那样就得手工建群。
 */
import { Router } from 'express';
import { db, now, userById } from '../db.js';
import { requireAuth } from '../auth.js';
import { publicUser, publicContact } from '../serialize.js';
import { wrap, bad, notFound, str, optStr, intId } from '../http.js';
import { isOnline } from '../presence.js';

export const usersRouter = Router();
usersRouter.use(requireAuth);

/** 全员目录 */
usersRouter.get(
  '/users',
  wrap(async (req, res) => {
    const rows = db.prepare('SELECT * FROM users ORDER BY display_name COLLATE NOCASE').all();
    const aliases = new Map(
      db
        .prepare('SELECT user_id, alias FROM contacts WHERE owner_id = ?')
        .all(req.user.id)
        .map((r) => [r.user_id, r.alias]),
    );
    res.json({
      users: rows.map((u) => {
        const base = publicUser(u);
        return {
          ...base,
          isSelf: u.id === req.user.id,
          isContact: aliases.has(u.id),
          alias: aliases.get(u.id) || null,
          // 有备注名时优先显示备注名
          name: aliases.get(u.id) || base.displayName,
        };
      }),
    });
  }),
);

usersRouter.get(
  '/users/:id',
  wrap(async (req, res) => {
    const id = intId(req.params.id, '用户');
    const user = userById(id);
    if (!user) throw notFound('用户不存在');
    const contact = db
      .prepare('SELECT alias FROM contacts WHERE owner_id = ? AND user_id = ?')
      .get(req.user.id, id);
    // 顺便给出和这个人相关的共同群聊，方便资料卡里跳转
    const shared = db
      .prepare(
        `SELECT c.id, c.type, c.title
           FROM conversations c
           JOIN conversation_members me ON me.conversation_id = c.id AND me.user_id = ?
           JOIN conversation_members them ON them.conversation_id = c.id AND them.user_id = ?
          WHERE c.type = 'group'`,
      )
      .all(req.user.id, id);
    res.json({
      user: publicContact(user, contact?.alias),
      sharedGroups: shared.map((c) => ({ id: c.id, title: c.title || '未命名群聊' })),
    });
  }),
);

/* ------------------------------------------------------------------ */
/* 联系人                                                              */
/* ------------------------------------------------------------------ */

usersRouter.get(
  '/contacts',
  wrap(async (req, res) => {
    const rows = db
      .prepare(
        `SELECT u.*, ct.alias, ct.created_at AS added_at
           FROM contacts ct
           JOIN users u ON u.id = ct.user_id
          WHERE ct.owner_id = ?
          ORDER BY COALESCE(NULLIF(ct.alias, ''), u.display_name) COLLATE NOCASE`,
      )
      .all(req.user.id);
    res.json({
      contacts: rows.map((r) => ({ ...publicContact(r, r.alias), addedAt: r.added_at })),
    });
  }),
);

/** 也可按用户名精确添加，省得在列表里找 */
usersRouter.post(
  '/contacts',
  wrap(async (req, res) => {
    let target;
    if (req.body?.username) {
      target = db
        .prepare('SELECT * FROM users WHERE username = ?')
        .get(str(req.body.username, '用户名', { max: 24 }));
    } else {
      target = userById(intId(req.body?.userId, '用户'));
    }
    if (!target) throw notFound('找不到这个用户');
    if (target.id === req.user.id) throw bad('不能把自己加为联系人');

    const alias = optStr(req.body?.alias, '备注名', { max: 32 });
    db.prepare(
      `INSERT INTO contacts (owner_id, user_id, alias, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(owner_id, user_id) DO UPDATE SET alias = COALESCE(excluded.alias, contacts.alias)`,
    ).run(req.user.id, target.id, alias, now());

    res.status(201).json({ contact: publicContact(target, alias) });
  }),
);

usersRouter.patch(
  '/contacts/:id',
  wrap(async (req, res) => {
    const id = intId(req.params.id, '用户');
    const exists = db
      .prepare('SELECT 1 FROM contacts WHERE owner_id = ? AND user_id = ?')
      .get(req.user.id, id);
    if (!exists) throw notFound('还没加这个联系人');
    const alias = optStr(req.body?.alias, '备注名', { max: 32 });
    db.prepare('UPDATE contacts SET alias = ? WHERE owner_id = ? AND user_id = ?').run(
      alias,
      req.user.id,
      id,
    );
    res.json({ contact: publicContact(userById(id), alias) });
  }),
);

usersRouter.delete(
  '/contacts/:id',
  wrap(async (req, res) => {
    const id = intId(req.params.id, '用户');
    db.prepare('DELETE FROM contacts WHERE owner_id = ? AND user_id = ?').run(req.user.id, id);
    res.json({ ok: true });
  }),
);

/** 给前端做在线状态兜底轮询用，正常情况下走 WebSocket 推送 */
usersRouter.get('/presence', (req, res) => {
  const rows = db.prepare('SELECT id FROM users').all();
  res.json({ online: rows.filter((r) => isOnline(r.id)).map((r) => r.id) });
});
