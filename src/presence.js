/**
 * 在线状态。单进程部署，内存里维护 userId -> Set<WebSocket> 就够了。
 * 单独成模块是为了让 serialize.js 和 realtime.js 都能读它而不互相 import。
 */

/** @type {Map<number, Set<import('ws').WebSocket>>} */
const sockets = new Map();

export function addSocket(userId, ws) {
  let set = sockets.get(userId);
  if (!set) {
    set = new Set();
    sockets.set(userId, set);
  }
  set.add(ws);
  return set.size === 1; // true 表示刚刚上线
}

export function removeSocket(userId, ws) {
  const set = sockets.get(userId);
  if (!set) return false;
  set.delete(ws);
  if (set.size === 0) {
    sockets.delete(userId);
    return true; // true 表示完全离线
  }
  return false;
}

export const isOnline = (userId) => sockets.has(userId);

export function onlineUserIds() {
  return [...sockets.keys()];
}

/** 向某个用户的全部标签页推送 */
export function sendToUser(userId, payload) {
  const set = sockets.get(userId);
  if (!set || set.size === 0) return 0;
  const text = JSON.stringify(payload);
  let n = 0;
  for (const ws of set) {
    // 1 === WebSocket.OPEN，不 import ws 也能判断
    if (ws.readyState === 1) {
      try {
        ws.send(text);
        n += 1;
      } catch {
        /* 发送失败就跳过，close 事件会负责清理 */
      }
    }
  }
  return n;
}

/** 向一组用户推送，自动去重 */
export function sendToUsers(userIds, payload) {
  const seen = new Set();
  let n = 0;
  for (const id of userIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    n += sendToUser(id, payload);
  }
  return n;
}

/** 某个用户当前打开的标签页数量 */
export const socketCount = (userId) => sockets.get(userId)?.size ?? 0;

export const onlineSnapshot = () => onlineUserIds();
