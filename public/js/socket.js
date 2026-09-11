/**
 * WebSocket 客户端。
 *
 * 断线自动重连，退避从 1 秒涨到最多 30 秒，并加抖动避免多标签页同时重连。
 * 重连成功后发一次 sync 把错过的更新补齐。页面重新可见时也会立刻探一次。
 */
import { bus } from './store.js';

const MAX_BACKOFF = 30_000;

let ws = null;
let attempts = 0;
let timer = null;
let manuallyClosed = false;
let heartbeat = null;

function url() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

function setConnection(status) {
  bus.emit('connection:changed', status);
}

function scheduleReconnect() {
  if (manuallyClosed) return;
  clearTimeout(timer);
  const base = Math.min(MAX_BACKOFF, 1000 * 2 ** attempts);
  const delay = base * (0.7 + Math.random() * 0.6); // 抖动
  attempts += 1;
  setConnection('offline');
  timer = setTimeout(connect, delay);
}

function startHeartbeat() {
  clearInterval(heartbeat);
  heartbeat = setInterval(() => send({ t: 'ping' }), 25_000);
}

export function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  manuallyClosed = false;
  setConnection(attempts === 0 ? 'connecting' : 'offline');

  try {
    ws = new WebSocket(url());
  } catch {
    scheduleReconnect();
    return;
  }

  ws.addEventListener('open', () => {
    attempts = 0;
    setConnection('online');
    startHeartbeat();
    bus.emit('socket:open');
    // 补齐断线期间错过的变动
    send({ t: 'sync' });
  });

  ws.addEventListener('message', (ev) => {
    let data;
    try {
      data = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (!data || typeof data.t !== 'string') return;
    if (data.t === 'pong') return;

    // conversation:new 有两种形状：定向的（带 data）和广播的（只给 id）
    if (data.t === 'conversation:new' && data.conversation?.data) {
      bus.emit('conversation:new', data.conversation.data);
      return;
    }
    bus.emit(`ws:${data.t}`, data);
  });

  ws.addEventListener('close', (ev) => {
    clearInterval(heartbeat);
    ws = null;
    bus.emit('socket:close', ev);
    // 4401 表示会话失效，重连也没用，交给上层去登录
    if (ev.code === 4401) {
      setConnection('offline');
      bus.emit('auth:expired');
      return;
    }
    scheduleReconnect();
  });

  ws.addEventListener('error', () => {
    // close 事件随后一定会触发，重连逻辑放在那里
  });
}

export function send(payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

export function disconnect() {
  manuallyClosed = true;
  clearTimeout(timer);
  clearInterval(heartbeat);
  attempts = 0;
  try {
    ws?.close(1000, 'client closing');
  } catch {
    /* 无所谓 */
  }
  ws = null;
  setConnection('offline');
}

/** 页面重新可见 / 网络恢复时立刻重试，不用等退避 */
export function kick() {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  attempts = 0;
  clearTimeout(timer);
  connect();
}

/** 让服务端知道我已经读到哪了（比走 HTTP 省一个请求） */
export const sendRead = (conversationId, messageId) =>
  send({ t: 'read', conversationId, messageId });

export const sendTyping = (conversationId) => send({ t: 'typing', conversationId });
