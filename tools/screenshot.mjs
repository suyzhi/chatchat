/**
 * 界面截图。
 *
 * 起一个临时服务 + 无头浏览器，把几个关键界面截成 PNG，
 * 用来肉眼检查排版、间距、对比度这些静态检查看不出来的东西。
 *
 * 用法： node tools/screenshot.mjs [输出目录]
 */
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(process.argv[2] || join(ROOT, 'screenshots'));

const EDGE = [
  process.env.BROWSER_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/microsoft-edge',
  '/usr/bin/google-chrome',
]
  .filter(Boolean)
  .find((p) => existsSync(p));

if (!EDGE) {
  console.error('找不到 Edge / Chrome。');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanup = [];

/* ---------------- 临时服务 ---------------- */

async function startServer() {
  const dataDir = await mkdtemp(join(tmpdir(), 'vellum-shot-data-'));
  const port = 8700 + Math.floor(Math.random() * 200);
  const child = spawn(process.execPath, [join(ROOT, 'src', 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, SESSION_SECRET: 'shot' },
    stdio: 'ignore',
  });
  cleanup.push(async () => {
    child.kill();
    await sleep(300);
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i += 1) {
    await sleep(200);
    try {
      if ((await fetch(`${base}/healthz`)).ok) return base;
    } catch {
      /* 等 */
    }
  }
  throw new Error('临时服务起不来');
}

/* ---------------- 造数据 ---------------- */

function makeClient(base) {
  const jar = new Map();
  return async (method, path, body) => {
    const headers = {};
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(';');
      const eq = pair.indexOf('=');
      jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    const t = await res.text();
    try {
      return JSON.parse(t);
    } catch {
      return t;
    }
  };
}

async function seed(base) {
  const host = makeClient(base);
  const pal = makeClient(base);
  const mia = makeClient(base);

  await host('POST', '/api/auth/register', {
    username: 'lin',
    displayName: '林',
    password: 'screenshot-password',
  });
  await host('PATCH', '/api/auth/me', { about: '在山里，信号不好' });
  const invite = (await host('GET', '/api/admin/invite')).code;

  await pal('POST', '/api/auth/register', {
    username: 'zhou',
    displayName: '周',
    password: 'screenshot-password',
    inviteCode: invite,
  });
  await mia('POST', '/api/auth/register', {
    username: 'mia',
    displayName: '米娅',
    password: 'screenshot-password',
    inviteCode: invite,
  });

  const users = (await host('GET', '/api/users')).users;
  const zhouId = users.find((u) => u.username === 'zhou').id;
  const miaId = users.find((u) => u.username === 'mia').id;

  await host('POST', '/api/contacts', { userId: zhouId, alias: '老周' });

  const dm = await host('POST', '/api/conversations', { type: 'dm', userId: zhouId });
  const cid = dm.conversation.id;

  const conv = async (who, body) => who('POST', `/api/conversations/${cid}/messages`, { kind: 'text', body });

  await conv(pal, '周末那个展你去不去');
  await conv(host, '去，几点的票');
  await conv(pal, '下午两点，我多买了一张');
  await conv(host, '那我请你吃饭\n展馆旁边有家面馆不错');
  await conv(pal, '成交');
  await conv(mia, '我也想去');
  // 放一条长消息，检查换行与最大宽度
  await conv(host, '顺便说一下，新服务器已经搬好了，图片和语音都走分块上传，几个 G 的文件也不会断。之前那个方案传到一半就超时，现在没这个问题了。');

  // 群
  const group = await host('POST', '/api/conversations', {
    type: 'group',
    title: '周末看展',
    memberIds: [zhouId, miaId],
  });
  const gid = group.conversation.id;
  await pal('POST', `/api/conversations/${gid}/messages`, { kind: 'text', body: '两点在地铁口集合' });
  await mia('POST', `/api/conversations/${gid}/messages`, { kind: 'text', body: '收到' });

  // 再开一个和米娅的私聊，让列表里有多个未读
  const dm2 = await host('POST', '/api/conversations', { type: 'dm', userId: miaId });
  await mia('POST', `/api/conversations/${dm2.conversation.id}/messages`, { kind: 'text', body: '在吗' });

  const session = (await host('GET', '/api/auth/me')) && null;
  void session;

  // 单独取一次 cookie
  const jarClient = makeClient(base);
  await jarClient('POST', '/api/auth/login', { username: 'lin', password: 'screenshot-password' });
  return { cid, gid, login: jarClient, dm2: dm2.conversation.id };
}

/* ---------------- CDP ---------------- */

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== undefined && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(m.error.message));
        else resolve(m.result);
      } else if (m.method) {
        for (const fn of this.listeners) fn(m);
      }
    });
  }
  on(fn) {
    this.listeners.push(fn);
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时 ${method}`));
        }
      }, 20000);
    });
  }
}

/* ---------------- 主流程 ---------------- */

async function main() {
  await mkdir(OUT, { recursive: true });
  const base = await startServer();
  const seeded = await seed(base);

  // 拿到登录 cookie
  const jar = new Map();
  const loginRes = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'lin', password: 'screenshot-password' }),
  });
  for (const c of loginRes.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(';');
    const eq = pair.indexOf('=');
    jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  const session = jar.get('vellum_session');

  const profile = await mkdtemp(join(tmpdir(), 'vellum-shot-'));
  cleanup.push(() => rm(profile, { recursive: true, force: true }).catch(() => {}));
  const port = 9500 + Math.floor(Math.random() * 200);
  const browser = spawn(
    EDGE,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-scrollbars',
      '--force-device-scale-factor=2',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  cleanup.push(async () => {
    browser.kill();
    await sleep(300);
  });

  let wsUrl = null;
  for (let i = 0; i < 40; i += 1) {
    await sleep(250);
    try {
      wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl;
      if (wsUrl) break;
    } catch {
      /* 等 */
    }
  }
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => {
    ws.addEventListener('open', r, { once: true });
    ws.addEventListener('error', j, { once: true });
  });
  const cdp = new CDP(ws);
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const S = (m, p) => cdp.send(m, p, sessionId);
  await S('Page.enable');
  await S('Network.enable');
  await S('Runtime.enable');

  const host = new URL(base).hostname;
  const setCookie = (value) =>
    S('Network.setCookie', { name: 'vellum_session', value, domain: host, path: '/', httpOnly: true });

  async function shot(name, { width, height, url = base + '/', before, wait = 2200, full = false }) {
    await S('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 2,
      mobile: width < 700,
    });
    await S('Page.navigate', { url: 'about:blank' });
    await S('Page.navigate', { url });
    await sleep(wait);
    if (before) {
      // Runtime.evaluate 不支持顶层 await，必须包成 async IIFE 再 awaitPromise
      await S('Runtime.evaluate', {
        expression: `(async () => { ${before} })()`,
        awaitPromise: true,
        returnByValue: true,
      });
      await sleep(1200);
    }
    const { data } = await S('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: full,
    });
    const file = join(OUT, `${name}.png`);
    await writeFile(file, Buffer.from(data, 'base64'));
    console.log(`  ${name}.png  ${width}x${height}`);
  }

  console.log(`截图输出目录： ${OUT}\n`);

  // 1. 登录页（未登录）
  await S('Network.clearBrowserCookies');
  await shot('01-登录页', { width: 1440, height: 900, url: base + '/' });

  // 2. 注册页
  await shot('02-注册页', {
    width: 1440,
    height: 900,
    url: base + '/',
    before: `[...document.querySelectorAll('.auth__switch button')][0].click()`,
  });

  // 剩下的都需要登录
  await setCookie(session);

  // 3. 主界面（会话列表 + 消息）
  await shot('03-主界面', {
    width: 1440,
    height: 900,
    url: base + '/',
    before: `document.querySelector('.listitem[data-conv-id="${seeded.cid}"]').click()`,
  });

  // 4. 群聊
  await shot('04-群聊', {
    width: 1440,
    height: 900,
    url: base + '/',
    before: `document.querySelector('.listitem[data-conv-id="${seeded.gid}"]').click()`,
  });

  // 5. 联系人
  await shot('05-联系人', {
    width: 1440,
    height: 900,
    url: base + '/',
    before: `document.querySelectorAll('.rail__nav .rail-btn')[1].click()`,
  });

  // 6. 表情面板 + 输入中
  await shot('06-表情面板', {
    width: 1440,
    height: 900,
    url: base + '/',
    before: `
      document.querySelector('.listitem[data-conv-id="${seeded.cid}"]').click();
      await new Promise(r => setTimeout(r, 900));
      const ta = document.querySelector('.composer__input');
      ta.value = '那我把地址发你';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelectorAll('.composer__tools .icon-btn')[1].click();
    `,
  });

  // 7. 搜索视图
  await shot('07-搜索', {
    width: 1440,
    height: 900,
    url: base + '/',
    before: `
      document.querySelectorAll('.rail__nav .rail-btn')[2].click();
      await new Promise(r => setTimeout(r, 300));
      const s = document.querySelector('.searchbar input');
      s.value = '展';
      s.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 900));
    `,
  });

  // 8. 设置（管理员，能看到邀请码）
  await shot('08-设置', {
    width: 1440,
    height: 900,
    url: base + '/',
    before: `
      document.querySelector('.rail__foot .rail-btn').click();
      await new Promise(r => setTimeout(r, 900));
    `,
  });

  // 9. 手机端：列表
  await shot('09-手机-列表', { width: 390, height: 844, url: base + '/' });

  // 10. 手机端：会话
  await shot('10-手机-会话', {
    width: 390,
    height: 844,
    url: base + '/',
    before: `document.querySelector('.listitem[data-conv-id="${seeded.cid}"]').click()`,
  });

  ws.close();
  await sleep(200);
  for (const fn of cleanup.reverse()) await fn().catch(() => {});
  process.exit(0);
}

main().catch(async (err) => {
  console.error('截图失败：', err);
  for (const fn of cleanup.reverse()) {
    try {
      await fn();
    } catch {
      /* 忽略 */
    }
  }
  process.exit(1);
});
