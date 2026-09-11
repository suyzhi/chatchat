/**
 * 运行时配置。所有可调项都走环境变量，便于 Docker 部署。
 * 优先读 process.env，本地开发时回退到项目根目录的 .env 文件。
 */
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 极简 .env 解析，避免为了读 6 个变量引入一个依赖。已存在的环境变量优先。 */
function loadDotEnv() {
  const p = join(ROOT, '.env');
  if (!existsSync(p)) return;
  for (const raw of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadDotEnv();

const bool = (v, dflt) => (v === undefined ? dflt : /^(1|true|yes|on)$/i.test(v));
const int = (v, dflt) => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : dflt;
};

const dataDir = resolve(ROOT, process.env.DATA_DIR || 'data');

export const config = {
  root: ROOT,
  dataDir,
  dbFile: join(dataDir, 'vellum.db'),
  uploadDir: join(dataDir, 'uploads'),
  tmpDir: join(dataDir, 'tmp'),

  port: int(process.env.PORT, 8787),
  host: process.env.HOST || '0.0.0.0',

  /** 站点名，显示在登录页和标题栏 */
  siteName: process.env.SITE_NAME || 'Vellum',
  /**
   * 登录页的一句话副标题。
   * 它紧跟在「只给几个人的地方」这句主标题下面，所以要说的是不同的事，
   * 不要重复主标题的意思。
   */
  siteTagline: process.env.SITE_TAGLINE || '没有信息流，没有推荐，没有陌生人。',

  /**
   * 注册邀请码。留空 = 自动生成一个（存进数据库，启动日志里会打印出来，
   * 管理员也能在设置里查看和更换）。设了这个值就固定用它，界面上不再允许改。
   * 数据库里一个用户都没有时，第一个注册的人直接成为管理员，不需要邀请码。
   */
  inviteCode: (process.env.INVITE_CODE || '').trim(),
  allowRegister: bool(process.env.ALLOW_REGISTER, true),

  sessionDays: int(process.env.SESSION_DAYS, 30),
  /** 单文件上限，默认 4GB。分块上传，所以这个值可以很大。 */
  maxFileBytes: int(process.env.MAX_FILE_MB, 4096) * 1024 * 1024,
  /** 分块大小，必须是前端也会读到的值 */
  chunkBytes: int(process.env.CHUNK_MB, 4) * 1024 * 1024,
  /** 每个用户每天允许上传的总字节数，防止误把服务器塞满。0 = 不限 */
  dailyUploadQuota: int(process.env.DAILY_UPLOAD_MB, 0) * 1024 * 1024,
  /** 磁盘剩余空间低于此值就拒绝新上传 */
  minFreeDiskBytes: int(process.env.MIN_FREE_MB, 512) * 1024 * 1024,

  /** 语音消息最长录制秒数 */
  maxVoiceSeconds: int(process.env.MAX_VOICE_SECONDS, 300),
  /** 消息可撤回的时间窗口（秒）。0 = 永久可撤回 */
  recallWindowSeconds: int(process.env.RECALL_SECONDS, 120),

  /**
   * 会话密钥。没配置就随机生成一个（进程重启后所有人需要重新登录，
   * 生产环境请在 .env 里固定下来）。
   */
  secret: process.env.SESSION_SECRET || randomBytes(32).toString('hex'),
  secretIsEphemeral: !process.env.SESSION_SECRET,

  /** 反向代理后面要信任的跳数，用于拿真实 IP */
  trustProxy: int(process.env.TRUST_PROXY, 1),
  /** 生产环境（HTTPS）下 cookie 加 Secure。留空则按请求协议自动判断。 */
  cookieSecure: process.env.COOKIE_SECURE === undefined ? null : bool(process.env.COOKIE_SECURE, false),

  /** 允许的注册邮箱域名白名单，留空表示不限制 */
  allowedEmailDomains: (process.env.ALLOWED_EMAIL_DOMAINS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
};

/** 确保运行期目录存在 */
export function ensureDirs() {
  for (const d of [config.dataDir, config.uploadDir, config.tmpDir]) {
    mkdirSync(d, { recursive: true });
  }
}

/** 启动时打印一份人类可读的配置摘要，方便排查部署问题 */
export function describeConfig() {
  const lines = [
    `站点名称      ${config.siteName}`,
    `监听          ${config.host}:${config.port}`,
    `数据目录      ${config.dataDir}`,
    `注册开关      ${config.allowRegister ? '开启（需要邀请码）' : '已关闭'}`,
    `单文件上限    ${(config.maxFileBytes / 1024 / 1024).toFixed(0)} MB`,
    `分块大小      ${(config.chunkBytes / 1024 / 1024).toFixed(0)} MB`,
    `语音上限      ${config.maxVoiceSeconds} 秒`,
    `撤回窗口      ${config.recallWindowSeconds ? config.recallWindowSeconds + ' 秒' : '不限'}`,
  ];
  if (config.secretIsEphemeral) {
    lines.push('会话密钥      未设置（本次为随机值，重启后所有登录会失效，生产环境请设置 SESSION_SECRET）');
  }
  return lines.join('\n  ');
}
