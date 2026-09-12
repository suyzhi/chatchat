/**
 * WebSocket 实时层。
 *
 * 职责划分：写操作（发消息、已读、上传）全部走 HTTP，好处是错误能正常返回、
 * 能带请求体、能被反代正常处理、断线也不丢。WebSocket 只负责「推」：
 * 新消息、编辑、撤回、正在输入、在线状态。
 * 这样即使 WebSocket 断了，整个应用除了实时性之外仍然完全可用。
 */
import { WebSocketServer } from 'ws';
import { db, memberIds, isMember, now } from './db.js';
import { userFromToken, readSessionToken } from './auth.js';
import { addSocket, removeSocket, sendToUser, sendToUsers, onlineUserIds } from './presence.js';
import { conversationSummary } from './conv.js';
import { rateLimiter } from './util.js';

const HEARTBEAT_MS = 30_000;

/*
 * 「正在输入」的限流。
 *
 * 客户端实际是走 WebSocket 发 typing 的（socket.js 的 sendTyping），
 * HTTP 那条 /typing 只是另一条路径。所以这里也得限，两边用同一个额度，
 * 否则一条 100 帧的循环就能给会话里每个人推 100 次重绘。
 */
const typingLimit = rateLimiter({ windowMs: 10_000, max: 40 });

/** 把在线状态广播给所有人（用户量很小，全量广播最省事也最不容易错） */
function broadcastPresence(userId, online) {
  const targets = db
    .prepare('SELECT id FROM users WHERE id != ?')
    .all(userId)
    .map((r) => r.id);
  sendToUsers(targets, { t: 'presence', userId, online, at: now() });
}

/**
 * @param {import('http').Server} server
 * @returns {{ close: () => Promise<void> }}
 */
export function attachRealtime(server) {
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    // 单条信令都很小，1MB 已经远远够用，防止有人用超大帧打内存
    maxPayload: 1024 * 1024,
    perMessageDeflate: false, // 信令太小，压缩反而费 CPU
  });

  wss.on('connection', (ws, req) => {
    const token = readSessionToken(req);
    const user = userFromToken(token);

    if (!user) {
      ws.send(JSON.stringify({ t: 'error', code: 'unauthenticated', error: '未登录' }));
      ws.close(4401, 'unauthenticated');
      return;
    }

    ws.userId = user.id;
    ws.isAlive = true;
    const cameOnline = addSocket(user.id, ws);

    ws.send(
      JSON.stringify({
        t: 'ready',
        userId: user.id,
        now: now(),
        online: onlineUserIds().filter((id) => id !== user.id),
      }),
    );
    if (cameOnline) broadcastPresence(user.id, true);

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return; // 垃圾数据直接忽略，不值得断线
      }
      if (!msg || typeof msg.t !== 'string') return;

      switch (msg.t) {
        case 'ping':
          ws.send(JSON.stringify({ t: 'pong', at: now() }));
          break;

        case 'typing': {
          if (!typingLimit(String(ws.userId))) return;
          const cid = Number(msg.conversationId);
          if (!Number.isInteger(cid) || cid <= 0) return;
          // 每次 typing 事件都重新校验成员身份，不信任连接建立时的状态
          if (!isMember(cid, ws.userId)) return;
          const others = memberIds(cid).filter((id) => id !== ws.userId);
          sendToUsers(others, {
            t: 'typing',
            conversationId: cid,
            userId: ws.userId,
            name: user.display_name,
            until: now() + 5000,
          });
          break;
        }

        case 'read': {
          const cid = Number(msg.conversationId);
          const mid = Number(msg.messageId);
          if (!Number.isInteger(cid) || !Number.isInteger(mid)) return;
          if (!isMember(cid, ws.userId)) return;
          const cur = db
            .prepare(
              'SELECT last_read_message_id FROM conversation_members WHERE conversation_id = ? AND user_id = ?',
            )
            .get(cid, ws.userId)?.last_read_message_id;
          if (cur === undefined || mid <= cur) return;
          // 和 HTTP 版一样钳位：只认这个会话里真实存在的消息 id，
          // 否则别的会话（甚至还不存在）的 id 会把未读数直接算错。
          const maxId = db
            .prepare('SELECT COALESCE(MAX(id), 0) AS n FROM messages WHERE conversation_id = ?')
            .get(cid).n;
          if (mid > maxId) return;
          db.prepare(
            'UPDATE conversation_members SET last_read_message_id = ? WHERE conversation_id = ? AND user_id = ?',
          ).run(mid, cid, ws.userId);
          sendToUsers(
            memberIds(cid).filter((id) => id !== ws.userId),
            { t: 'read', conversationId: cid, userId: ws.userId, messageId: mid, at: now() },
          );
          break;
        }

        case 'sync': {
          // 断线重连后客户端可以要一份会话摘要，补齐错过的更新
          const rows = db
            .prepare(
              `SELECT c.* FROM conversations c
                 JOIN conversation_members cm ON cm.conversation_id = c.id
                WHERE cm.user_id = ?
                ORDER BY COALESCE(c.last_message_at, c.created_at) DESC`,
            )
            .all(ws.userId);
          ws.send(
            JSON.stringify({
              t: 'sync',
              conversations: rows.map((c) => conversationSummary(c, ws.userId)).filter((c) => !c.hidden),
              online: onlineUserIds().filter((id) => id !== ws.userId),
            }),
          );
          break;
        }

        default:
          break;
      }
    });

    const cleanup = () => {
      const wentOffline = removeSocket(user.id, ws);
      if (wentOffline) {
        broadcastPresence(user.id, false);
        db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(now(), user.id);
      }
    };
    ws.on('close', cleanup);
    ws.on('error', cleanup);
  });

  // 心跳：干掉半开连接（手机切后台、网络断了但没发 FIN），否则会永远显示在线
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }
  }, HEARTBEAT_MS);

  wss.on('close', () => clearInterval(heartbeat));

  return {
    wss,
    /** 复用给 HTTP 层，让接口写完数据后能主动推 */
    notify: sendToUser,
    close: () =>
      new Promise((resolveDone) => {
        clearInterval(heartbeat);
        for (const ws of wss.clients) {
          try {
            ws.close(1001, 'server shutting down');
          } catch {
            ws.terminate();
          }
        }
        wss.close(() => resolveDone());
      }),
  };
}
