/**
 * 浏览器端到端检查。
 *
 * 用无头 Edge + DevTools 协议把前端真正跑一遍：注入会话 cookie、打开应用、
 * 点进会话、发消息、切视图，并把控制台里的报错全部收集回来。
 *
 * 之所以需要它：ESM 导入错误、DOM API 用错、事件绑定漏了，这些静态检查
 * 看不出来，只有真浏览器能暴露。
 *
 * 默认行为：自己拉起一个独立的临时服务实例（临时数据目录 + 独立端口），
 * 所以可以反复运行，不会污染开发用的数据库。
 *
 * 用法：
 *   node tools/browser-check.mjs                  自己起服务
 *   node tools/browser-check.mjs --external <url> 打一个已经在跑的服务
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const externalIdx = process.argv.indexOf('--external');
const EXTERNAL = externalIdx >= 0 ? process.argv[externalIdx + 1] : null;
let BASE = EXTERNAL || '';

const EDGE_CANDIDATES = [
  process.env.BROWSER_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/microsoft-edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

const EDGE = EDGE_CANDIDATES.find((p) => existsSync(p));
if (!EDGE) {
  console.error('找不到 Edge / Chrome，跳过浏览器检查。');
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    failures.push(`${name}${detail ? ` <- ${detail}` : ''}`);
    console.log(`  FAIL ${name}${detail ? `  <- ${detail}` : ''}`);
  }
}

/* ------------------------------------------------------------------ */
/* 起一个独立的临时服务                                                 */
/* ------------------------------------------------------------------ */

const cleanup = [];

async function startServer() {
  const dataDir = await mkdtemp(join(tmpdir(), 'vellum-check-data-'));
  const port = 8477 + Math.floor(Math.random() * 200);
  const child = spawn(process.execPath, [join(ROOT, 'src', 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      SESSION_SECRET: 'browser-check-secret',
      INVITE_CODE: '',
    },
    stdio: 'ignore',
  });
  cleanup.push(async () => {
    child.kill();
    await sleep(400);
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  });

  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i += 1) {
    await sleep(200);
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.ok) return base;
    } catch {
      /* 还没起来 */
    }
  }
  throw new Error('临时服务没能在 12 秒内启动');
}

/* ------------------------------------------------------------------ */
/* 造数据：注册、建会话、发几条消息                                      */
/* ------------------------------------------------------------------ */

/**
 * 一个身份一个 cookie 罐。
 * 注意：注册接口会给新用户下发会话 cookie，如果共用同一个罐子，
 * 注册第二个人就会把第一个人的身份顶掉。
 */
function makeClient() {
  const jar = new Map();
  return {
    async req(method, path, body) {
      const headers = {};
      if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
      if (body !== undefined) headers['content-type'] = 'application/json';
      const res = await fetch(BASE + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      for (const c of res.headers.getSetCookie?.() ?? []) {
        const [pair] = c.split(';');
        const eq = pair.indexOf('=');
        const k = pair.slice(0, eq).trim();
        const v = pair.slice(eq + 1).trim();
        if (v === '') jar.delete(k);
        else jar.set(k, v);
      }
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
      return { status: res.status, data };
    },
    session: () => jar.get('vellum_session'),
  };
}

async function seed() {
  const stamp = Date.now().toString(36);
  const host = makeClient(); // 主用户，浏览器里用的就是这个身份
  const peer = makeClient(); // 朋友

  const meReg = await host.req('POST', '/api/auth/register', {
    username: `ui_${stamp}`,
    displayName: '界面测试',
    password: 'browser-check-password',
  });
  if (meReg.status !== 201) {
    throw new Error(
      `注册主用户失败: ${JSON.stringify(meReg.data)}\n` +
        '  打外部服务时需要对方是一个还没有任何用户的干净实例。',
    );
  }

  const invite = (await host.req('GET', '/api/admin/invite')).data.code;
  if (!invite) throw new Error('没能取到邀请码');

  const peerReg = await peer.req('POST', '/api/auth/register', {
    username: `pal_${stamp}`,
    displayName: '朋友一号',
    password: 'browser-check-password',
    inviteCode: invite,
  });
  if (peerReg.status !== 201) {
    throw new Error(`注册第二个用户失败: ${JSON.stringify(peerReg.data)}（邀请码 ${invite}）`);
  }
  const peerId = peerReg.data.user.id;

  const dm = await host.req('POST', '/api/conversations', { type: 'dm', userId: peerId });
  if (!dm.data?.conversation) throw new Error(`创建私聊失败: ${JSON.stringify(dm.data)}`);
  const convId = dm.data.conversation.id;

  await host.req('POST', `/api/conversations/${convId}/messages`, {
    kind: 'text',
    body: '这是主用户发的第一句话',
  });
  await peer.req('POST', `/api/conversations/${convId}/messages`, {
    kind: 'text',
    body: '这是朋友回复的一句话',
  });
  await host.req('POST', `/api/conversations/${convId}/messages`, {
    kind: 'text',
    body: '换行测试\n第二行内容',
  });

  // 再建一个群，验证群头像和成员数渲染
  const group = await host.req('POST', '/api/conversations', {
    type: 'group',
    title: '界面测试群',
    memberIds: [peerId],
  });
  if (!group.data?.conversation) throw new Error(`建群失败: ${JSON.stringify(group.data)}`);

  const session = host.session();
  if (!session) throw new Error('没能拿到会话 cookie');
  return { session, convId, groupId: group.data.conversation.id, stamp, invite };
}

/* ------------------------------------------------------------------ */
/* 极简 CDP 客户端                                                     */
/* ------------------------------------------------------------------ */

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data ?? '')})`));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.listeners) fn(msg);
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
          reject(new Error(`CDP 超时: ${method}`));
        }
      }, 20000);
    });
  }
}

/* ------------------------------------------------------------------ */

async function main() {
  if (!BASE) BASE = await startServer();
  const seeded = await seed();
  console.log(`测试目标 ${BASE}（会话 #${seeded.convId}，群 #${seeded.groupId}）\n`);

  const profile = await mkdtemp(join(tmpdir(), 'vellum-browser-'));
  cleanup.push(() => rm(profile, { recursive: true, force: true }).catch(() => {}));
  const debugPort = 9333 + Math.floor(Math.random() * 200);
  const child = spawn(
    EDGE,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-features=Translate,MediaRouter',
      '--mute-audio',
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  cleanup.push(async () => {
    child.kill();
    await sleep(300);
  });

  let browserWs = null;
  for (let i = 0; i < 40; i += 1) {
    await sleep(250);
    try {
      const res = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
      const info = await res.json();
      browserWs = info.webSocketDebuggerUrl;
      if (browserWs) break;
    } catch {
      /* 还没起来 */
    }
  }
  if (!browserWs) throw new Error('浏览器没能在 10 秒内启动调试端口');

  const ws = new WebSocket(browserWs);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  const cdp = new CDP(ws);

  const consoleErrors = [];
  const consoleWarns = [];
  const pageErrors = [];
  const failedRequests = [];

  cdp.on((msg) => {
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = (msg.params.args || [])
        .map((a) => a.value ?? a.description ?? a.unserializableValue ?? '')
        .join(' ');
      if (msg.params.type === 'error') consoleErrors.push(text);
      else if (msg.params.type === 'warning') consoleWarns.push(text);
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      pageErrors.push(d.exception?.description || d.text);
    }
    if (msg.method === 'Log.entryAdded') {
      const e = msg.params.entry;
      if (e.level === 'error') consoleErrors.push(`${e.source}: ${e.text}`);
    }
    if (msg.method === 'Network.loadingFailed') {
      failedRequests.push(`${msg.params.type} ${msg.params.errorText}`);
    }
  });

  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });

  const S = (m, p) => cdp.send(m, p, sessionId);
  await S('Runtime.enable');
  await S('Log.enable');
  await S('Page.enable');
  await S('Network.enable');
  // 无头窗口默认只有 800x488，会误触发窄屏布局，让布局判断失去意义。
  // 固定成一个正常的桌面视口，结果才可复现。
  await S('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });

  const url = new URL(BASE);
  await S('Network.setCookie', {
    name: 'vellum_session',
    value: seeded.session,
    domain: url.hostname,
    path: '/',
    httpOnly: true,
  });

  const host = new URL(BASE).hostname;
  const setCookie = (value) =>
    S('Network.setCookie', { name: 'vellum_session', value, domain: host, path: '/', httpOnly: true });

  /** 在页面里求值。放在最前面，后面的小节都要用。 */
  const evaluate = async (expression) => {
    const res = await S('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
    }
    return res.result.value;
  };

  /* ---------------- 未登录的登录页 ---------------- */

  console.log('\n0. 未登录时的登录页');
  {
    await S('Network.clearBrowserCookies');
    await S('Page.navigate', { url: BASE + '/' });
    await sleep(2200);
    const login = await evaluate(`(() => {
      const head = document.querySelector('.auth__headline')?.textContent.trim();
      const sub = document.querySelector('.auth__sub')?.textContent.trim();
      const side = document.querySelector('.auth__side')?.getBoundingClientRect();
      const headline = document.querySelector('.auth__headline')?.getBoundingClientRect();
      const mark = document.querySelector('.auth__wordmark')?.getBoundingClientRect();
      const facts = document.querySelector('.auth__facts')?.getBoundingClientRect();
      const pwd = document.querySelector('input[type=password]');
      return {
        hasAuth: !!document.querySelector('.auth'),
        head, sub,
        gapUnderWordmark: Math.round((headline?.top ?? 0) - (mark?.bottom ?? 0)),
        formInFirstScreen: (document.querySelector('.auth__form')?.getBoundingClientRect().bottom ?? 1e9) < window.innerHeight,
        factsInView: (facts?.bottom ?? 1e9) <= window.innerHeight + 1,
        sideFits: Math.abs((side?.height ?? 0) - window.innerHeight) < 2,
        pwdPlaceholder: pwd?.placeholder,
        pwdAutocomplete: pwd?.autocomplete,
        scrollHeight: document.documentElement.scrollHeight,
        innerHeight: window.innerHeight,
      };
    })()`);
    check('登录页已渲染', login.hasAuth);
    check('主标题有内容', (login.head || '').length > 2, String(login.head));
    check('副标题与主标题不重复', login.head !== login.sub, `${login.head} / ${login.sub}`);
    check('品牌标记到主标题之间的空档是有上限的', login.gapUnderWordmark <= 140,
      `${login.gapUnderWordmark}px`);
    check('登录表单在首屏内，不需要滚动', login.formInFirstScreen);
    check('底部那行信息贴在栏底且可见', login.factsInView);
    check('登录页没有产生纵向滚动条', login.scrollHeight <= login.innerHeight + 1,
      `${login.scrollHeight} vs ${login.innerHeight}`);
    check('登录框的占位提示不是注册用的那句', login.pwdPlaceholder !== '至少 8 位', String(login.pwdPlaceholder));
    check('登录框的自动填充语义是 current-password', login.pwdAutocomplete === 'current-password',
      String(login.pwdAutocomplete));
  }

  /* ---------------- 打开应用 ---------------- */

  // 未登录时应用会主动探测一次 /api/auth/me 并拿到 401，那是设计如此，
  // 不计入「登录后的控制台错误」。
  consoleErrors.length = 0;
  pageErrors.length = 0;
  failedRequests.length = 0;

  await setCookie(seeded.session);
  console.log('\n1. 打开已登录的应用');
  const loaded = new Promise((resolve) => {
    const off = (msg) => {
      if (msg.method === 'Page.loadEventFired') resolve();
    };
    cdp.on(off);
    setTimeout(resolve, 12000);
  });
  await S('Page.navigate', { url: BASE + '/' });
  await loaded;
  await sleep(2500); // 等首屏数据拉完

  const shellState = await evaluate(`(() => {
    const app = document.getElementById('app');
    const avatars = [...document.querySelectorAll('.avatar')];
    return {
      bootHidden: document.getElementById('boot')?.hidden === true,
      appHidden: app?.hidden === true,
      appClass: app?.className || '',
      hasRail: !!document.querySelector('.rail'),
      hasList: !!document.querySelector('.pane--list'),
      hasThread: !!document.querySelector('.pane--thread'),
      hasComposer: !!document.querySelector('.composer__box'),
      convCount: document.querySelectorAll('.listitem[data-conv-id]').length,
      titles: [...document.querySelectorAll('.listitem__name')].map(e => e.textContent),
      iconsRendered: document.querySelectorAll('svg.ico').length,
      placeholders: document.querySelectorAll('svg.ico rect[stroke-dasharray]').length,
      fontLoaded: document.fonts ? document.fonts.check('16px Geist') : null,
      title: document.title,
      avatarCount: avatars.length,
      // h('avatar') 这类笔误会创建出自定义标签，样式全部失效，这里专门盯住它
      unknownTags: [...new Set([...document.querySelectorAll('*')].map(e => e.tagName).filter(t => t.includes('-')))],
      avatarBoxes: avatars.slice(0, 4).map(e => { const r = e.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }),
      railMe: (() => { const e = document.querySelector('.rail__me'); if (!e) return null; const r = e.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })(),
      railFootBottom: Math.round(document.querySelector('.rail__foot')?.getBoundingClientRect().bottom ?? -1),
      railMeTop: Math.round(document.querySelector('.rail__me')?.getBoundingClientRect().top ?? -1),
      hiddenStillVisible: [...document.querySelectorAll('[hidden]')].filter(e => e.getBoundingClientRect().height > 0).map(e => e.id || e.className),
    };
  })()`);

  check('启动骨架已隐藏', shellState.bootHidden);
  check('应用外壳已挂载', !shellState.appHidden && shellState.appClass === 'app');
  check('左中右三栏都在', shellState.hasRail && shellState.hasList && shellState.hasThread);
  check('输入区已渲染', shellState.hasComposer);
  check('会话列表里有两个会话（私聊 + 群）', shellState.convCount === 2, `实际 ${shellState.convCount}: ${shellState.titles}`);
  check('会话标题正确（用的是昵称不是用户名）',
    shellState.titles.includes('朋友一号') && shellState.titles.includes('界面测试群'),
    JSON.stringify(shellState.titles));
  check('图标渲染出来了（不是占位方块）',
    shellState.iconsRendered > 10 && shellState.placeholders === 0,
    `图标 ${shellState.iconsRendered} 个，其中占位 ${shellState.placeholders} 个`);
  check('自托管字体已加载', shellState.fontLoaded === true, String(shellState.fontLoaded));
  check('标题栏显示站点名', shellState.title.includes('Vellum'), shellState.title);

  // 头像曾经因为 h('avatar') 被当成自定义标签而完全没渲染过，这里必须盯死
  check('头像有渲染出来', shellState.avatarCount >= 3, `${shellState.avatarCount} 个`);
  check('没有产生自定义标签（h() 简写用错会留下这种痕迹）',
    shellState.unknownTags.length === 0, JSON.stringify(shellState.unknownTags));
  check('头像是有尺寸的方形',
    shellState.avatarBoxes.length > 0 && shellState.avatarBoxes.every(([w, h]) => w >= 24 && w === h),
    JSON.stringify(shellState.avatarBoxes));
  check('左栏底部的头像有真实高度', (shellState.railMe?.h ?? 0) >= 32, JSON.stringify(shellState.railMe));
  check('底部头像与设置按钮不重叠', shellState.railMeTop >= shellState.railFootBottom,
    `设置底部 ${shellState.railFootBottom} vs 头像顶部 ${shellState.railMeTop}`);
  check('所有 [hidden] 元素真的被藏住了',
    shellState.hiddenStillVisible.length === 0, JSON.stringify(shellState.hiddenStillVisible));

  /* ---------------- 点进会话 ---------------- */

  console.log('\n2. 打开会话，检查消息渲染');
  await evaluate(`(() => {
    const row = document.querySelector('.listitem[data-conv-id="${seeded.convId}"]');
    if (!row) throw new Error('找不到会话行');
    row.click();
    return true;
  })()`);
  await sleep(1800);

  const threadState = await evaluate(`(() => {
    const msgs = [...document.querySelectorAll('.msg')];
    return {
      count: msgs.length,
      mine: document.querySelectorAll('.msg--mine').length,
      theirs: msgs.length - document.querySelectorAll('.msg--mine').length,
      bodies: [...document.querySelectorAll('.msg__body')].map(e => e.textContent.trim()),
      hasDaySep: !!document.querySelector('.daysep'),
      hasQuote: !!document.querySelector('.quote'),
      headTitle: document.querySelector('.pane--thread .pane__title')?.textContent,
      headSub: document.querySelector('.pane--thread .pane__sub')?.textContent,
      emptyState: !!document.querySelector('.pane--thread .empty'),
      threadScrollable: (() => {
        const t = document.querySelector('.thread');
        return t ? { sh: t.scrollHeight, ch: t.clientHeight, top: t.scrollTop } : null;
      })(),
      // 渲染出来的必须是文本节点，绝不能是真实 DOM（XSS 防护）
      injectedImg: document.querySelectorAll('.msg__body img[src="x"]').length,
      toolsCount: document.querySelectorAll('.msg__tools').length,
    };
  })()`);

  check('消息渲染出来了', threadState.count === 3, `实际 ${threadState.count} 条： ${JSON.stringify(threadState.bodies)}`);
  check('自己的消息有标记', threadState.mine >= 2, `mine=${threadState.mine}`);
  check('对方的消息有标记', threadState.theirs >= 1, `theirs=${threadState.theirs}`);
  check('日期分隔条有渲染', threadState.hasDaySep);
  check('多行消息保留了换行', threadState.bodies.some((b) => b.includes('第二行内容')));
  check('会话头部显示对方昵称', threadState.headTitle === '朋友一号', String(threadState.headTitle));
  check('会话头部显示在线状态', /在线|最后在线|离线/.test(threadState.headSub || ''), String(threadState.headSub));
  check('每条消息都有操作按钮', threadState.toolsCount === threadState.count,
    `${threadState.toolsCount} vs ${threadState.count}`);
  check('消息流已滚到底部', threadState.threadScrollable &&
    threadState.threadScrollable.sh - threadState.threadScrollable.ch - threadState.threadScrollable.top < 120,
    JSON.stringify(threadState.threadScrollable));

  /* ---------------- 发一条消息 ---------------- */

  console.log('\n3. 从界面发一条消息');
  await evaluate(`(() => {
    const ta = document.querySelector('.composer__input');
    ta.focus();
    ta.value = '从浏览器界面发出的消息';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    const btn = [...document.querySelectorAll('.composer__tools .icon-btn')].pop();
    btn.click();
    return true;
  })()`);
  await sleep(1800);

  const afterSend = await evaluate(`(() => ({
    count: document.querySelectorAll('.msg').length,
    bodies: [...document.querySelectorAll('.msg__body')].map(e => e.textContent.trim()),
    inputEmpty: document.querySelector('.composer__input').value === '',
    inputPlaceholder: document.querySelector('.composer__input').placeholder,
    sendDisabled: [...document.querySelectorAll('.composer__tools .icon-btn')].pop().disabled,
    statusText: [...document.querySelectorAll('.msg__status')].map(e => e.textContent.trim()),
  }))()`);

  check('发送后消息数 +1', afterSend.count === 4, `实际 ${afterSend.count}`);
  check('发出的内容正确', afterSend.bodies.includes('从浏览器界面发出的消息'),
    JSON.stringify(afterSend.bodies));
  check('发送后输入框被清空', afterSend.inputEmpty);
  check('发送按钮回到禁用态', afterSend.sendDisabled === true);
  check('自己的消息显示送达/已读状态', afterSend.statusText.some((t) => /已送达|已读/.test(t)),
    JSON.stringify(afterSend.statusText));

  /* ---------------- 表情面板 ---------------- */

  console.log('\n4. 表情面板');
  const emojiState = await evaluate(`(() => {
    const btns = [...document.querySelectorAll('.composer__tools .icon-btn')];
    // 第二个是表情按钮
    btns[1].click();
    return true;
  })()`);
  void emojiState;
  await sleep(400);
  const emojiPanel = await evaluate(`(() => {
    const panel = document.querySelector('.emoji');
    if (!panel) return { open: false };
    const tabs = [...panel.querySelectorAll('.emoji__tab')];
    const out = {
      open: true,
      tabs: tabs.map(e => e.textContent),
      selected: tabs.find(t => t.getAttribute('aria-selected') === 'true')?.textContent,
      items: panel.querySelectorAll('.emoji__btn').length,
    };
    // 切到「食物」分组，看格子有没有跟着换
    const food = tabs.find(t => t.textContent === '食物');
    food.click();
    out.afterSwitch = panel.querySelectorAll('.emoji__btn').length;
    // 点一个表情，看有没有插进输入框
    panel.querySelector('.emoji__btn').click();
    out.inputValue = document.querySelector('.composer__input').value;
    return out;
  })()`);
  check('表情面板能打开', emojiPanel.open);
  check('表情分组标签齐全', (emojiPanel.tabs || []).length >= 11, JSON.stringify(emojiPanel.tabs));
  check('没有历史记录时默认落在「表情」分组而不是稀疏的「常用」',
    emojiPanel.selected === '表情', String(emojiPanel.selected));
  check('默认分组有足够多的表情', (emojiPanel.items || 0) > 40, `${emojiPanel.items} 个`);
  check('切换分组会换掉格子内容', (emojiPanel.afterSwitch || 0) > 20, `${emojiPanel.afterSwitch} 个`);
  check('点击表情会插入输入框', (emojiPanel.inputValue || '').length > 0, JSON.stringify(emojiPanel.inputValue));

  const emojiLayout = await evaluate(`(() => {
    const panel = document.querySelector('.emoji');
    if (!panel) return { open: false };
    const tabs = [...panel.querySelectorAll('.emoji__tab')];
    const pr = panel.getBoundingClientRect();
    return {
      open: true,
      panelRight: Math.round(pr.right),
      panelLeft: Math.round(pr.left),
      viewport: window.innerWidth,
      tabsVisible: tabs.filter(t => { const r = t.getBoundingClientRect(); return r.right <= pr.right + 0.5 && r.left >= pr.left - 0.5; }).length,
      tabCount: tabs.length,
      // 标签行放不下时应该换行，而不是被裁掉
      tabRows: new Set(tabs.map(t => Math.round(t.getBoundingClientRect().top))).size,
      overflowX: panel.scrollWidth > panel.clientWidth + 1,
    };
  })()`);
  check('表情面板没有超出视口右边', emojiLayout.panelRight <= emojiLayout.viewport,
    `${emojiLayout.panelRight} vs ${emojiLayout.viewport}`);
  check('所有分组标签都完整可见（没有被裁掉）',
    emojiLayout.tabsVisible === emojiLayout.tabCount,
    `${emojiLayout.tabsVisible}/${emojiLayout.tabCount} 可见，${emojiLayout.tabRows} 行`);
  check('表情面板自身没有横向溢出', emojiLayout.overflowX === false);

  // 清掉刚才插入的表情，别影响后面的判断
  await evaluate(`(() => {
    const ta = document.querySelector('.composer__input');
    ta.value = '';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('.emoji')?.remove();
    return true;
  })()`);

  /* ---------------- 视图切换 ---------------- */

  console.log('\n5. 导航与视图切换');
  const views = await evaluate(`(() => {
    const out = {};
    const railBtns = [...document.querySelectorAll('.rail__nav .rail-btn')];
    railBtns[1].click();
    out.contactsTitle = document.querySelector('.pane--list .pane__title')?.textContent;
    out.contactRows = document.querySelectorAll('.pane--list .listitem').length;
    railBtns[2].click();
    out.searchTitle = document.querySelector('.pane--list .pane__title')?.textContent;
    out.hasSearchInput = !!document.querySelector('.searchbar input');
    railBtns[0].click();
    out.chatsTitle = document.querySelector('.pane--list .pane__title')?.textContent;
    out.backToChats = document.querySelectorAll('.pane--list .listitem[data-conv-id]').length;
    return out;
  })()`);
  check('切到联系人视图', views.contactsTitle === '联系人', String(views.contactsTitle));
  check('联系人列表有内容', views.contactRows >= 1, `${views.contactRows} 行`);
  check('切到搜索视图', views.searchTitle === '搜索', String(views.searchTitle));
  check('搜索框存在', views.hasSearchInput);
  check('能切回会话视图', views.chatsTitle === '会话' && views.backToChats === 2,
    `${views.chatsTitle} / ${views.backToChats}`);

  /* ---------------- 群聊会话 ---------------- */

  console.log('\n6. 群聊会话');
  await evaluate(`document.querySelector('.listitem[data-conv-id="${seeded.groupId}"]').click()`);
  await sleep(1200);
  const groupState = await evaluate(`(() => ({
    title: document.querySelector('.pane--thread .pane__title')?.textContent,
    sub: document.querySelector('.pane--thread .pane__sub')?.textContent,
    sysmsg: document.querySelector('.sysmsg')?.textContent,
  }))()`);
  check('群聊标题正确', groupState.title === '界面测试群', String(groupState.title));
  check('群聊显示成员数', /2 位成员/.test(groupState.sub || ''), String(groupState.sub));
  check('系统消息以居中样式渲染', /创建了群聊/.test(groupState.sysmsg || ''), String(groupState.sysmsg));

  /* ---------------- WebSocket ---------------- */

  console.log('\n7. 实时连接');
  const socketState = await evaluate(`(() => ({
    hasVellumGlobal: !!window.__vellum,
    connBar: !!document.querySelector('.connbar'),
  }))()`);
  check('调试句柄已挂载', socketState.hasVellumGlobal);
  check('没有「连接已断开」提示条', socketState.connBar === false);

  /* ---------------- 空状态与设置 ---------------- */

  console.log('\n9. 空状态与管理员设置');
  {
    // 重新加载后不选任何会话，应该是空状态 + 隐藏输入区
    await S('Page.navigate', { url: BASE + '/' });
    await sleep(2600);
    const idle = await evaluate(`(() => {
      const foot = document.querySelector('.composer');
      const empty = document.querySelector('.pane--thread .empty');
      return {
        hasEmpty: !!empty,
        emptyText: empty?.textContent?.trim(),
        composerDisplayed: foot ? getComputedStyle(foot).display !== 'none' : null,
        threadIsFlex: getComputedStyle(document.querySelector('.thread')).display,
      };
    })()`);
    check('没选会话时显示空状态', idle.hasEmpty, String(idle.emptyText).slice(0, 60));
    check('空状态文案完整（没有被孤字断行撑破）', (idle.emptyText || '').includes('消息就会出现在这里'),
      String(idle.emptyText));
    check('没选会话时输入区被隐藏', idle.composerDisplayed === false, String(idle.composerDisplayed));
    check('消息栏是 flex 容器（内容少时才能贴底）', idle.threadIsFlex === 'flex', String(idle.threadIsFlex));

    // 打开设置，检查管理员区块
    await evaluate(`(async () => {
      document.querySelectorAll('.rail__foot .rail-btn')[0].click();
      await new Promise(r => setTimeout(r, 1400));
    })()`);
    const settingsState = await evaluate(`(() => {
      const dialog = document.querySelector('.dialog');
      if (!dialog) return { open: false };
      const code = [...dialog.querySelectorAll('code')].map(e => e.textContent);
      const stats = [...dialog.querySelectorAll('.meta')].map(e => e.textContent);
      return {
        open: true,
        title: dialog.querySelector('.dialog__title')?.textContent,
        inviteCode: code[0] || null,
        hasInviteHeading: [...dialog.querySelectorAll('h3')].some(h => h.textContent.includes('邀请码')),
        hasRotateBtn: [...dialog.querySelectorAll('button')].some(b => b.textContent.includes('换一个')),
        stats,
        bodyScrollable: (() => { const b = dialog.querySelector('.dialog__body'); return b ? b.scrollHeight > b.clientHeight : null; })(),
      };
    })()`);
    check('设置对话框能打开', settingsState.open && settingsState.title === '设置', String(settingsState.title));
    check('管理员能看到邀请码区块', settingsState.hasInviteHeading);
    check('邀请码已渲染出来', (settingsState.inviteCode || '').length >= 8, String(settingsState.inviteCode));
    check('邀请码与后端一致', settingsState.inviteCode === seeded.invite,
      `${settingsState.inviteCode} vs ${seeded.invite}`);
    check('有「换一个」按钮', settingsState.hasRotateBtn);
    check('管理员能看到站点统计', (settingsState.stats || []).includes('成员'),
      JSON.stringify(settingsState.stats));

    // 关掉对话框，恢复干净状态
    await evaluate(`document.querySelector('.dialog__head .icon-btn').click()`);
    await sleep(300);
  }

  /* ---------------- 控制台干净度 ---------------- */

  console.log('\n8. 控制台与网络');
  const ignorable = (t) =>
    /favicon|Download the React|DevTools|Autofill|net::ERR_ABORTED.*favicon/i.test(t);
  const realErrors = consoleErrors.filter((t) => !ignorable(t));
  const realFailed = failedRequests.filter((t) => !ignorable(t));

  check('没有未捕获的 JS 异常', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 400));
  check('控制台没有 error', realErrors.length === 0, realErrors.join(' | ').slice(0, 400));
  check('没有加载失败的请求', realFailed.length === 0, realFailed.join(' | ').slice(0, 300));
  if (consoleWarns.length) {
    console.log(`  （有 ${consoleWarns.length} 条 warning，仅供参考）`);
    for (const w of consoleWarns.slice(0, 5)) console.log(`     - ${w.slice(0, 160)}`);
  }

  /* ---------------- 收尾 ---------------- */

  ws.close();
  await sleep(200);
  for (const fn of cleanup.reverse()) await fn().catch(() => {});

  console.log(`\n${'='.repeat(56)}`);
  console.log(`浏览器检查：通过 ${pass} 项，失败 ${fail} 项`);
  if (failures.length) {
    console.log('\n失败明细：');
    for (const f of failures) console.log(`  - ${f}`);
  }
  console.log('='.repeat(56));
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('\n浏览器检查崩了：', err);
  for (const fn of cleanup.reverse()) {
    try {
      await fn();
    } catch {
      /* 收尾失败就算了 */
    }
  }
  process.exit(1);
});
