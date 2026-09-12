/**
 * 应用外壳：左侧导航栏 + 中间列表栏 + 右侧消息栏。
 * 窄屏时导航栏变成底部条，列表与消息两栏互斥显示。
 */
import { h, fill } from '../dom.js';
import { icon } from '../icon.js';
import { state, bus, unreadTotal } from '../store.js';
import { avatarNode } from './parts.js';

/**
 * @param {HTMLElement} root
 * @param {{
 *   onNavigate: (view: string) => void,
 *   onOpenMe: (anchor: HTMLElement) => void,
 *   onOpenSettings: () => void,
 * }} handlers
 */
export function renderShell(root, handlers) {
  /* ---------------- 左栏 ---------------- */

  const navButtons = new Map();
  const makeRailBtn = (view, iconName, label) => {
    const badge = h('span.rail-btn__badge', { hidden: true });
    const btn = h(
      'button.rail-btn',
      {
        type: 'button',
        'aria-label': label,
        title: label,
        onClick: () => handlers.onNavigate(view),
      },
      icon(iconName, { size: 19 }),
      h('span.rail-btn__label', label),
      badge,
    );
    btn._badge = badge;
    navButtons.set(view, btn);
    return btn;
  };

  const meAvatarHost = h('button.rail__me', {
    type: 'button',
    'aria-label': '我的账号',
    title: '我的账号',
    style: { borderRadius: 'var(--r-round)', lineHeight: '0' },
    onClick: () => handlers.onOpenMe(meAvatarHost),
  });

  const rail = h(
    'nav.rail',
    { 'aria-label': '主导航' },
    h('div.rail__brand', { 'aria-hidden': 'true' }, 'V'),
    h(
      'div.rail__nav',
      makeRailBtn('chats', 'chats-circle', '会话'),
      makeRailBtn('contacts', 'address-book', '联系人'),
      makeRailBtn('search', 'magnifying-glass', '搜索'),
    ),
    h('div.rail__spacer'),
    h(
      'div.rail__foot',
      h(
        'button.rail-btn',
        {
          type: 'button',
          'aria-label': '设置',
          title: '设置',
          onClick: () => handlers.onOpenSettings(),
        },
        icon('gear-six', { size: 19 }),
        h('span.rail-btn__label', '设置'),
      ),
    ),
    meAvatarHost,
  );

  /* ---------------- 中栏 ---------------- */

  const listHead = h('div.pane__head');
  const listBody = h('div.pane__body');
  const listPane = h(
    'section.pane.pane--list',
    { 'aria-label': '会话列表', dataset: { pane: 'list', active: 'true' } },
    listHead,
    listBody,
  );

  /* ---------------- 右栏 ---------------- */

  const threadHead = h('div.pane__head');
  const threadScroll = h('div.thread', { tabIndex: -1 });
  const threadFoot = h('div.composer');
  const threadPane = h(
    'section.pane.pane--thread',
    { 'aria-label': '消息', dataset: { pane: 'thread', active: 'false' } },
    threadHead,
    threadScroll,
    threadFoot,
  );

  root.className = 'app';
  fill(root, rail, listPane, threadPane);

  /* ---------------- 行为 ---------------- */

  const api = {
    /** 会话/联系人等视图切换 */
    setView(view) {
      for (const [name, btn] of navButtons) {
        btn.setAttribute('aria-current', name === view ? 'true' : 'false');
      }
    },

    /** 窄屏在两栏之间切换 */
    setMobilePane(pane) {
      state.mobilePane = pane;
      listPane.dataset.active = pane === 'list' ? 'true' : 'false';
      threadPane.dataset.active = pane === 'thread' ? 'true' : 'false';
    },

    setUnread(n) {
      const badge = navButtons.get('chats')?._badge;
      if (!badge) return;
      badge.hidden = n <= 0;
      badge.textContent = n > 99 ? '99+' : String(n);
    },

    refreshMe() {
      fill(meAvatarHost, avatarNode(state.me, { size: 'md', showPresence: false }));
    },

    listHead,
    listBody,
    threadHead,
    threadScroll,
    threadFoot,
    listPane,
    threadPane,
    rail,
  };

  // 窄屏点列表项进入消息栏的逻辑在 list.js 里调 setMobilePane

  const offs = [
    bus.on('conversations:changed', () => api.setUnread(unreadTotal())),
    bus.on('presence:changed', () => api.refreshMe()),
  ];

  return {
    ...api,
    /** 会话过期后重新登录会重建外壳，旧的总线订阅必须在这儿断掉 */
    destroy() {
      offs.forEach((off) => off?.());
    },
  };
}
