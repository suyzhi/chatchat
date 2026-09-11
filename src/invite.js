/**
 * 邀请码。
 *
 * 设计取舍：不要在没配 INVITE_CODE 时就把注册关掉，那会让部署的人
 * 给自己注册完就再也加不进朋友，而且没有任何提示。这里的做法是：
 *  - 配了 INVITE_CODE 就听配置的；
 *  - 没配就自动生成一个，存进数据库，并在启动日志里打印出来；
 *  - 管理员随时可以在设置里看、也可以一键换一个新的。
 * 于是「默认安全」和「开箱能用」同时成立。
 */
import { randomBytes } from 'node:crypto';
import { getMeta, setMeta } from './db.js';
import { config } from './config.js';

const META_KEY = 'invite_code';

/** 去掉了容易看错的 0/O、1/I/L */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function generate(length = 10) {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

/**
 * 当前生效的邀请码。
 * @returns {{code: string, source: 'env'|'generated'}}
 */
export function currentInvite() {
  if (config.inviteCode) return { code: config.inviteCode, source: 'env' };
  let code = getMeta(META_KEY);
  if (!code) {
    code = generate();
    setMeta(META_KEY, code);
  }
  return { code, source: 'generated' };
}

/** 换一个新邀请码，旧的立刻失效 */
export function rotateInvite() {
  const code = generate();
  setMeta(META_KEY, code);
  return { code, source: 'generated' };
}

/** 校验用户提交的邀请码。用定长比较，避免时序侧信道（虽然这里不敏感，但便宜）。 */
export function inviteMatches(input) {
  const { code } = currentInvite();
  const a = String(input ?? '').trim().toUpperCase();
  const b = code.toUpperCase();
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < b.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
