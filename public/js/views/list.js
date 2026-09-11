/**
 * 中间列表栏。三种视图共用这一栏：会话、联系人、搜索。
 */
import { h, fill, debounce, highlight } from '../dom.js';
import { icon } from '../icon.js';
import { api } from '../api.js';
import { state, bus, conversations, userName, isTyping } from '../store.js';
import { timeRelative, previewWithSender } from '../format.js';
import { avatarNode, paneHead, iconButton, emptyState, skeletonRows } from './parts.js';

/**
 * @param {HTMLElement} headHost
 * @param {HTMLElement} bodyHost
 * @param {{
 *   onOpenConversation: (id: number) => void,
 *   onOpenUser: (user: object) => void,
 *   onNewChat: () => void,
 *   onNewGroup: () => void,
 *   onAddContact: () => void,
 *   onJumpToMessage: (conversationId: number, messageId: number) => void,
 * }} handlers
 */
export function createList(headHost, bodyHost, handlers) {
  let view = 'chats';
  let query = '';
  let searchResults = null;
  let searchBusy = false;
  let searchToken = 0;

  const searchInput = h('input', {
    type: 'search',
    placeholder: '搜索消息内容',
    'aria-label': '搜索消息内容',
    autocomplete: 'off',
  });

  /* ---------------- 会话列表 ---------------- */

  function conversationRow(conv) {
    const last = conv.lastMessage;
    const isMine = last?.senderId === state.me?.id;
    const showSender = conv.type === 'group';
    const preview = last
      ? previewWithSender(last, {
          showSender,
          isMine,
          senderName: last.senderId ? userName(last.senderId) : '',
        })
      : conv.type === 'group'
        ? `${conv.memberCount} 位成员`
        : '还没有消息';

    const typing = isTyping(conv.id);

    return h(
      'button.listitem',
      {
        type: 'button',
        'aria-current': state.activeId === conv.id ? 'true' : 'false',
        dataset: { convId: String(conv.id) },
        onClick: () => handlers.onOpenConversation(conv.id),
      },
      conv.type === 'group'
        ? groupAvatar(conv)
        : avatarNode(conv.peer || { displayName: conv.title }, { showPresence: true }),
      h(
        'div.listitem__main',
        h(
          'div.listitem__row',
          h('span.listitem__name', conv.title),
          last ? h('span.listitem__time', timeRelative(last.createdAt)) : null,
        ),
        h(
          'div.listitem__preview',
          typing
            ? h(
                'span.typing',
                h('span.typing__dots', h('i'), h('i'), h('i')),
                h('span', conv.type === 'group' ? '有人正在输入' : '正在输入'),
              )
            : preview,
        ),
      ),
      h(
        'div.listitem__side',
        conv.unread > 0
          ? h('span.listitem__badge', conv.unread > 99 ? '99+' : String(conv.unread))
          : null,
        conv.muted && conv.unread > 0
          ? h('span.meta.listitem__muted', { style: { fontSize: '0.58rem' } }, '静音')
          : null,
      ),
    );
  }

  function groupAvatar(conv) {
    if (conv.avatarUrl) {
      return h(
        'span.avatar',
        { 'aria-hidden': 'true', title: conv.title },
        h('img', { src: conv.avatarUrl, alt: '', loading: 'lazy', decoding: 'async' }),
      );
    }
    // 没有群头像时用成员首字拼一个小网格，比一个通用群图标信息量大。
    // 列数按人数定，两个人才不会挤成竖着一条。
    const names = (conv.members || []).filter((m) => m.id !== state.me?.id).slice(0, 4);
    const cells = names.length ? names : [{ displayName: '#' }];
    const cols = cells.length === 1 ? 1 : 2;
    return h(
      'span.avatar',
      { 'aria-hidden': 'true', title: conv.title, style: { background: 'var(--paper)' } },
      h(
        'span',
        {
          style: {
            display: 'grid',
            gridTemplateColumns: `repeat(${cols}, 1fr)`,
            gap: '1px',
            width: '100%',
            height: '100%',
            padding: '3px',
            fontSize: cells.length <= 2 ? '0.7rem' : '0.6rem',
            lineHeight: '1',
            color: 'var(--ink-3)',
            textAlign: 'center',
          },
        },
        ...cells.map((m) => h('span', { style: { display: 'grid', placeItems: 'center' } }, (m.displayName || '#')[0])),
      ),
    );
  }

  function renderChats() {
    const list = conversations();
    if (list.length === 0) {
      return emptyState({
        mark: 'chats-circle',
        title: '还没有任何会话',
        text: '找个朋友开一个，或者拉几个人建个群。',
        actions: [
          h('button.btn.btn--primary', { type: 'button', text: '开始聊天', onClick: handlers.onNewChat }),
          h('button.btn.btn--outline', { type: 'button', text: '建个群', onClick: handlers.onNewGroup }),
        ],
      });
    }
    const visible = query
      ? list.filter((c) => c.title.toLowerCase().includes(query.toLowerCase()))
      : list;
    if (visible.length === 0) {
      return emptyState({
        mark: 'magnifying-glass',
        title: '没有匹配的会话',
        text: `没有名字里带「${query}」的会话。`,
      });
    }
    return h('div', visible.map(conversationRow));
  }

  /* ---------------- 联系人 ---------------- */

  function renderContacts() {
    const me = state.me;
    const all = [...state.users.values()].filter((u) => u.id !== me?.id);
    const contactIds = new Set(state.contacts.keys());
    const known = all.filter((u) => contactIds.has(u.id));
    const others = all.filter((u) => !contactIds.has(u.id));

    const row = (u) =>
      h(
        'button.listitem',
        {
          type: 'button',
          dataset: { userId: String(u.id) },
          onClick: () => handlers.onOpenUser(u),
        },
        avatarNode(u, { showPresence: true }),
        h(
          'div.listitem__main',
          h(
            'div.listitem__row',
            h('span.listitem__name', state.contacts.get(u.id)?.alias || u.displayName),
          ),
          h(
            'div.listitem__preview',
            u.online ? '在线' : '@' + u.username,
          ),
        ),
        h('div.listitem__side', icon('caret-right', { size: 14 })),
      );

    if (all.length === 0) {
      return emptyState({
        mark: 'address-book',
        title: '站点上还没有别人',
        text: '把地址发给你朋友，让他们注册之后就会出现在这里。',
      });
    }

    const filterFn = (u) =>
      !query ||
      u.displayName.toLowerCase().includes(query.toLowerCase()) ||
      u.username.toLowerCase().includes(query.toLowerCase()) ||
      (state.contacts.get(u.id)?.alias || '').toLowerCase().includes(query.toLowerCase());

    const knownFiltered = known.filter(filterFn);
    const othersFiltered = others.filter(filterFn);

    if (knownFiltered.length === 0 && othersFiltered.length === 0) {
      return emptyState({
        mark: 'magnifying-glass',
        title: '没有匹配的人',
        text: `没有人叫「${query}」。`,
      });
    }

    return h(
      'div',
      knownFiltered.length
        ? h(
            'div',
            h(
              'div.listgroup',
              h('span.meta', '联系人'),
              h('span.listgroup__count', String(knownFiltered.length)),
            ),
            ...knownFiltered.map(row),
          )
        : null,
      othersFiltered.length
        ? h(
            'div',
            h(
              'div.listgroup',
              h('span.meta', '站内其他人'),
              h('span.listgroup__count', String(othersFiltered.length)),
            ),
            ...othersFiltered.map(row),
          )
        : null,
    );
  }

  /* ---------------- 搜索 ---------------- */

  const runSearch = debounce(async (q) => {
    const token = ++searchToken;
    if (!q.trim()) {
      searchResults = null;
      searchBusy = false;
      renderBody();
      return;
    }
    searchBusy = true;
    renderBody();
    try {
      const res = await api.search(q.trim());
      if (token !== searchToken) return;
      searchResults = res.results;
    } catch (err) {
      if (token !== searchToken) return;
      searchResults = [];
      console.error('[搜索失败]', err);
    } finally {
      if (token === searchToken) {
        searchBusy = false;
        renderBody();
      }
    }
  }, 260);

  function renderSearch() {
    if (!query.trim()) {
      return emptyState({
        mark: 'magnifying-glass',
        title: '搜索所有会话',
        text: '输入关键词，会在你参与的全部会话里查找消息正文。',
      });
    }
    if (searchBusy) return skeletonRows(4);
    if (!searchResults || searchResults.length === 0) {
      return emptyState({
        mark: 'magnifying-glass',
        title: '没搜到',
        text: `没有包含「${query}」的消息。`,
      });
    }
    return h(
      'div',
      h('div.listgroup', h('span.meta', '结果'), h('span.listgroup__count', String(searchResults.length))),
      ...searchResults.map((r) => {
        const conv = state.conversations.get(r.conversationId);
        return h(
          'button.searchresult',
          {
            type: 'button',
            onClick: () => handlers.onJumpToMessage(r.conversationId, r.messageId),
          },
          h(
            'div.searchresult__top',
            h('span.searchresult__where', conv?.title || '会话'),
            h('span.meta', timeRelative(r.createdAt)),
          ),
          h(
            'div.searchresult__text',
            h('span', { style: { color: 'var(--ink-3)' } }, `${r.senderName}: `),
            highlight(r.body || '', query.trim()),
          ),
        );
      }),
    );
  }

  /* ---------------- 主渲染 ---------------- */

  function renderHead() {
    const actionHandlers = {
      chats: [
        iconButton('user-plus', { label: '新建私聊', onClick: handlers.onNewChat }),
        iconButton('users-three', { label: '新建群聊', onClick: handlers.onNewGroup }),
      ],
      contacts: [iconButton('user-plus', { label: '添加联系人', onClick: handlers.onAddContact })],
      search: [],
    }[view] || [];

    const subs = {
      chats: `${conversations().length} 个会话  ·  ${state.presence.size} 人在线`,
      contacts: `${state.contacts.size} 位联系人  ·  ${state.users.size - 1} 人可用`,
      search: '在你的全部会话里查找',
    };

    const titles = { chats: '会话', contacts: '联系人', search: '搜索' };

    fill(
      headHost,
      ...paneHead({ title: titles[view], sub: subs[view], actions: actionHandlers }),
    );
  }

  function renderBody() {
    if (view === 'chats') fill(bodyHost, renderChats());
    else if (view === 'contacts') fill(bodyHost, renderContacts());
    else fill(bodyHost, renderSearch());
  }

  function render() {
    renderHead();
    renderBody();
  }

  /* ---------------- 搜索栏 ---------------- */

  searchInput.addEventListener('input', () => {
    query = searchInput.value;
    if (view === 'search') runSearch(query);
    else renderBody();
  });

  const searchBar = h(
    'div.searchbar',
    h(
      'div.searchbar__wrap',
      icon('magnifying-glass', { size: 15 }),
      searchInput,
      h(
        'button.icon-btn.icon-btn--sm',
        {
          type: 'button',
          'aria-label': '清空搜索',
          hidden: !query,
          style: { position: 'absolute', right: '0.2rem' },
          onClick: () => {
            searchInput.value = '';
            query = '';
            searchResults = null;
            renderBody();
            searchInput.dispatchEvent(new Event('input'));
          },
        },
        icon('x', { size: 13 }),
      ),
    ),
  );

  /* ---------------- 订阅 ---------------- */

  const offs = [
    bus.on('conversations:changed', () => {
      if (view === 'chats' || view === 'contacts') render();
    }),
    bus.on('presence:changed', () => {
      if (view === 'chats' || view === 'contacts') render();
    }),
    bus.on('typing:changed', () => {
      if (view === 'chats') renderBody();
    }),
    bus.on('message:added', ({ conversationId }) => {
      // 只更新那一行，避免整个列表重排导致闪一下
      if (view !== 'chats') return;
      const conv = state.conversations.get(conversationId);
      if (!conv) return;
      const row = bodyHost.querySelector(`[data-conv-id="${conversationId}"]`);
      if (row && row.isConnected) row.replaceWith(conversationRow(conv));
      else renderBody();
    }),
  ];

  return {
    searchBar,
    setView(next, { focusSearch = false } = {}) {
      view = next;
      if (next !== 'search') {
        query = '';
        searchInput.value = '';
        searchResults = null;
      }
      render();
      if (focusSearch || next === 'search') {
        setTimeout(() => searchInput.focus({ preventScroll: true }), 30);
      }
    },
    refresh: render,
    get view() {
      return view;
    },
    destroy() {
      offs.forEach((off) => off?.());
    },
  };
}
