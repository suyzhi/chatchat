/**
 * HTTP 客户端。所有请求都带 cookie，401 会统一触发登出流程。
 */

export class ApiError extends Error {
  constructor(status, message, code, payload) {
    super(message);
    this.status = status;
    this.code = code;
    this.payload = payload;
  }
}

/** 401 时的回调，由 app.js 注册 */
let onUnauthorized = null;
export const setUnauthorizedHandler = (fn) => {
  onUnauthorized = fn;
};

async function request(method, path, { body, signal, raw, headers } = {}) {
  const init = { method, credentials: 'same-origin', signal, headers: { ...headers } };

  if (body !== undefined && !raw) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  } else if (raw) {
    init.body = raw;
  }

  let res;
  try {
    res = await fetch(path, init);
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError(0, '网络连接不上，检查一下网络', 'network');
  }

  if (res.status === 204) return null;

  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const payload = isJson ? await res.json().catch(() => null) : null;

  if (!res.ok) {
    const message = payload?.error || `请求失败（${res.status}）`;
    const err = new ApiError(res.status, message, payload?.code || 'error', payload);
    if (res.status === 401 && onUnauthorized) onUnauthorized(err);
    throw err;
  }
  return payload;
}

export const api = {
  get: (path, opts) => request('GET', path, opts),
  post: (path, body, opts) => request('POST', path, { ...opts, body }),
  patch: (path, body, opts) => request('PATCH', path, { ...opts, body }),
  del: (path, opts) => request('DELETE', path, opts),

  /* ---------------- 具体端点，集中在这里，改接口只改一处 ---------------- */

  serverConfig: () => request('GET', '/api/auth/config'),

  register: (data) => request('POST', '/api/auth/register', { body: data }),
  login: (data) => request('POST', '/api/auth/login', { body: data }),
  logout: () => request('POST', '/api/auth/logout'),
  logoutAll: () => request('POST', '/api/auth/logout-all'),
  me: () => request('GET', '/api/auth/me'),
  updateMe: (data) => request('PATCH', '/api/auth/me', body0(data)),
  changePassword: (data) => request('POST', '/api/auth/password', body0(data)),

  users: () => request('GET', '/api/users'),
  user: (id) => request('GET', `/api/users/${id}`),
  contacts: () => request('GET', '/api/contacts'),
  addContact: (data) => request('POST', '/api/contacts', body0(data)),
  updateContact: (id, data) => request('PATCH', `/api/contacts/${id}`, body0(data)),
  removeContact: (id) => request('DELETE', `/api/contacts/${id}`),

  conversations: () => request('GET', '/api/conversations'),
  conversation: (id) => request('GET', `/api/conversations/${id}`),
  createConversation: (data) => request('POST', '/api/conversations', body0(data)),
  updateConversation: (id, data) => request('PATCH', `/api/conversations/${id}`, body0(data)),
  addMembers: (id, userIds) => request('POST', `/api/conversations/${id}/members`, { body: { userIds } }),
  removeMember: (id, userId) => request('DELETE', `/api/conversations/${id}/members/${userId}`),
  leaveConversation: (id) => request('POST', `/api/conversations/${id}/leave`),
  markRead: (id, messageId) =>
    request('POST', `/api/conversations/${id}/read`, { body: messageId ? { messageId } : {} }),
  hideConversation: (id) => request('POST', `/api/conversations/${id}/hide`),
  muteConversation: (id, muted) => request('POST', `/api/conversations/${id}/mute`, { body: { muted } }),

  messages: (id, { before, after, limit } = {}) => {
    const q = new URLSearchParams();
    if (before) q.set('before', before);
    if (after) q.set('after', after);
    if (limit) q.set('limit', limit);
    const s = q.toString();
    return request('GET', `/api/conversations/${id}/messages${s ? `?${s}` : ''}`);
  },
  send: (conversationId, data) =>
    request('POST', `/api/conversations/${conversationId}/messages`, body0(data)),
  editMessage: (id, body) => request('PATCH', `/api/messages/${id}`, { body: { body } }),
  recallMessage: (id) => request('POST', `/api/messages/${id}/recall`),
  forwardMessage: (id, conversationIds) =>
    request('POST', `/api/messages/${id}/forward`, { body: { conversationIds } }),
  search: (q, conversationId) => {
    const p = new URLSearchParams({ q });
    if (conversationId) p.set('conversationId', conversationId);
    return request('GET', `/api/messages/search?${p}`);
  },
  unreadTotal: () => request('GET', '/api/unread'),

  uploadInit: (data) => request('POST', '/api/uploads/init', body0(data)),
  uploadStatus: (id) => request('GET', `/api/uploads/${id}`),
  uploadChunk: (id, index, blob, signal) =>
    request('PUT', `/api/uploads/${id}/chunk/${index}`, {
      raw: blob,
      signal,
      headers: { 'Content-Type': 'application/octet-stream' },
    }),
  uploadComplete: (id) => request('POST', `/api/uploads/${id}/complete`),
  uploadAbort: (id) => request('DELETE', `/api/uploads/${id}`),

  /* 管理员 */
  adminOverview: () => request('GET', '/api/admin/overview'),
  adminInvite: () => request('GET', '/api/admin/invite'),
  adminRotateInvite: () => request('POST', '/api/admin/invite/rotate'),
};

/** 小助手：让上面的箭头函数保持一行 */
function body0(data) {
  return { body: data };
}
