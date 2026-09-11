/**
 * 入口。负责：取配置、判断登录态、装配各个视图、接通 WebSocket、处理通知。
 */
import { h, fill, toast } from './dom.js';
import { icon } from './icon.js';
import { api, setUnauthorizedHandler } from './api.js';
import {
  state,
  bus,
  reset,
  upsertConversation,
  removeConversation,
  upsertUser,
  setPresence,
  noteTyping,
  upsertMessage,
  setMessages,
  messagesOf,
  conversations,
  unreadTotal,
  pruneTyping,
} from './store.js';
import { connect as connectSocket, disconnect as disconnectSocket, kick } from './socket.js';
import { renderAuth } from './views/auth.js';
import { renderShell } from './views/shell.js';
import { createList } from './views/list.js';
import { createThread } from './views/thread.js';
import { createComposer } from './views/composer.js';
import {
  openNewChat,
  openNewGroup,
  openProfile,
  openAddContact,
  openGroupInfo,
  openSettings,
} from './views/dialogs.js';
import { openMenu, confirmDialog } from './overlays.js';
import { isNearBottom } from './dom.js';

const rootEl = document.getElementById('app');
const bootEl = document.getElementById('boot');
const dropEl = document.getElementById('dropzone');

/* 运行时引用，登录后才会被赋值 */
let shell = null;
let list = null;
let thread = null;
let composer = null;
let notificationsAsked = false;

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

async function main() {
  let config;
  try {
    config = await api.serverConfig();
  } catch (err) {
    showFatal('连不上服务器', err.message || '请确认服务已经启动，然后刷新页面。');
    return;
  }
  state.config = config;
  document.title = config.siteName || 'Vellum';

  setUnauthorizedHandler(() => {
    // 会话失效：直接回登录页，并给出原因
    if (state.me) {
      teardown();
      reset();
      showAuth({ reason: '登录状态已过期，请重新登录' });
    }
  });

  try {
    const res = await api.me();
    state.me = res.user;
  } catch {
    state.me = null;
  }

  if (!state.me) {
    showAuth({});
    return;
  }
  await bootApp();
}

function showFatal(title, detail) {
  bootEl.hidden = true;
  rootEl.hidden = false;
  rootEl.className = '';
  fill(
    rootEl,
    h(
      'div.empty',
      { style: { minHeight: '100dvh' } },
      h('div.empty__mark', icon('warning-circle', { size: 22 })),
      h('p.empty__title', title),
      h('p.empty__text', detail),
      h(
        'div.empty__actions',
        h('button.btn.btn--primary', { type: 'button', text: '重新加载', onClick: () => location.reload() }),
      ),
    ),
  );
}

function showAuth({ reason } = {}) {
  bootEl.hidden = true;
  rootEl.hidden = false;
  renderAuth(rootEl, {
    config: state.config,
    onDone: async (user, opts) => {
      state.me = user;
      await bootApp();
      if (opts?.becameAdmin) {
        toast('你是这台服务器上的第一个账号，已获得管理员身份', { timeout: 6000, tone: 'ok' });
      }
      if (reason) toast(reason);
    },
  });
  if (reason) toast(reason);
}

/* ------------------------------------------------------------------ */
/* 装配应用                                                            */
/* ------------------------------------------------------------------ */

async function bootApp() {
  rootEl.hidden = false;
  bootEl.hidden = true;
  rootEl.className = '';

  // 先并行拉基础数据，首屏尽量快
  const [usersRes, contactsRes, convRes] = await Promise.all([
    api.users().catch(() => ({ users: [] })),
    api.contacts().catch(() => ({ contacts: [] })),
    api.conversations().catch(() => ({ conversations: [] })),
  ]);

  state.users.clear();
  for (const u of usersRes.users) {
    if (u.isSelf) continue;
    state.users.set(u.id, u);
  }
  state.contacts.clear();
  for (const c of contactsRes.contacts) {
    state.contacts.set(c.id, c);
    const existing = state.users.get(c.id);
    if (existing) state.users.set(c.id, { ...existing, ...c });
  }
  state.conversations.clear();
  for (const c of convRes.conversations) upsertConversation(c);

  // 我的资料也用最新的
  const meFresh = state.users.get(state.me.id);
  void meFresh;

  shell = renderShell(rootEl, {
    onNavigate: (view) => navigate(view),
    onOpenMe: (anchor) => openMeMenu(anchor),
    onOpenSettings: () => openSettings(dialogCtx),
  });

  list = createList(shell.listHead, shell.listBody, {
    onOpenConversation: (id) => openConversation(id),
    onOpenUser: (user) => openContactMenu(user),
    onNewChat: () => openNewChat(dialogCtx),
    onNewGroup: () => openNewGroup(dialogCtx),
    onAddContact: () => openAddContact(),
    onJumpToMessage: (cid, mid) => {
      navigate('chats');
      thread.jumpToMessage(cid, mid);
    },
  });

  // 搜索栏插在列表头下面
  shell.listPane.insertBefore(list.searchBar, shell.listBody);

  thread = createThread(shell.threadHead, shell.threadScroll, shell.threadFoot, {
    onBack: () => {
      shell.setMobilePane('list');
    },
    onOpenProfile: () => {
      const conv = state.conversations.get(thread.activeId);
      if (!conv) return;
      if (conv.type === 'group') openGroupInfo(conv.id, dialogCtx);
      else if (conv.peer) openProfile(conv.peer.id, dialogCtx);
    },
    onOpenMembers: () => {
      const conv = state.conversations.get(thread.activeId);
      if (conv) openGroupInfo(conv.id, dialogCtx);
    },
    onStartChatWith: (userId) => startChatWith(userId),
    onReply: (msg) => composer.setReply(msg),
    onCancelReply: () => composer.cancelReply(),
    onEdit: (msg) => composer.startEdit(msg),
  });

  composer = createComposer(shell.threadFoot, {
    getConversationId: () => thread.activeId,
    onTyping: () => thread.notifyTyping(),
    onSent: () => {},
  });

  list.setView('chats');
  navigate('chats');
  shell.refreshMe();
  shell.setUnread(unreadTotal());

  wireRealtime();
  wireNotifications();
  wireGlobalDrop();
  wireKeyboard();
  connectSocket();

  // 没有会话时给一个明确的引导，而不是空白
  if (conversations().length === 0 && state.users.size === 0) {
    setTimeout(() => {
      toast('站点上目前只有你一个人。把地址发给朋友，让他们注册。', { timeout: 7000 });
    }, 800);
  }

  if (window.innerWidth <= 832) shell.setMobilePane('list');
}

function teardown() {
  disconnectSocket();
  thread?.destroy();
  composer?.destroy();
  list?.destroy();
  shell = null;
  list = null;
  thread = null;
  composer = null;
}

/* ------------------------------------------------------------------ */
/* 导航                                                                */
/* ------------------------------------------------------------------ */

function navigate(view) {
  state.view = view;
  shell.setView(view);
  list.setView(view === 'search' ? 'search' : view);
  if (view !== 'chats' && window.innerWidth <= 832) shell.setMobilePane('list');
}

async function openConversation(id) {
  const conv = state.conversations.get(id);
  if (!conv) return;
  navigate('chats');
  shell.setMobilePane('thread');
  composer.reset();
  await thread.open(id);
  composer.focus();
}

async function startChatWith(userId) {
  try {
    const res = await api.createConversation({ type: 'dm', userId });
    upsertConversation(res.conversation);
    openConversation(res.conversation.id);
  } catch (err) {
    toast(err.message, { tone: 'error' });
  }
}

/* ------------------------------------------------------------------ */
/* 菜单                                                                */
/* ------------------------------------------------------------------ */

function openMeMenu(anchor) {
  openMenu({
    anchor,
    align: 'left',
    items: [
      { header: true, label: state.me?.displayName || '' },
      {
        label: '我的资料',
        icon: 'user-circle',
        onClick: () => openProfile(state.me.id, dialogCtx),
      },
      { label: '设置', icon: 'gear-six', onClick: () => openSettings(dialogCtx) },
      { separator: true },
      {
        label: '退出登录',
        icon: 'sign-out',
        danger: true,
        onClick: async () => {
          const ok = await confirmDialog({
            title: '退出登录？',
            desc: '下次需要重新输入密码。',
            confirmLabel: '退出',
            danger: true,
          });
          if (ok) dialogCtx.logout();
        },
      },
    ],
  });
}

/** 联系人列表里点一个人：先给菜单，再决定是聊天还是看资料 */
function openContactMenu(user) {
  const anchor = { getBoundingClientRect: () => ({ bottom: 0, top: 0, left: 0, right: 0 }) };
  void anchor;
  // 直接开资料卡更直接：里面已经有「发消息」按钮
  openProfile(user.id, dialogCtx);
}

const dialogCtx = {
  openConversation,
  async logout({ all = false } = {}) {
    try {
      if (all) await api.logoutAll();
      else await api.logout();
    } catch {
      /* 服务端记不住也无所谓，本地状态照样清 */
    }
    teardown();
    reset();
    location.reload();
  },
};

/* ------------------------------------------------------------------ */
/* 实时事件                                                            */
/* ------------------------------------------------------------------ */

function wireRealtime() {
  bus.on('connection:changed', (status) => {
    state.connection = status;
    renderConnBar();
  });

  bus.on('auth:expired', () => {
    teardown();
    reset();
    showAuth({ reason: '登录状态已过期，请重新登录' });
  });

  bus.on('ws:ready', ({ online }) => {
    state.presence.clear();
    for (const id of online || []) setPresence(id, true);
    bus.emit('conversations:changed');
  });

  bus.on('ws:presence', ({ userId, online }) => setPresence(userId, online));

  bus.on('ws:message:new', ({ message, conversation }) => {
    if (conversation) upsertConversation(conversation);
    upsertMessage(message);
    onIncoming(message);
  });

  bus.on('ws:message:update', (data) => {
    if (data.message) upsertMessage(data.message);
    if (data.conversation) upsertConversation(data.conversation);
  });

  bus.on('ws:conversation:new', async (data) => {
    // 定向推送里带了完整数据
    const conv = data?.data ?? data?.conversation?.data ?? data;
    if (conv?.id) {
      upsertConversation(conv);
      if (conv.type === 'group' && conv.createdAt && Date.now() - conv.createdAt < 10_000) {
        toast(`你被拉进了「${conv.title}」`, { tone: 'ok' });
      }
      return;
    }
    // 广播形态只有 id，主动拉一次
    const id = data?.id ?? data?.conversation?.id;
    if (id) {
      try {
        const res = await api.conversation(id);
        upsertConversation(res.conversation);
      } catch {
        /* 可能已经被移出了 */
      }
    }
  });

  bus.on('ws:conversation:update', ({ conversation }) => {
    if (!conversation) return;
    // 详情接口返回的是针对某个人的视图，这里只取自己的那一份
    if (conversation.peer || conversation.myRole) upsertConversation(conversation);
  });

  bus.on('ws:conversation:removed', ({ conversationId }) => {
    removeConversation(conversationId);
    if (thread?.activeId === conversationId) thread.close();
    toast('你已不在这个会话里了');
  });

  bus.on('ws:read', ({ conversationId, userId, messageId }) => {
    const conv = state.conversations.get(conversationId);
    if (!conv) return;
    if (conv.type === 'dm') {
      conv.peerReadMessageId = Math.max(conv.peerReadMessageId || 0, messageId);
      bus.emit('conversation:changed', conv);
      // 已读回执要就地更新消息上的状态
      for (const m of messagesOf(conversationId)) {
        if (m.sender?.id === state.me?.id && m.id <= messageId) bus.emit('message:changed', m);
      }
    } else {
      void userId;
    }
  });

  bus.on('ws:typing', ({ conversationId, userId, until }) => {
    noteTyping(conversationId, userId, until);
  });

  bus.on('ws:sync', ({ conversations: list_, online }) => {
    for (const c of list_ || []) upsertConversation(c);
    state.presence.clear();
    for (const id of online || []) setPresence(id, true);
    bus.emit('conversations:changed');
  });

  bus.on('conversation:new', (conv) => {
    if (conv) upsertConversation(conv);
  });

  bus.on('contacts:changed', () => {
    if (list.view === 'contacts') list.refresh();
  });

  bus.on('me:changed', () => {
    shell?.refreshMe();
  });

  // 输入中的状态会过期：定期清理并重绘，否则「正在输入」会一直挂着
  setInterval(() => {
    pruneTyping();
    if (thread?.activeId) thread.refresh();
  }, 2000);
}

/** 连接中断时在顶部挂一条提示 */
let connBarEl = null;
function renderConnBar() {
  const pane = shell?.threadPane;
  if (!pane) return;
  if (state.connection === 'online') {
    connBarEl?.remove();
    connBarEl = null;
    return;
  }
  if (!connBarEl) {
    connBarEl = h(
      'div.connbar',
      icon('wifi-slash', { size: 15 }),
      h('span', { style: { flex: '1' } }, '连接已断开，正在重连。消息会保留在输入框里。'),
      h('button.btn.btn--outline', { type: 'button', text: '立刻重试', onClick: () => kick() }),
    );
    pane.insertBefore(connBarEl, pane.children[1] ?? null);
  }
}

/* ------------------------------------------------------------------ */
/* 通知                                                                */
/* ------------------------------------------------------------------ */

function wireNotifications() {
  // 有任意一次交互后再申请通知权限，不然很多浏览器会直接拒绝
  const ask = () => {
    if (notificationsAsked) return;
    notificationsAsked = true;
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }
    window.removeEventListener('pointerdown', ask);
    window.removeEventListener('keydown', ask);
  };
  window.addEventListener('pointerdown', ask, { once: true });
  window.addEventListener('keydown', ask, { once: true });

  bus.on('presence:changed', updateTitle);
  bus.on('conversations:changed', updateTitle);
  bus.on('message:added', updateTitle);
}

function onIncoming(message) {
  if (message.sender?.id === state.me?.id) return;
  const conv = state.conversations.get(message.conversationId);
  if (!conv) return;

  const isActive = thread?.activeId === message.conversationId;
  const visible = document.visibilityState === 'visible';
  const atBottom = thread ? isNearBottom(thread.scrollHost, 200) : false;

  if (isActive && visible && atBottom) {
    // 已经在看，不用打扰
    return;
  }

  if (conv.muted) return;

  // 系统通知
  if (
    'Notification' in window &&
    Notification.permission === 'granted' &&
    (!visible || !isActive)
  ) {
    const body =
      message.kind === 'text'
        ? message.body.slice(0, 120)
        : message.kind === 'image'
          ? '[图片]'
          : message.kind === 'audio'
            ? '[语音]'
            : message.kind === 'video'
              ? '[视频]'
              : `[文件] ${message.file?.name || ''}`;
    try {
      const n = new Notification(
        conv.type === 'group' ? `${conv.title} · ${message.sender?.displayName || ''}` : conv.title,
        { body, tag: `vellum-${conv.id}`, icon: '/favicon.svg', silent: false },
      );
      n.onclick = () => {
        window.focus();
        openConversation(conv.id);
        n.close();
      };
    } catch {
      /* 某些浏览器在非安全上下文下会抛错 */
    }
  }

  // 页面不可见时在标题上提示
  updateTitle();
}

let lastTitle = '';
function updateTitle() {
  const base = state.config?.siteName || 'Vellum';
  const n = unreadTotal();
  const next = n > 0 ? `(${n > 99 ? '99+' : n}) ${base}` : base;
  if (next !== lastTitle) {
    lastTitle = next;
    document.title = next;
  }
  shell?.setUnread(n);
}

/* ------------------------------------------------------------------ */
/* 拖拽上传                                                            */
/* ------------------------------------------------------------------ */

function wireGlobalDrop() {
  let depth = 0;
  const show = () => {
    if (thread?.activeId) dropEl.hidden = false;
  };
  const hide = () => {
    depth = 0;
    dropEl.hidden = true;
  };

  window.addEventListener('dragenter', (e) => {
    if (![...(e.dataTransfer?.types ?? [])].includes('Files')) return;
    e.preventDefault();
    depth += 1;
    show();
  });
  window.addEventListener('dragover', (e) => {
    if (![...(e.dataTransfer?.types ?? [])].includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', () => {
    depth -= 1;
    if (depth <= 0) hide();
  });
  window.addEventListener('drop', (e) => {
    if (![...(e.dataTransfer?.types ?? [])].includes('Files')) return;
    e.preventDefault();
    hide();
    if (!thread?.activeId) {
      toast('先打开一个会话，再拖文件进来', { tone: 'error' });
      return;
    }
    const box = shell.threadFoot.querySelector('.composer__box');
    box?.dispatchEvent(
      Object.assign(new DragEvent('drop', { bubbles: true, cancelable: true }), {
        dataTransfer: e.dataTransfer,
      }),
    );
  });
}

/* ------------------------------------------------------------------ */
/* 键盘快捷键                                                          */
/* ------------------------------------------------------------------ */

function wireKeyboard() {
  window.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;

    // Ctrl/Cmd + K 打开搜索
    if (mod && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      navigate('search');
      return;
    }

    // Esc 在窄屏从会话返回列表
    if (e.key === 'Escape' && window.innerWidth <= 832 && state.mobilePane === 'thread') {
      const typing = document.activeElement?.tagName === 'TEXTAREA';
      if (!typing) shell.setMobilePane('list');
      return;
    }

    // 在消息流里按 Esc 关闭当前会话
    if (e.key === 'Escape' && state.mobilePane === 'thread' && document.activeElement === document.body) {
      shell.setMobilePane('list');
    }
  });

  // 页面重新可见 / 网络恢复时立刻重连
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      kick();
      if (thread?.activeId) thread.refresh();
    }
  });
  window.addEventListener('online', () => kick());
  window.addEventListener('offline', () => bus.emit('connection:changed', 'offline'));

  // 移动端软键盘弹出时把消息流滚到底
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => {
      if (thread?.activeId && isNearBottom(thread.scrollHost, 400)) {
        thread.scrollHost.scrollTop = thread.scrollHost.scrollHeight;
      }
    });
  }
}

/* ------------------------------------------------------------------ */

main().catch((err) => {
  console.error('[启动失败]', err);
  showFatal('启动失败', err.message || '打开浏览器控制台看看详细错误。');
});

// 便于排查问题，但只暴露只读引用
if (typeof window !== 'undefined') {
  window.__vellum = { state, bus, api };
}
