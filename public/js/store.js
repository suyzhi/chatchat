/**
 * 应用状态。
 *
 * 只有一个 store，视图订阅自己关心的事件。消息按会话缓存，
 * 每个会话只保留最近若干条，翻历史时再往前追加，内存不会无限涨。
 */

const MAX_CACHED_MESSAGES = 400;

/** 极简事件总线 */
function createEmitter() {
  const handlers = new Map();
  return {
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(fn);
      return () => handlers.get(event)?.delete(fn);
    },
    emit(event, payload) {
      for (const fn of handlers.get(event) ?? []) {
        try {
          fn(payload);
        } catch (err) {
          console.error(`[store] 处理 ${event} 时出错`, err);
        }
      }
      for (const fn of handlers.get('*') ?? []) {
        try {
          fn({ event, payload });
        } catch (err) {
          console.error('[store] 通配监听出错', err);
        }
      }
    },
  };
}

export const bus = createEmitter();

export const state = {
  /** 服务端公开配置 */
  config: null,
  /** 当前登录用户 */
  me: null,
  /** 全部注册用户：id -> user */
  users: new Map(),
  /** 我的联系人：id -> contact */
  contacts: new Map(),
  /** 会话：id -> conversation */
  conversations: new Map(),
  /** 消息缓存：conversationId -> Message[]（按 id 升序） */
  messages: new Map(),
  /** 每个会话是否还有更早的消息 */
  hasMore: new Map(),
  /** 在线用户 id */
  presence: new Set(),
  /** 正在输入：conversationId -> Map<userId, untilTs> */
  typing: new Map(),
  /** 各会话的上传任务：conversationId -> UploadTask[] */
  uploads: new Map(),

  /** 界面状态 */
  view: 'chats', // chats | contacts | search | settings
  activeId: null,
  /** 移动端当前显示哪一栏 */
  mobilePane: 'list', // list | thread
  connection: 'connecting', // connecting | online | offline
  /** 私聊列表里被隐藏但可以再打开的（暂时不用，留接口） */
  filter: '',
};

/* ------------------------------------------------------------------ */
/* 会话                                                            */
/* ------------------------------------------------------------------ */

export function upsertConversation(conv) {
  if (!conv || !conv.id) return null;
  const prev = state.conversations.get(conv.id);
  // 已读位置只增不减，避免乱序的推送把未读数顶回来
  const merged = prev
    ? {
        ...prev,
        ...conv,
        lastReadMessageId: Math.max(prev.lastReadMessageId || 0, conv.lastReadMessageId || 0),
        peerReadMessageId: Math.max(prev.peerReadMessageId || 0, conv.peerReadMessageId || 0),
      }
    : { ...conv };
  state.conversations.set(conv.id, merged);
  bus.emit('conversation:changed', merged);
  bus.emit('conversations:changed');
  return merged;
}

export function removeConversation(id) {
  state.conversations.delete(id);
  state.messages.delete(id);
  state.hasMore.delete(id);
  if (state.activeId === id) state.activeId = null;
  bus.emit('conversation:removed', id);
  bus.emit('conversations:changed');
}

export const conversations = () =>
  [...state.conversations.values()]
    .filter((c) => !c.hidden)
    .sort((a, b) => (b.lastMessage?.createdAt || b.updatedAt) - (a.lastMessage?.createdAt || a.updatedAt));

/* ------------------------------------------------------------------ */
/* 消息                                                            */
/* ------------------------------------------------------------------ */

export function messagesOf(conversationId) {
  return state.messages.get(conversationId) ?? [];
}

/**
 * 插入或替换一条消息，保持按 id 升序且不重复。
 * @returns {{message: object, added: boolean}}
 */
export function upsertMessage(msg, { atStart = false } = {}) {
  if (!msg || !msg.id) return { message: null, added: false };
  const cid = msg.conversationId;
  let list = state.messages.get(cid);
  if (!list) {
    list = [];
    state.messages.set(cid, list);
  }

  const idx = list.findIndex((m) => m.id === msg.id);
  if (idx >= 0) {
    list[idx] = { ...list[idx], ...msg };
    bus.emit('message:changed', list[idx]);
    return { message: list[idx], added: false };
  }

  if (atStart || list.length === 0 || msg.id > list[list.length - 1].id) {
    list.push(msg);
  } else if (msg.id < list[0].id) {
    list.unshift(msg);
  } else {
    // 中间的补洞，二分找位置
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].id < msg.id) lo = mid + 1;
      else hi = mid;
    }
    list.splice(lo, 0, msg);
  }

  if (list.length > MAX_CACHED_MESSAGES) {
    list.splice(0, list.length - MAX_CACHED_MESSAGES);
  }

  bus.emit('message:added', { message: msg, conversationId: cid });
  return { message: msg, added: true };
}

export function setMessages(conversationId, list, hasMore) {
  const sorted = [...list].sort((a, b) => a.id - b.id);
  state.messages.set(
    conversationId,
    sorted.length > MAX_CACHED_MESSAGES ? sorted.slice(-MAX_CACHED_MESSAGES) : sorted,
  );
  if (hasMore !== undefined) state.hasMore.set(conversationId, !!hasMore);
  bus.emit('messages:reset', { conversationId });
}

/* ------------------------------------------------------------------ */
/* 用户与在线状态                                                   */
/* ------------------------------------------------------------------ */

export function upsertUser(user) {
  if (!user?.id) return;
  const prev = state.users.get(user.id);
  state.users.set(user.id, prev ? { ...prev, ...user } : user);
}

export const userName = (id) => {
  if (id === state.me?.id) return '我';
  const u = state.users.get(id);
  const c = state.contacts.get(id);
  return c?.alias || u?.displayName || '未知用户';
};

export function setPresence(userId, online) {
  const had = state.presence.has(userId);
  if (online) state.presence.add(userId);
  else state.presence.delete(userId);
  if (had !== online) bus.emit('presence:changed', { userId, online });
  const u = state.users.get(userId);
  if (u) u.online = online;
  for (const c of state.conversations.values()) {
    if (c.peer && c.peer.id === userId) c.peer.online = online;
  }
}

/* ------------------------------------------------------------------ */
/* 正在输入                                                         */
/* ------------------------------------------------------------------ */

export function noteTyping(conversationId, userId, until) {
  let map = state.typing.get(conversationId);
  if (!map) {
    map = new Map();
    state.typing.set(conversationId, map);
  }
  map.set(userId, until);
  bus.emit('typing:changed', { conversationId });
}

/** 正在输入的人（已排除自己和已过期的） */
export function typingUsers(conversationId) {
  const map = state.typing.get(conversationId);
  if (!map) return [];
  const t = Date.now();
  const out = [];
  for (const [uid, until] of map) {
    if (until > t && uid !== state.me?.id) out.push(uid);
  }
  return out;
}

export const isTyping = (conversationId) => typingUsers(conversationId).length > 0;

/**
 * 清掉过期的「正在输入」记录，并通知受影响的会话重绘。
 * 必须周期性调用，否则对方停止输入后这里会永远显示「正在输入」。
 * @returns {number} 清理掉的条数
 */
export function pruneTyping() {
  const t = Date.now();
  const touched = new Set();
  let removed = 0;
  for (const [cid, map] of state.typing) {
    for (const [uid, until] of map) {
      if (until <= t) {
        map.delete(uid);
        touched.add(cid);
        removed += 1;
      }
    }
    if (map.size === 0) state.typing.delete(cid);
  }
  for (const cid of touched) bus.emit('typing:changed', { conversationId: cid });
  return removed;
}

/* ------------------------------------------------------------------ */
/* 未读                                                            */
/* ------------------------------------------------------------------ */

export const unreadTotal = () =>
  [...state.conversations.values()]
    .filter((c) => !c.hidden && !c.muted)
    .reduce((sum, c) => sum + (c.unread || 0), 0);

/* ------------------------------------------------------------------ */
/* 上传任务                                                         */
/* ------------------------------------------------------------------ */

export function trackUpload(conversationId, task) {
  let list = state.uploads.get(conversationId);
  if (!list) {
    list = [];
    state.uploads.set(conversationId, list);
  }
  list.push(task);
  bus.emit('upload:changed', { conversationId });
  return task;
}

export function updateUpload(conversationId, task) {
  const list = state.uploads.get(conversationId);
  if (!list) return;
  const i = list.findIndex((t) => t.id === task.id);
  if (i >= 0) list[i] = task;
  bus.emit('upload:changed', { conversationId });
}

export function dropUpload(conversationId, taskId) {
  const list = state.uploads.get(conversationId);
  if (!list) return;
  const i = list.findIndex((t) => t.id === taskId);
  if (i >= 0) list.splice(i, 1);
  bus.emit('upload:changed', { conversationId });
}

export const uploadsOf = (conversationId) => state.uploads.get(conversationId) ?? [];

/** 退出登录时清空一切 */
export function reset() {
  state.me = null;
  state.users.clear();
  state.contacts.clear();
  state.conversations.clear();
  state.messages.clear();
  state.hasMore.clear();
  state.presence.clear();
  state.typing.clear();
  state.uploads.clear();
  state.activeId = null;
  state.view = 'chats';
  state.mobilePane = 'list';
  bus.emit('reset');
}
