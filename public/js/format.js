/**
 * 格式化：时间、字节、文件名、消息预览。
 * 时间显示策略跟常见聊天软件一致：今天只给时分，昨天给「昨天」，
 * 一周内给星期，更早给日期，跨年才带年份。
 */

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

const pad = (n) => String(n).padStart(2, '0');

const sameDay = (a, b) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** 消息流里时间戳旁的短时间：14:05 */
export function timeShort(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 列表里的相对时间：14:05 / 昨天 / 周三 / 3月8日 / 2025年3月8日 */
export function timeRelative(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  if (sameDay(d, now)) return timeShort(ts);

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, yesterday)) return '昨天';

  const days = Math.floor((now - d) / 86400000);
  if (days < 7) return WEEK[d.getDay()];

  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 日期分隔条的文案 */
export function dayLabel(ts) {
  const d = new Date(ts);
  const now = new Date();
  if (sameDay(d, now)) return '今天';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, yesterday)) return '昨天';
  if (d.getFullYear() === now.getFullYear()) {
    return `${d.getMonth() + 1}月${d.getDate()}日 ${WEEK[d.getDay()]}`;
  }
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 悬停时的完整时间 */
export function timeFull(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}`;
}

/** 「刚刚」「3 分钟前」「2 小时前」，用于在线状态 */
export function timeAgo(ts) {
  if (!ts) return '离线';
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚在线';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前在线`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前在线`;
  if (diff < 7 * 86400_000) return `${Math.floor(diff / 86400_000)} 天前在线`;
  return `最后在线 ${timeRelative(ts)}`;
}

/** 秒数 -> 0:07 / 1:23 / 12:05 */
export function duration(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${pad(s)}`;
}

export function bytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let val = v / 1024;
  let i = 0;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i += 1;
  }
  return `${val < 10 ? val.toFixed(1) : Math.round(val)} ${units[i]}`;
}

/** 从 mime 判断给哪个图标 */
export function fileIconName(mime = '', name = '') {
  const m = String(mime).toLowerCase();
  const ext = (String(name).split('.').pop() || '').toLowerCase();
  if (m.includes('pdf') || ext === 'pdf') return 'file-pdf';
  if (m.startsWith('audio/')) return 'file-audio';
  if (m.startsWith('video/')) return 'file-video';
  if (m.startsWith('image/')) return 'file-image';
  if (/zip|rar|7z|tar|gzip|compress/.test(m) || /^(zip|rar|7z|tar|gz)$/.test(ext)) return 'file-zip';
  if (/^text\/|json|xml|csv|markdown/.test(m) || /^(txt|md|json|csv|log)$/.test(ext)) return 'file-text';
  return 'file';
}

/** 会话列表和通知里的一句话预览 */
export function messagePreview(msg) {
  if (!msg) return '';
  if (msg.kind === 'deleted') return '此消息已撤回';
  switch (msg.kind) {
    case 'image':
      return msg.body ? msg.body : '[图片]';
    case 'audio':
      return '[语音]';
    case 'video':
      return msg.body ? msg.body : '[视频]';
    case 'file':
      return `[文件] ${msg.file?.name || ''}`.trim();
    case 'system':
      return msg.body || '';
    default: {
      const t = String(msg.body || '').replace(/\s+/g, ' ').trim();
      return t.length > 90 ? `${t.slice(0, 90)}…` : t;
    }
  }
}

/** 群聊里显示「张三: 内容」，私聊不显示前缀 */
export function previewWithSender(msg, { showSender, isMine, senderName }) {
  const body = messagePreview(msg);
  if (!showSender || msg.kind === 'system') return body;
  return isMine ? `我: ${body}` : `${senderName}: ${body}`;
}

/** 昵称首字母，做无头像时的占位 */
export function initials(name = '') {
  const s = String(name).trim();
  if (!s) return '?';
  // 中文取第一个字，西文取首字母
  if (/[\u3400-\u9fff\uf900-\ufaff]/.test(s[0])) return s[0];
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return s.slice(0, 2).toUpperCase();
}

/** 由用户名稳定地推出一个色相，用于给不同人的左侧竖线着色。
 *  只调明度与灰阶，保持「一个强调色」的约束不被破坏。 */
export function toneFor(id) {
  const n = Number(id) || 0;
  const tones = ['#2340E8', '#0B0B0D', '#6E6E78', '#1C6B46', '#7A5A10', '#B4232A'];
  return tones[Math.abs(n) % tones.length];
}
