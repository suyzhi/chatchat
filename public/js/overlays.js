/**
 * 浮层基础件：对话框、右键菜单、确认框、输入框、图片灯箱。
 * 全部走同一套焦点管理，键盘用户不会被卡在里面。
 */
import { h, fill, append, trapFocus, toast } from './dom.js';
import { icon } from './icon.js';
import { bytes, timeFull } from './format.js';

const host = () => document.getElementById('overlays');

/* ------------------------------------------------------------------ */
/* 对话框                                                              */
/* ------------------------------------------------------------------ */

/**
 * @param {{
 *   title: string,
 *   desc?: string,
 *   body?: Node|Node[],
 *   actions?: (close: Function) => Node[],
 *   wide?: boolean,
 *   onClose?: Function,
 * }} opts
 * @returns {{close: Function, root: HTMLElement}}
 */
export function openDialog(opts) {
  const { title, desc, body, actions, wide, onClose } = opts;

  const dialog = h(`div.dialog${wide ? '.dialog--wide' : ''}`, {
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': title,
  });

  const bodyEl = h('div.dialog__body');
  if (body) fill(bodyEl, body);

  let releaseTrap = null;
  let closed = false;

  const close = (result) => {
    if (closed) return;
    closed = true;
    releaseTrap?.();
    scrim.remove();
    document.removeEventListener('keydown', onDocKey, true);
    onClose?.(result);
  };

  const footActions = actions ? actions(close) : [];
  /*
   * 必须用 dom.js 的 append，不能用原生 Element.append：
   * 原生 append 会把 null 转成字符串，于是没有底部按钮的对话框（比如
   * 「开始新聊天」）末尾会多出一个纯文本的 null。
   * 这里的 append 会跳过 null / undefined / false。
   */
  append(dialog, [
    h(
      'div.dialog__head',
      h(
        'div',
        { style: { flex: '1', minWidth: '0' } },
        h('h2.dialog__title', title),
        desc && h('p.dialog__desc', desc),
      ),
      h('button.icon-btn', { type: 'button', 'aria-label': '关闭', onClick: () => close(null) }, icon('x', { size: 16 })),
    ),
    body ? bodyEl : null,
    footActions.length ? h('div.dialog__foot', footActions) : null,
  ]);

  const scrim = h('div.scrim', {
    onMousedown: (e) => {
      if (e.target === scrim) close(null);
    },
  }, dialog);

  const onDocKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close(null);
    }
  };

  host().appendChild(scrim);
  releaseTrap = trapFocus(dialog, { onEscape: () => close(null) });
  document.addEventListener('keydown', onDocKey, true);

  // 聚焦第一个输入框，没有就聚焦到对话框本身
  requestAnimationFrame(() => {
    const first = dialog.querySelector(
      'input:not([type=hidden]),textarea,select,button.btn--primary,button',
    );
    first?.focus({ preventScroll: true });
  });

  return { close, root: dialog };
}

/* ------------------------------------------------------------------ */
/* 确认 / 输入                                                         */
/* ------------------------------------------------------------------ */

/**
 * @returns {Promise<boolean>}
 */
export function confirmDialog({
  title,
  desc,
  confirmLabel = '确定',
  cancelLabel = '取消',
  danger = false,
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const { close } = openDialog({
      title,
      desc,
      actions: (c) => [
        h('button.btn.btn--outline', { type: 'button', text: cancelLabel, onClick: () => { finish(false); c(null); } }),
        h(
          `button.btn.${danger ? 'btn--danger' : 'btn--primary'}`,
          { type: 'button', text: confirmLabel, onClick: () => { finish(true); c(true); } },
        ),
      ],
      onClose: () => finish(false),
    });
    void close;
  });
}

/**
 * @returns {Promise<string|null>} 取消返回 null
 */
export function promptDialog({
  title,
  desc,
  label,
  value = '',
  placeholder = '',
  confirmLabel = '保存',
  maxLength = 200,
  multiline = false,
  allowEmpty = false,
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };

    const input = multiline
      ? h('textarea.textarea', { placeholder, maxLength, rows: 3 })
      : h('input.input', { type: 'text', placeholder, maxLength });
    input.value = value;

    const errorEl = h('p.field__error', { hidden: true });

    const submit = (close) => {
      const v = input.value.trim();
      if (!v && !allowEmpty) {
        fill(errorEl, icon('warning-circle', { size: 14 }), h('span', `${label || '内容'}不能为空`));
        errorEl.hidden = false;
        input.classList.add('input--invalid');
        input.focus();
        return;
      }
      finish(v);
      close(v);
    };

    input.addEventListener('input', () => {
      errorEl.hidden = true;
      input.classList.remove('input--invalid');
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !multiline) {
        e.preventDefault();
        submit(currentClose);
      }
    });

    let currentClose = null;
    const { close } = openDialog({
      title,
      desc,
      body: h('div.field', h('label.field__label', label || '内容'), input, errorEl),
      actions: (c) => [
        h('button.btn.btn--outline', { type: 'button', text: '取消', onClick: () => { finish(null); c(null); } }),
        h('button.btn.btn--primary', { type: 'button', text: confirmLabel, onClick: () => submit(c) }),
      ],
      onClose: () => finish(null),
    });
    currentClose = close;
  });
}

/* ------------------------------------------------------------------ */
/* 弹出菜单                                                            */
/* ------------------------------------------------------------------ */

/**
 * @param {{
 *   anchor: HTMLElement,
 *   items: Array<{label?: string, icon?: string, onClick?: Function, danger?: boolean, disabled?: boolean, separator?: boolean, header?: boolean}>,
 *   align?: 'left'|'right',
 * }} opts
 */
export function openMenu({ anchor, items, align = 'right' }) {
  document.querySelectorAll('.menu').forEach((m) => m.remove());

  const menu = h('div.menu', { role: 'menu' });
  for (const item of items) {
    if (!item) continue;
    if (item.separator) {
      menu.appendChild(h('div.menu__sep'));
      continue;
    }
    if (item.header) {
      menu.appendChild(h('div.menu__label.meta', item.label));
      continue;
    }
    menu.appendChild(
      h(
        `button.menu__item${item.danger ? '.menu__item--danger' : ''}`,
        {
          type: 'button',
          role: 'menuitem',
          disabled: !!item.disabled,
          onClick: () => {
            menu.remove();
            cleanup();
            item.onClick?.();
          },
        },
        item.icon ? icon(item.icon, { size: 15 }) : null,
        h('span', { style: { flex: '1' } }, item.label),
      ),
    );
  }

  host().appendChild(menu);

  // 定位：默认贴住锚点右下，超出视口就往回收
  const rect = anchor.getBoundingClientRect();
  const mrect = menu.getBoundingClientRect();
  let left = align === 'right' ? rect.right - mrect.width : rect.left;
  let top = rect.bottom + 6;
  if (top + mrect.height > window.innerHeight - 8) {
    top = Math.max(8, rect.top - mrect.height - 6);
  }
  left = Math.min(Math.max(8, left), window.innerWidth - mrect.width - 8);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  menu.querySelector('button')?.focus({ preventScroll: true });

  const onDown = (e) => {
    if (!menu.contains(e.target)) {
      menu.remove();
      cleanup();
    }
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      menu.remove();
      cleanup();
      anchor.focus?.({ preventScroll: true });
    }
  };
  const cleanup = () => {
    document.removeEventListener('mousedown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', cleanup);
    window.removeEventListener('scroll', cleanup, true);
  };

  setTimeout(() => {
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', cleanup);
    window.addEventListener('scroll', cleanup, true);
  }, 0);

  return { close: cleanup };
}

/* ------------------------------------------------------------------ */
/* 图片灯箱                                                            */
/* ------------------------------------------------------------------ */

/**
 * @param {{file: object, senderName?: string, createdAt?: number}} opts
 */
export function openLightbox({ file, senderName, createdAt }) {
  const img = h('img', { src: file.url, alt: file.name, decoding: 'async' });

  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    root.remove();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };

  const root = h(
    'div.lightbox',
    { role: 'dialog', 'aria-modal': 'true', 'aria-label': file.name },
    h(
      'div.lightbox__bar',
      h('span.lightbox__name', file.name),
      h(
        'span.lightbox__meta',
        [senderName, createdAt ? timeFull(createdAt) : null, bytes(file.size)]
          .filter(Boolean)
          .join('  ·  '),
      ),
      h('span.lightbox__spacer'),
      h(
        'a.icon-btn',
        {
          href: `${file.url}?download=1`,
          download: file.name,
          'aria-label': '下载原图',
          title: '下载原图',
        },
        icon('download-simple', { size: 17 }),
      ),
      h('button.icon-btn', { type: 'button', 'aria-label': '关闭', onClick: close }, icon('x', { size: 17 })),
    ),
    h('div.lightbox__stage', {
      onClick: (e) => {
        if (e.target === e.currentTarget) close();
      },
    }, img),
  );

  host().appendChild(root);
  document.addEventListener('keydown', onKey, true);
  trapFocus(root, { onEscape: close });

  img.addEventListener('error', () => {
    fill(img.parentElement, h('p', { style: { color: '#fff' } }, '图片加载失败'));
    toast('图片加载失败，可能已从服务器删除', { tone: 'error' });
  });

  return { close };
}
