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
const MAX_ATTEMPTS = 10;

export function throttleKey(req, username) {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  return `${ip}|${String(username || '').toLowerCase()}`;
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

export function noteFailure(key) {
  const t = now();
  let rec = attempts.get(key);
  if (!rec || t - rec.first > WINDOW_MS) {
    rec = { count: 0, first: t, blockedUntil: 0 };
    attempts.set(key, rec);
  }
  rec.count += 1;
  if (rec.count >= MAX_ATTEMPTS) {
    rec.blockedUntil = t + WINDOW_MS;
    rec.count = 0;
    rec.first = t;
  }
}

export const clearFailures = (key) => attempts.delete(key);

/* 退出时清干净 */
export function shutdownAuth() {
  attempts.clear();
  closeDb();
}
