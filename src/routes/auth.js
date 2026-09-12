/**
 * 注册 / 登录 / 登出 / 个人资料。
 *
 * 注册策略：
 *  1. ALLOW_REGISTER=false    -> 完全关闭注册
 *  2. 数据库里还没有任何用户   -> 第一个注册的人成为管理员，无需邀请码
 *  3. 其余情况                -> 一律需要邀请码
 *
 * 邀请码在 src/invite.js 里管理：配置了 INVITE_CODE 就用配置的，
 * 没配就自动生成一个并打印在启动日志里。
 */
import { Router } from 'express';
import { config } from '../config.js';
import { db, now, isFirstRun, userByUsername, userById } from '../db.js';
import { inviteMatches } from '../invite.js';
import {
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  destroyAllSessions,
  sessionCookie,
  clearCookie,
  requireAuth,
  clientKey,
  throttleKeys,
  isThrottled,
  noteFailure,
  clearFailures,
  MAX_ATTEMPTS_PER_SOURCE,
} from '../auth.js';
import { publicUser } from '../serialize.js';
import { wrap, bad, forbidden, str, optStr, validateUsername, validatePassword, HttpError } from '../http.js';
import { rateLimiter } from '../util.js';

export const authRouter = Router();

/** 注册接口额外限流，防止有人拿脚本刷账号 */
const registerLimit = rateLimiter({ windowMs: 60 * 60_000, max: 20 });

/** 注册是否开放，以及是否需要邀请码 */
function registrationState() {
  if (!config.allowRegister) return { open: false, needsInvite: false, reason: '站点已关闭注册' };
  if (isFirstRun()) return { open: true, needsInvite: false, reason: null };
  return { open: true, needsInvite: true, reason: null };
}

authRouter.get('/config', (req, res) => {
  const state = registrationState();
  res.json({
    siteName: config.siteName,
    siteTagline: config.siteTagline,
    registration: { open: state.open, needsInvite: !!state.needsInvite, reason: state.reason },
    maxFileBytes: config.maxFileBytes,
    chunkBytes: config.chunkBytes,
    maxVoiceSeconds: config.maxVoiceSeconds,
    recallWindowSeconds: config.recallWindowSeconds,
  });
});

authRouter.post(
  '/register',
  wrap(async (req, res) => {
    // 注册限流按「不可伪造的来源」算，理由同登录：只看 req.ip 的话，
    // 直接暴露部署下客户端换个 X-Forwarded-For 就能无限注册。
    if (!registerLimit(clientKey(req))) throw new HttpError(429, '注册太频繁了，请稍后再试', 'rate_limited');

    const state = registrationState();
    if (!state.open) throw forbidden(state.reason || '站点已关闭注册');

    const username = validateUsername(req.body?.username);
    const displayName = str(req.body?.displayName ?? username, '昵称', { min: 1, max: 32 });
    const password = validatePassword(req.body?.password);
    const first = isFirstRun();

    if (!first && state.needsInvite && !inviteMatches(req.body?.inviteCode)) {
      throw forbidden('邀请码不对');
    }

    if (config.allowedEmailDomains.length) {
      const email = String(req.body?.email ?? '').trim().toLowerCase();
      if (!email) throw bad('本站要求填写邮箱');
      const domain = email.split('@')[1] || '';
      if (!config.allowedEmailDomains.includes(domain)) throw forbidden('这个邮箱域名不在允许列表里');
    }

    if (userByUsername(username)) throw bad('这个用户名已经有人用了');

    const t = now();
    // 先把哈希算出来：scrypt 是异步的，不能放在同步事务里面
    const passwordHash = await hashPassword(password);
    const email = optStr(req.body?.email, '邮箱', { max: 120 });

    let id;
    let isAdmin;
    try {
      /*
       * 「是不是第一个用户」必须在写入的那一刻重新判定，而且判定和写入要
       * 在同一个同步事务里。
       *
       * 上面那次 isFirstRun() 到这里的 INSERT 之间隔了一个 await，两个并发
       * 注册会都看到「还没有任何用户」，于是都不需要邀请码、都拿到管理员。
       * better-sqlite3 是同步的，事务里不会有别的请求插进来。
       */
      ({ id, isAdmin } = db.transaction(() => {
        const stillFirst = isFirstRun();
        if (
          !stillFirst &&
          !first &&
          state.needsInvite &&
          !inviteMatches(req.body?.inviteCode)
        ) {
          throw forbidden('邀请码不对');
        }
        const info = db
          .prepare(
            `INSERT INTO users (username, display_name, email, password_hash, is_admin, created_at, last_seen_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(username, displayName, email, passwordHash, stillFirst ? 1 : 0, t, t);
        return { id: Number(info.lastInsertRowid), isAdmin: stillFirst };
      })());
    } catch (err) {
      if (err instanceof HttpError) throw err;
      if (String(err.message).includes('UNIQUE')) throw bad('这个用户名已经有人用了');
      throw err;
    }

    const token = createSession(id, { userAgent: req.headers['user-agent'], ip: req.ip });
    res.setHeader('Set-Cookie', sessionCookie(token, req));
    res.status(201).json({ user: publicUser(userById(id)), becameAdmin: isAdmin });
  }),
);

authRouter.post(
  '/login',
  wrap(async (req, res) => {
    const username = String(req.body?.username ?? '').trim();
    const password = String(req.body?.password ?? '');
    if (!username || !password) throw bad('请填写用户名和密码');

    const keys = throttleKeys(req, username);
    const wait = Math.max(isThrottled(keys.user), isThrottled(keys.source));
    if (wait) throw new HttpError(429, `尝试次数过多，请 ${Math.ceil(wait / 60)} 分钟后再试`, 'rate_limited');

    const user = userByUsername(username);
    // 用户不存在时也跑一次 scrypt，避免通过响应时间判断账号是否存在
    const ok = user
      ? await verifyPassword(password, user.password_hash)
      : await verifyPassword(password, 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA');

    if (!user || !ok) {
      noteFailure(keys.user);
      noteFailure(keys.source, MAX_ATTEMPTS_PER_SOURCE);
      throw new HttpError(401, '用户名或密码不对', 'bad_credentials');
    }

    clearFailures(keys.user);
    db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(now(), user.id);
    const token = createSession(user.id, { userAgent: req.headers['user-agent'], ip: req.ip });
    res.setHeader('Set-Cookie', sessionCookie(token, req));
    res.json({ user: publicUser(user) });
  }),
);

authRouter.post('/logout', (req, res) => {
  destroySession(req.sessionToken);
  res.setHeader('Set-Cookie', clearCookie());
  res.json({ ok: true });
});

/** 登出所有设备 */
authRouter.post(
  '/logout-all',
  requireAuth,
  wrap(async (req, res) => {
    destroyAllSessions(req.user.id);
    res.setHeader('Set-Cookie', clearCookie());
    res.json({ ok: true });
  }),
);

authRouter.get('/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: '未登录', code: 'unauthenticated' });
  res.json({ user: publicUser(req.user) });
});

authRouter.patch(
  '/me',
  requireAuth,
  wrap(async (req, res) => {
    const displayName =
      req.body?.displayName === undefined
        ? req.user.display_name
        : str(req.body.displayName, '昵称', { min: 1, max: 32 });
    const about =
      req.body?.about === undefined ? req.user.about : optStr(req.body.about, '签名', { max: 140 });

    let avatar = req.user.avatar_file_id;
    if (req.body?.avatarFileId !== undefined) {
      if (req.body.avatarFileId === null || req.body.avatarFileId === '') {
        avatar = null;
      } else {
        const fid = str(req.body.avatarFileId, '头像', { max: 64 });
        const row = db.prepare('SELECT id, owner_id, kind FROM files WHERE id = ?').get(fid);
        if (!row) throw bad('头像文件不存在');
        if (row.owner_id !== req.user.id) throw forbidden('只能用自己的文件当头像');
        if (row.kind !== 'image') throw bad('头像必须是图片');
        avatar = fid;
      }
    }

    db.prepare('UPDATE users SET display_name = ?, about = ?, avatar_file_id = ? WHERE id = ?').run(
      displayName,
      about,
      avatar,
      req.user.id,
    );
    res.json({ user: publicUser(userById(req.user.id)) });
  }),
);

authRouter.post(
  '/password',
  requireAuth,
  wrap(async (req, res) => {
    const current = String(req.body?.currentPassword ?? '');
    const next = validatePassword(req.body?.newPassword);
    if (!(await verifyPassword(current, req.user.password_hash))) {
      throw new HttpError(401, '当前密码不对', 'bad_credentials');
    }
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(
      await hashPassword(next),
      req.user.id,
    );
    // 改密码后踢掉其他设备，但保留当前这台
    destroyAllSessions(req.user.id);
    const token = createSession(req.user.id, { userAgent: req.headers['user-agent'], ip: req.ip });
    res.setHeader('Set-Cookie', sessionCookie(token, req));
    res.json({ ok: true, note: '其他设备已退出登录' });
  }),
);
