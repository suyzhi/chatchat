/**
 * Vellum 服务端入口。
 *
 * 一个进程同时提供 HTTP API、静态前端和 WebSocket 推送。
 * 部署形态就是「一个 Node 进程 + 一个数据目录」，没有额外的中间件依赖。
 */
import http from 'node:http';
import { join } from 'node:path';
import express from 'express';

import { config, ensureDirs, describeConfig } from './config.js';
import { db, closeDb } from './db.js';
import { attachUser, pruneSessions, requireAuth } from './auth.js';
import { wrap, errorHandler, securityHeaders, contentSecurityPolicy, notFound } from './http.js';
import { attachRealtime } from './realtime.js';
import { currentInvite } from './invite.js';

import { authRouter } from './routes/auth.js';
import { adminRouter } from './routes/admin.js';
import { usersRouter } from './routes/users.js';
import { conversationsRouter } from './routes/conversations.js';
import { messagesRouter } from './routes/messages.js';
import { uploadsRouter, sweepStaleUploads } from './routes/uploads.js';
import { filesRouter } from './routes/files.js';

ensureDirs();

const app = express();

// 反代后面要拿到真实 IP，否则限流会把所有人算成同一个来源
app.set('trust proxy', config.trustProxy);
app.disable('x-powered-by');

app.use(securityHeaders);
app.use(contentSecurityPolicy);

/** 容器健康检查用，不需要鉴权，也不碰数据库 */
app.get('/healthz', (_req, res) => res.json({ ok: true, at: Date.now() }));

/* ------------------------------------------------------------------ */
/* 静态资源                                                            */
/* ------------------------------------------------------------------ */

/**
 * 字体自托管：只发 latin / latin-ext 子集（约 82KB），中文字形交给系统字体。
 * 不引 CDN，私有部署也不该依赖外网。
 */
const FONT_DIRS = {
  geist: join(config.root, 'node_modules', '@fontsource-variable', 'geist', 'files'),
  'geist-mono': join(config.root, 'node_modules', '@fontsource-variable', 'geist-mono', 'files'),
};
for (const [name, dir] of Object.entries(FONT_DIRS)) {
  app.use(
    `/vendor/fonts/${name}`,
    express.static(dir, {
      immutable: true,
      maxAge: '365d',
      index: false,
      dotfiles: 'deny',
      setHeaders(res) {
        res.setHeader('Access-Control-Allow-Origin', '*');
      },
    }),
  );
}

/* ------------------------------------------------------------------ */
/* API                                                                 */
/* ------------------------------------------------------------------ */

// 除分块上传外，JSON 请求体上限 1MB（长文本消息绰绰有余）
app.use('/api', express.json({ limit: '1mb' }));
app.use('/api', attachUser);

// 公开接口
app.use('/api/auth', authRouter);

/**
 * 受保护的接口统一挂在一个子路由上。
 * 这样 requireAuth 每个请求只跑一次，而不是每进一个 router 就跑一次；
 * 也让「已登录但路径不存在」能正常落到 404，而不是被某一层的鉴权拦成 401。
 */
const protectedApi = express.Router();
protectedApi.use(requireAuth);
// adminRouter 的管理员校验挂在 router 级，所以必须按路径挂载，
// 否则它会拦下所有受保护请求，普通用户连自己的会话列表都读不到。
protectedApi.use('/admin', adminRouter);
protectedApi.use(usersRouter);
protectedApi.use(conversationsRouter);
protectedApi.use(messagesRouter);
protectedApi.use(uploadsRouter);
protectedApi.use(filesRouter);
app.use('/api', protectedApi);

app.use('/api', (_req, _res, next) => next(notFound('接口不存在')));

/* ------------------------------------------------------------------ */
/* 前端                                                                */
/* ------------------------------------------------------------------ */

const PUBLIC_DIR = join(config.root, 'public');

app.use(
  express.static(PUBLIC_DIR, {
    index: 'index.html',
    dotfiles: 'deny',
    setHeaders(res, filePath) {
      // 零构建的原生模块，改了就要立刻生效，所以不缓存 HTML 和 JS
      if (/\.(?:html|js|css)$/.test(filePath)) {
        res.setHeader('Cache-Control', 'no-cache');
      } else {
        res.setHeader('Cache-Control', 'public, max-age=86400');
      }
    },
  }),
);

// 单页应用：非 API 的路径统统交给 index.html，前端自己路由
app.get(
  '*',
  wrap(async (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/ws')) return next();
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(join(PUBLIC_DIR, 'index.html'));
  }),
);

app.use(errorHandler);

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

const server = http.createServer(app);

// 反向代理下要关掉 Node 自己的请求超时，否则大文件上传到一半会被掐断
server.requestTimeout = 0;
server.headersTimeout = 65_000;
server.keepAliveTimeout = 65_000;

const realtime = attachRealtime(server);

server.listen(config.port, config.host, () => {
  const removed = pruneSessions();
  if (removed) console.log(`[启动] 清理了 ${removed} 条过期会话`);
  console.log(`\n  ${config.siteName} 已启动\n`);
  console.log(`  ${describeConfig()}\n`);

  // 邀请码是部署时最需要看到的信息，单独打一块，别混在配置摘要里
  if (config.allowRegister) {
    const invite = currentInvite();
    const noUsers = db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0;
    if (noUsers) {
      console.log('  还没有任何账号：打开下面的地址注册，第一个账号自动成为管理员，不需要邀请码。');
    } else {
      console.log(`  邀请码        ${invite.code}   ${invite.source === 'env' ? '(来自 INVITE_CODE)' : '(自动生成，可在设置里更换)'}`);
      console.log('                把地址和这串邀请码一起发给朋友，他们就能注册。');
    }
    console.log('');
  }

  console.log(`  本地地址      http://127.0.0.1:${config.port}\n`);
});

// 周期性维护：过期会话、没传完的临时分块
const maintenance = setInterval(
  () => {
    try {
      const n = pruneSessions();
      if (n) console.log(`[维护] 清理 ${n} 条过期会话`);
    } catch (err) {
      console.error('[维护] 清理会话失败', err);
    }
    sweepStaleUploads().catch((err) => console.error('[维护] 清理临时上传失败', err));
  },
  6 * 3600_000,
);
maintenance.unref();

/* ------------------------------------------------------------------ */
/* 优雅退出                                                            */
/* ------------------------------------------------------------------ */

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[退出] 收到 ${signal}，正在关闭…`);

  const force = setTimeout(() => {
    console.warn('[退出] 超时，强制结束');
    process.exit(1);
  }, 8000);
  force.unref();

  await realtime.close().catch(() => {});
  await new Promise((done) => server.close(done));
  closeDb();
  clearTimeout(force);
  console.log('[退出] 完成');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (err) => {
  console.error('[未处理的 Promise 拒绝]', err);
});
process.on('uncaughtException', (err) => {
  console.error('[未捕获异常]', err);
  // 数据库是同步的，未捕获异常通常意味着状态不可信，交给容器重启
  shutdown('uncaughtException');
});

export { app, server };
