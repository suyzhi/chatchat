/**
 * 图标渲染运行时。路径数据来自 ./icons.js（由 tools/build-icons.mjs 从
 * @phosphor-icons/core 官方源生成，MIT）。这里只负责把它变成 DOM / HTML。
 */
import { PATHS } from './icons.js';

const NS = 'http://www.w3.org/2000/svg';

/** 找不到图标时画一个虚线方块，让问题一眼可见，而不是静默留白。 */
const FALLBACK =
  '<rect x="48" y="48" width="160" height="160" rx="8" fill="none" stroke="currentColor" stroke-width="16" stroke-dasharray="24 20"/>';

function attrs(el, size) {
  el.setAttribute('viewBox', '0 0 256 256');
  el.setAttribute('width', String(size));
  el.setAttribute('height', String(size));
  el.setAttribute('fill', 'currentColor');
  el.setAttribute('focusable', 'false');
  el.classList.add('ico');
}

/**
 * 生成一个 SVG 图标元素。
 * @param {string} name Phosphor 图标名
 * @param {{size?: number, className?: string, label?: string}} [opts]
 * @returns {SVGElement}
 */
export function icon(name, opts = {}) {
  const spec = PATHS[name];
  const el = document.createElementNS(NS, 'svg');
  attrs(el, opts.size ?? 18);
  if (opts.label) {
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', opts.label);
  } else {
    el.setAttribute('aria-hidden', 'true');
  }
  if (opts.className) for (const c of opts.className.split(/\s+/)) if (c) el.classList.add(c);
  if (!spec) {
    el.innerHTML = FALLBACK;
    console.warn('[icon] 未知图标:', name);
    return el;
  }
  el.setAttribute('viewBox', spec.viewBox);
  el.innerHTML = spec.body;
  return el;
}

/**
 * 与 icon() 相同，但返回 HTML 字符串，方便模板拼接。
 * @param {string} name
 * @param {{size?: number, className?: string}} [opts]
 */
export function iconHTML(name, opts = {}) {
  const spec = PATHS[name];
  const size = opts.size ?? 18;
  const cls = opts.className ? `ico ${opts.className}` : 'ico';
  const body = spec ? spec.body : FALLBACK;
  const vb = spec ? spec.viewBox : '0 0 256 256';
  return `<svg class="${cls}" viewBox="${vb}" width="${size}" height="${size}" fill="currentColor" aria-hidden="true" focusable="false">${body}</svg>`;
}

/** 把图标塞进一个已经存在的元素里（替换其内容）。 */
export function mountIcon(host, name, opts = {}) {
  host.replaceChildren(icon(name, opts));
  return host;
}

export const ICON_NAMES = Object.keys(PATHS);
