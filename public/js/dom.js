/**
 * DOM 小工具。
 *
 * 关键约束：所有用户内容一律走 textContent，绝不拼 innerHTML。
 * 消息正文、文件名、昵称都是不可信输入，这样从根上就不会有 XSS。
 */

/**
 * 创建元素。
 * @param {string} tag 支持 'div.cls.other' 这种简写
 * @param {object|null} props 属性、事件（on*）、dataset（data*）、style
 * @param {...any} children 字符串 / 节点 / 数组 / null
 */
export function h(tag, props, ...children) {
  const [name, ...classes] = String(tag).split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');

  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
    children.unshift(props);
    props = null;
  }

  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class' || k === 'className') {
      el.className = el.className ? `${el.className} ${v}` : String(v);
    } else if (k === 'text') {
      el.textContent = String(v);
    } else if (k === 'html') {
      // 只用于已经由本模块生成的、不含用户数据的片段
      el.innerHTML = String(v);
    } else if (k === 'style' && typeof v === 'object') {
      Object.assign(el.style, v);
    } else if (k === 'dataset' && typeof v === 'object') {
      Object.assign(el.dataset, v);
    } else if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k in el && k !== 'list' && typeof v !== 'object') {
      try {
        el[k] = v;
      } catch {
        el.setAttribute(k, String(v));
      }
    } else {
      el.setAttribute(k, String(v));
    }
  }

  append(el, children);
  return el;
}

/** 递归插入子节点，自动跳过 null / false / undefined */
export function append(parent, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false || child === true) continue;
    parent.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

/** 替换元素内容 */
export function fill(parent, ...children) {
  parent.replaceChildren();
  append(parent, children);
  return parent;
}

export const qsa = (sel, root = document) => [...root.querySelectorAll(sel)];

/**
 * 把一段文本按关键词切成带 <mark> 的片段，用于搜索结果高亮。
 * 仍然不用 innerHTML：mark 元素是 createElement 出来的。
 */
export function highlight(text, keyword) {
  const frag = document.createDocumentFragment();
  const src = String(text ?? '');
  const kw = String(keyword ?? '');
  if (!kw) {
    frag.appendChild(document.createTextNode(src));
    return frag;
  }
  const lower = src.toLowerCase();
  const needle = kw.toLowerCase();
  let from = 0;
  for (;;) {
    const at = lower.indexOf(needle, from);
    if (at < 0) break;
    if (at > from) frag.appendChild(document.createTextNode(src.slice(from, at)));
    frag.appendChild(h('mark', src.slice(at, at + needle.length)));
    from = at + needle.length;
  }
  if (from < src.length) frag.appendChild(document.createTextNode(src.slice(from)));
  return frag;
}

/* ------------------------------------------------------------------ */
/* 焦点陷阱                                                            */
/* ------------------------------------------------------------------ */

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function focusables(root) {
  return qsa(FOCUSABLE, root).filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

/** 在容器内循环 Tab，并在关闭时把焦点还给打开它的元素 */
export function trapFocus(root, { onEscape } = {}) {
  const previous = document.activeElement;
  const onKey = (e) => {
    if (e.key === 'Escape' && onEscape) {
      e.stopPropagation();
      onEscape();
      return;
    }
    if (e.key !== 'Tab') return;
    const list = focusables(root);
    if (list.length === 0) return;
    const first = list[0];
    const last = list[list.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
  root.addEventListener('keydown', onKey);
  return () => {
    root.removeEventListener('keydown', onKey);
    if (previous instanceof HTMLElement && document.contains(previous)) {
      previous.focus({ preventScroll: true });
    }
  };
}

/* ------------------------------------------------------------------ */
/* 提示条                                                              */
/* ------------------------------------------------------------------ */

const toastHost = () => document.getElementById('toasts');

/**
 * @param {string} message
 * @param {{tone?: 'default'|'error'|'ok', timeout?: number, action?: {label: string, onClick: Function}}} [opts]
 */
export function toast(message, opts = {}) {
  const { tone = 'default', timeout = tone === 'error' ? 5200 : 3200, action } = opts;
  const host = toastHost();
  if (!host) return () => {};

  const node = h(
    `div.toast${tone === 'error' ? '.toast--error' : tone === 'ok' ? '.toast--ok' : ''}`,
    h('span.toast__msg', String(message)),
    action &&
      h('button.toast__action', {
        type: 'button',
        text: action.label,
        onClick: () => {
          action.onClick();
          dismiss();
        },
      }),
  );

  let timer = null;
  const dismiss = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    node.style.transition = 'opacity 120ms ease';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 130);
  };

  node.addEventListener('click', (e) => {
    if (e.target === node) dismiss();
  });
  host.appendChild(node);
  timer = setTimeout(dismiss, timeout);
  return dismiss;
}

/* ------------------------------------------------------------------ */
/* 剪贴板                                                              */
/* ------------------------------------------------------------------ */

/** 优先用异步剪贴板；不安全上下文（http 非 localhost）下回退到 execCommand */
export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 落到下面的兜底 */
  }
  try {
    const ta = h('textarea', {
      value: text,
      style: { position: 'fixed', top: '-1000px', opacity: '0' },
      readonly: true,
    });
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* 滚动                                                                */
/* ------------------------------------------------------------------ */

export const isNearBottom = (el, slack = 120) =>
  el.scrollHeight - el.scrollTop - el.clientHeight < slack;

export function scrollToBottom(el, smooth = false) {
  el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
}

/** 等待下一帧，用于测量刚插入 DOM 的元素 */
export const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

/** 防抖 */
export function debounce(fn, wait = 200) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}
