/**
 * HTTP 层的小工具：异步路由包装、统一错误形状、请求体校验。
 */
import { config } from './config.js';

/** Express 4 不会捕获 async 抛出的异常，统一包一层 */
export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** 业务错误。带 status 的会被错误中间件原样回报给前端。 */
export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || 'error';
  }
}

export const bad = (msg, code) => new HttpError(400, msg, code || 'bad_request');
export const forbidden = (msg = '没有权限') => new HttpError(403, msg, 'forbidden');
export const notFound = (msg = '不存在') => new HttpError(404, msg, 'not_found');

/* ------------------------------------------------------------------ */
/* 输入校验                                                            */
/* ------------------------------------------------------------------ */

/**
 * 取一个必填字符串字段并做长度校验。
 * @param {any} value
 * @param {string} label 用于错误信息的字段名
 * @param {{min?: number, max?: number, trim?: boolean}} [opts]
 */
export function str(value, label, opts = {}) {
  const { min = 1, max = 4000, trim = true } = opts;
  if (typeof value !== 'string') throw bad(`${label}格式不对`);
  const v = trim ? value.trim() : value;
  if (v.length < min) throw bad(min === 1 ? `${label}不能为空` : `${label}至少 ${min} 个字符`);
  if (v.length > max) throw bad(`${label}最多 ${max} 个字符`);
  return v;
}

export function optStr(value, label, opts = {}) {
  if (value === undefined || value === null || value === '') return null;
  return str(value, label, opts);
}

/**
 * 取一个正整数 id。
 *
 * 只认数字本身和纯十进制字符串（查询参数一律是字符串）。不用裸 Number()：
 * 它会把 true 变成 1、把 '0x10' 变成 16、把 ['2'] 变成 2，这些都不该被
 * 当成一个合法的 id —— 否则 `{"userId": true}` 就能悄悄变成「和 1 号私聊」。
 */
export function intId(value, label = '标识') {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value.trim())
        ? Number(value.trim())
        : Number.NaN;
  if (!Number.isSafeInteger(n) || n <= 0) throw bad(`${label}无效`);
  return n;
}

/** 用户名规则：字母数字下划线连字符，3 到 24 位 */
export const USERNAME_RE = /^[A-Za-z0-9_-]{3,24}$/;

export function validateUsername(value) {
  const v = str(value, '用户名', { min: 3, max: 24 });
  if (!USERNAME_RE.test(v)) {
    throw bad('用户名只能用字母、数字、下划线、连字符，3 到 24 位');
  }
  return v;
}

export function validatePassword(value) {
  const v = str(value, '密码', { min: 8, max: 200, trim: false });
  if (v.length > 200) throw bad('密码太长了');
  return v;
}

/** 统一错误响应。生产环境不把堆栈丢给前端。 */
export function errorHandler(err, req, res, _next) {
  // body-parser 的报错要翻译成人话，否则前端只会看到 "request entity too large"
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: '这一块数据太大了', code: 'payload_too_large' });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: '请求体不是合法的 JSON', code: 'bad_json' });
  }

  const status = err.status || err.statusCode || 500;
  if (status >= 500) {
    console.error(`[error] ${req.method} ${req.originalUrl}`, err);
  }
  if (res.headersSent) return;
  res.status(status).json({
    error: status >= 500 ? '服务器内部错误' : err.message,
    code: err.code || 'error',
  });
}

/** 安全响应头。图片/音频需要内联，其余保持最严格。 */
export function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=(self)');
  if (!req.path.startsWith('/api/files/')) {
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  }
  next();
}

/** 页面级 CSP。前端是零构建的原生模块，所以只需要放开同源脚本与内联样式。
 *  媒体要允许 blob:（本地录音预览）和 data:（内联图标）。 */
export function contentSecurityPolicy(_req, res, next) {
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      // 内联 style 只用于动态尺寸（图片宽高比占位），样式表本身全部外链
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "media-src 'self' blob:",
      "font-src 'self'",
      "connect-src 'self' ws: wss:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'self'",
    ].join('; '),
  );
  next();
}

export { config };
