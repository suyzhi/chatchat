/**
 * 可复用的小组件。头像、面板标题、空状态、骨架屏。
 * 消息气泡在 thread.js 里，因为它跟消息数据耦合更紧。
 */
import { h, fill } from '../dom.js';
import { icon } from '../icon.js';
import { initials } from '../format.js';

/**
 * 头像。没有图片时用名字首字，背景保持中性灰，不随机上色。
 *
 * 注意 h() 的简写规则：'div.avatar' 里的 div 才是标签名，只写 'avatar'
 * 会被当成自定义标签创建，样式全部失效。
 * @param {{displayName?: string, username?: string, avatarUrl?: string|null, online?: boolean, id?: number}|null} user
 * @param {{size?: 'sm'|'md'|'lg'|'xl', showPresence?: boolean}} [opts]
 */
export function avatarNode(user, opts = {}) {
  const { size = 'md', showPresence = true } = opts;
  const name = user?.displayName || user?.username || '?';
  const sizeClass =
    size === 'sm' ? '.avatar--sm' : size === 'lg' ? '.avatar--lg' : size === 'xl' ? '.avatar--xl' : '';

  const node = h(
    `div.avatar${sizeClass}`,
    { 'aria-hidden': 'true', title: name },
    user?.avatarUrl
      ? h('img', { src: user.avatarUrl, alt: '', loading: 'lazy', decoding: 'async' })
      : h('span', initials(name)),
  );

  if (showPresence && user) {
    node.appendChild(
      h(`span.presence${user.online ? '.presence--on' : ''}`, {
        title: user.online ? '在线' : '离线',
      }),
    );
  }
  return node;
}

/** 面板标题栏 */
export function paneHead({ title, sub, actions = [], leading = null }) {
  return [
    leading,
    h('div.pane__head-main', h('h1.pane__title', title), sub ? h('p.pane__sub', sub) : null),
    actions.length ? h('div.pane__head-actions', actions) : null,
  ];
}

/** 图标按钮 */
export function iconButton(name, { label, onClick, tone = '', size = 18, disabled = false } = {}) {
  return h(
    `button.icon-btn${tone ? `.${tone}` : ''}`,
    { type: 'button', 'aria-label': label, title: label, onClick, disabled },
    icon(name, { size }),
  );
}

/** 空状态。永远给出下一步该做什么。 */
export function emptyState({ mark = 'chats-circle', title, text, actions = [] }) {
  return h(
    'div.empty',
    h('div.empty__mark', icon(mark, { size: 22 })),
    h('p.empty__title', title),
    text ? h('p.empty__text', text) : null,
    actions.length ? h('div.empty__actions', actions) : null,
  );
}

/** 骨架屏：形状照着真实列表条目，不用转圈 */
export function skeletonRows(count = 6) {
  return h(
    'div',
    { 'aria-hidden': 'true' },
    Array.from({ length: count }, () =>
      h(
        'div.skeleton-row',
        h('div.skeleton', { style: { width: '2.25rem', height: '2.25rem', borderRadius: 'var(--r-round)' } }),
        h(
          'div.skeleton-row__lines',
          h('div.skeleton', { style: { width: '38%', height: '0.75rem' } }),
          h('div.skeleton', { style: { width: '72%', height: '0.65rem' } }),
        ),
      ),
    ),
  );
}

/** 上传进度条 */
export function progressBar(ratio) {
  return h('div.upbar', h('div.upbar__fill', { style: { width: `${Math.round(ratio * 100)}%` } }));
}

export function setProgress(bar, ratio) {
  const fillEl = bar.querySelector('.upbar__fill');
  if (fillEl) fillEl.style.width = `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`;
}

/** 小标签 */
export function badge(text, tone = '') {
  return h(`span.listitem__badge${tone ? `.${tone}` : ''}`, String(text));
}
