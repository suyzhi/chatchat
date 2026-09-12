/**
 * 认证与会话。
 *
 * 密码用 Node 内置的 scrypt（内存硬，抗 GPU 爆破），不引入 bcrypt 原生依赖。
 * 会话是存在数据库里的随机 token，cookie 只带 token 本身，
 * 这样「登出所有设备」只是删几行记录。
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { config } from './config.js';
import { db, now, userById, closeDb } from './db.js';

const scrypt = promisify(scryptCb);

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const COOKIE_NAME = 'vellum_session';

/* ------------------------------------------------------------------ */
/* 密码                                                                */
/* ------------------------------------------------------------------ */

export async function hashPassword(plain) {
  const salt = randomBytes(16);
  const key = await scrypt(plain, salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(plain, stored) {
  try {
    const [scheme, N, r, p, saltB64, keyB64] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(keyB64, 'base64');
    const actual = await scrypt(plain, salt, expected.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
    });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* 会话                                                                */
/* ------------------------------------------------------------------ */

const hashToken = (token) => createHash('sha256').update(token).digest('hex');

export function createSession(userId, { userAgent, ip } = {}) {
  const token = randomBytes(32).toString('base64url');
  const t = now();
  db.prepare(
    `INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent, ip)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    hashToken(token),
    userId,
    t,
    t + config.sessionDays * 86400_000,
    String(userAgent || '').slice(0, 255),
    String(ip || '').slice(0, 64),
  );
  return token;
}

export function destroySession(token) {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
}

export function destroyAllSessions(userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

export function userFromToken(token) {
  if (!token) return null;
  const row = db
    .prepare('SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?')
    .get(hashToken(token), now());
  if (!row) return null;
  return userById(row.user_id) || null;
}

/** 定期清掉过期会话，避免表无限增长 */
export function pruneSessions() {
  return db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now()).changes;
}

/* ------------------------------------------------------------------ */
/* Cookie                                                              */
/* ------------------------------------------------------------------ */

/** 不依赖 cookie-parser 的极简解析 */
export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      out[k] = part.slice(eq + 1).trim();
    }
  }
  return out;
}

export function sessionCookie(token, req) {
  const secure =
    config.cookieSecure === null ? Boolean(req?.secure) : config.cookieSecure;
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${config.sessionDays * 86400}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export const clearCookie = () => `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

export const readSessionToken = (req) => parseCookies(req.headers.cookie)[COOKIE_NAME] || null;

/* ------------------------------------------------------------------ */
/* 中间件                                                              */
/* ------------------------------------------------------------------ */

/** 挂载 req.user；未登录不报错，交给 requireAuth 决定 */
export function attachUser(req, _res, next) {
  const token = readSessionToken(req);
  req.sessionToken = token;
  req.user = userFromToken(token);
  if (req.user) {
    // 每 5 分钟才写一次库，避免每条请求都产生写入
    if (now() - (req.user.last_seen_at || 0) > 300_000) {
      db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(now(), req.user.id);
    }
  }
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: '未登录', code: 'unauthenticated' });
  next();
}

/* ------------------------------------------------------------------ */
/* 登录限流（内存即可，单进程部署）                                     */
/* ------------------------------------------------------------------ */

const attempts = new Map(); // key -> {count, first, blockedUntil}
const WINDOW_MS = 15 * 60_000;
/** 同一个「来源 + 用户名」的容错次数 */
const MAX_ATTEMPTS = 10;
/** 同一个来源不区分用户名的容错次数。防止换着用户名刷，把 CPU 耗在 scrypt 上 */
export const MAX_ATTEMPTS_PER_SOURCE = 30;
/** 上限，防止有人用随机用户名把这张表撑爆 */
const MAX_KEYS = 5000;

/**
 * 限流用的「来源」标识。
 *
 * req.ip 在两种正确配置下都是不可伪造的：
 *  - TRUST_PROXY=0（默认）：X-Forwarded-For 被忽略，req.ip 就是 TCP 对端地址；
 *  - TRUST_PROXY=1 且在反代后面：反代会覆写 XFF，req.ip 是真实客户端地址。
 * 真正危险的是「直接暴露 + TRUST_PROXY>0」—— 那时 req.ip 由客户端决定，
 * 所以配置默认值选的是 0。见 config.js 里 trustProxy 的说明。
 */
export function clientKey(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

/** 两层桶：一层认人，一层认来源 */
export function throttleKeys(req, username) {
  const source = clientKey(req);
  return {
    user: `${source}|u:${String(username || '').toLowerCase()}`,
    source: `${source}|*`,
  };
}

export function isThrottled(key) {
  const rec = attempts.get(key);
  if (!rec) return 0;
  if (rec.blockedUntil && rec.blockedUntil > now()) {
    return Math.ceil((rec.blockedUntil - now()) / 1000);
  }
  if (now() - rec.first > WINDOW_MS) {
    attempts.delete(key);
    return 0;
  }
  return 0;
}

export function noteFailure(key, max = MAX_ATTEMPTS) {
  const t = now();
  let rec = attempts.get(key);
  if (!rec || t - rec.first > WINDOW_MS) {
    // 表太大就先清掉已经过期的那批，避免随机用户名把它撑爆
    if (!rec && attempts.size >= MAX_KEYS) sweepAttempts();
    rec = { count: 0, first: t, blockedUntil: 0 };
    attempts.set(key, rec);
  }
  rec.count += 1;
  if (rec.count >= max) {
    rec.blockedUntil = t + WINDOW_MS;
    rec.count = 0;
    rec.first = t;
  }
}

/** 清掉已经过期的记录。以前只有「再次访问同一个键」时才会删，等于永远不删。 */
export function sweepAttempts() {
  const t = now();
  let removed = 0;
  for (const [key, rec] of attempts) {
    const expired = rec.blockedUntil ? rec.blockedUntil <= t : t - rec.first > WINDOW_MS;
    if (expired) {
      attempts.delete(key);
      removed += 1;
    }
  }
  return removed;
}

export const clearFailures = (key) => attempts.delete(key);

const attemptsSweep = setInterval(sweepAttempts, 10 * 60_000);
attemptsSweep.unref?.();

/* 退出时清干净 */
export function shutdownAuth() {
  clearInterval(attemptsSweep);
  attempts.clear();
  closeDb();
}
