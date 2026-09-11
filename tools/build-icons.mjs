/**
 * 从 @phosphor-icons/core 官方源提取图标路径数据，生成 public/js/icons.js。
 *
 * 为什么这么做：
 *  - 官方包是唯一的路径来源，不存在手写 SVG 路径。
 *  - 只打包用到的图标，产物约几十 KB，完全离线自托管，不依赖任何 CDN。
 *  - 前端零构建步骤：这个脚本只在开发期跑一次，产物直接提交进仓库。
 *
 * 运行时渲染辅助函数在 public/js/icon.js（手写，不被本脚本覆盖）。
 * 用法： npm run icons
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'node_modules', '@phosphor-icons', 'core', 'assets', 'regular');
const OUT = join(ROOT, 'public', 'js', 'icons.js');

/** 界面用到的全部图标。名字即 Phosphor 官方文件名，改这里就换图标。 */
const ICONS = [
  // 导航 / 外壳
  'chats-circle', 'address-book', 'gear-six', 'sign-out', 'sign-in',
  'magnifying-glass', 'plus', 'x', 'list', 'caret-right', 'caret-left',
  'caret-down', 'arrow-left', 'arrow-down', 'dots-three', 'dots-three-vertical',
  'sidebar-simple', 'user-switch',
  // 会话 / 消息
  'paper-plane-tilt', 'smiley', 'paperclip', 'image', 'microphone', 'waveform',
  'play', 'pause', 'stop', 'download-simple', 'file', 'file-text', 'file-zip',
  'file-pdf', 'file-audio', 'file-video', 'file-image', 'file-arrow-down',
  'copy', 'pencil-simple', 'trash', 'arrow-bend-up-left', 'check', 'checks',
  'clock-counter-clockwise', 'arrow-clockwise', 'prohibit',
  // 人 / 群
  'user', 'user-circle', 'user-plus', 'users-three', 'crown-simple', 'link-simple',
  // 状态
  'bell', 'bell-slash', 'warning-circle', 'info', 'check-circle',
  'circle-notch', 'eye', 'eye-slash', 'shield-check', 'lock-simple', 'key',
  'wifi-high', 'wifi-slash', 'speaker-high', 'speaker-slash', 'circle',
  'upload-simple', 'arrow-square-out', 'selection-all',
];

/** Phosphor 的 SVG 是 256 视口。把 <svg> 外壳剥掉，只留内部路径。 */
function extract(svg) {
  const viewBox = svg.match(/viewBox="([^"]+)"/)?.[1] ?? '0 0 256 256';
  const body = svg
    .replace(/^[\s\S]*?<svg[^>]*>/, '')
    .replace(/<\/svg>[\s\S]*$/, '')
    .trim();
  // 去掉任何硬编码的 fill/stroke，颜色完全交给 CSS 的 currentColor
  const clean = body.replace(/\sfill="(?!none)[^"]*"/g, '').replace(/\sstroke="[^"]*"/g, '');
  return { viewBox, body: clean };
}

const out = {};
const missing = [];
for (const name of ICONS) {
  try {
    const svg = await readFile(join(SRC, `${name}.svg`), 'utf8');
    out[name] = extract(svg);
  } catch {
    missing.push(name);
  }
}
if (missing.length) {
  console.error(`[icons] 官方源里找不到这些图标，请改名或删除： ${missing.join(', ')}`);
  process.exitCode = 1;
}

const header = [
  '/**',
  ' * 自动生成，请勿手改。源：@phosphor-icons/core (regular)，MIT License。',
  ' * 重新生成： npm run icons',
  ` * 图标总数：${Object.keys(out).length}`,
  ' */',
  '',
  '/** @type {Record<string, {viewBox: string, body: string}>} */',
  'export const PATHS = ',
].join('\n');

const file = `${header}${JSON.stringify(out)}\n`;

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, file, 'utf8');
console.log(`[icons] 已写出 ${Object.keys(out).length} 个图标 -> public/js/icons.js (${(file.length / 1024).toFixed(1)} KB)`);
