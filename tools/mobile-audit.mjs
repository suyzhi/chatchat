/**
 * 手机端布局审计。
 *
 * 为什么需要它：宽屏截图看不出「气泡被挤窄」「点击热区只有 22px」
 * 这类问题，而这些恰恰是手机上最容易翻车的地方。这个脚本用无头 Edge 在
 * 真机视口（390×844 / 320×568）里把关键元素全部量一遍，顺便截几张图，
 * 最后吐出一份可勾选的 HTML 报告。
 *
 * 用法：
 *   node tools/mobile-audit.mjs                 自己起临时服务，审计 + 报告
 *   node tools/mobile-audit.mjs --external <url> 打一个已经在跑的服务
 *   node tools/mobile-audit.mjs --out <目录>     报告与截图输出目录
 *
 * 注意：**不要串在 `npm run verify` 后面**。造数据那一步要求目标是一个
 * 「还没有任何用户」的干净实例（第一个注册的账号才不用邀请码），而 smoke
 * 跑完的实例里已经有一堆用户了，链在一起必然卡在造数据那一步。要单独跑；
 * 不加参数时它会自己起一个干净的临时实例，所以直接 `npm run mobile` 就行。
 */
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const argOf = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
};
const EXTERNAL = argOf('--external');
const OUT = resolve(argOf('--out') || join(ROOT, 'screenshots', 'mobile'));

/** 要审计的视口。320 是 iPhone SE 一代 / 老安卓的宽度，最窄的现实情况；
 *  844×390 是横屏手机，高度只剩 390 时底部导航会成为大头。 */
const VIEWPORTS = [
  { key: '390', width: 390, height: 844, name: 'iPhone 14 / 主流安卓', state: 'both' },
  { key: '320', width: 320, height: 568, name: 'iPhone SE 一代（最窄）', state: 'both' },
  { key: '390L', width: 844, height: 390, name: '横屏手机', state: 'thread' },
];

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

let BASE = EXTERNAL;

/* ------------------------------------------------------------------ */
/* 结论收集                                                            */
/* ------------------------------------------------------------------ */

const findings = [];
function check(area, name, ok, detail = '', level = 'fail') {
  findings.push({ area, name, ok: Boolean(ok), detail: String(detail), level });
  const tag = ok ? 'OK  ' : level === 'warn' ? 'WARN' : 'FAIL';
  console.log(`  [${tag}] ${name}${detail ? ` — ${detail}` : ''}`);
}

/* ------------------------------------------------------------------ */
/* 临时服务 + 造数据                                                    */
/* ------------------------------------------------------------------ */

async function startServer() {
  const dataDir = await mkdtemp(join(tmpdir(), 'vellum-mobile-data-'));
  const port = 8900 + Math.floor(Math.random() * 300);
  const child = spawn(process.execPath, [join(ROOT, 'src', 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      SESSION_SECRET: 'mobile-audit-secret',
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
      if ((await fetch(`${base}/healthz`)).ok) return base;
    } catch {
      /* 还没起来 */
    }
  }
  throw new Error('临时服务没能在 12 秒内启动');
}

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
      try {
        return { status: res.status, data: JSON.parse(text) };
      } catch {
        return { status: res.status, data: text };
      }
    },
    session: () => jar.get('vellum_session'),
  };
}

/** 造出「一条短消息 + 一条长消息 + 一条自己的长消息」，长文才能量出气泡宽度 */
async function seed() {
  const stamp = Date.now().toString(36);
  const host = makeClient();
  const peer = makeClient();

  const meReg = await host.req('POST', '/api/auth/register', {
    username: `m_${stamp}`,
    displayName: '林',
    password: 'mobile-audit-password',
  });
  if (meReg.status !== 201) throw new Error(`注册失败: ${JSON.stringify(meReg.data)}（外部实例需要是干净的空站）`);

  const invite = (await host.req('GET', '/api/admin/invite')).data.code;
  const peerReg = await peer.req('POST', '/api/auth/register', {
    username: `p_${stamp}`,
    displayName: '老周',
    password: 'mobile-audit-password',
    inviteCode: invite,
  });
  if (peerReg.status !== 201) throw new Error(`注册第二人失败: ${JSON.stringify(peerReg.data)}`);

  const dm = await host.req('POST', '/api/conversations', {
    type: 'dm',
    userId: peerReg.data.user.id,
  });
  const convId = dm.data.conversation.id;

  await peer.req('POST', `/api/conversations/${convId}/messages`, { kind: 'text', body: '在吗' });
  await peer.req('POST', `/api/conversations/${convId}/messages`, {
    kind: 'text',
    body: '新服务器已经搬完了，图片和语音都走分块上传，几个 G 的文件也不会断。之前那个方案传到一半就超时。',
  });
  await host.req('POST', `/api/conversations/${convId}/messages`, {
    kind: 'text',
    body: '收到，我这边也试了一下，手机上连着传了三个视频都正常，速度比之前快不少。',
  });
  await peer.req('POST', `/api/conversations/${convId}/messages`, {
    kind: 'text',
    body: '那就先这样，晚上再看一遍日志。',
  });

  const group = await host.req('POST', '/api/conversations', {
    type: 'group',
    title: '周末看展',
    memberIds: [peerReg.data.user.id],
  });

  const session = host.session();
  if (!session) throw new Error('没拿到会话 cookie');
  return { session, convId, groupId: group.data.conversation.id };
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
/* 页面里跑的测量脚本                                                   */
/* ------------------------------------------------------------------ */

/**
 * 列表视图测量。
 * 关注：底部导航是否被安全区压住、点击热区够不够 44px、有没有横向溢出。
 */
const MEASURE_LIST = `(() => {
  const r = (el) => { const b = el?.getBoundingClientRect(); return b ? { w: +b.width.toFixed(1), h: +b.height.toFixed(1), l: +b.left.toFixed(1), t: +b.top.toFixed(1), r: +b.right.toFixed(1), b: +b.bottom.toFixed(1) } : null; };
  const rail = document.querySelector('.rail');
  const railBtns = [...document.querySelectorAll('.rail-btn')];
  const tick = document.querySelector('.fx-rail-tick');
  const rows = [...document.querySelectorAll('.pane--list .listitem')];
  const searchInput = document.querySelector('.searchbar input');
  const listPane = document.querySelector('.pane--list');
  const threadPane = document.querySelector('.pane--thread');
  const active = document.querySelector('.rail-btn[aria-current="true"]');
  return {
    viewport: { w: window.innerWidth, h: window.innerHeight },
    fx: document.documentElement.dataset.fx,
    rail: r(rail),
    railFlex: rail ? getComputedStyle(rail).flexDirection : null,
    railBtn: r(railBtns[0]),
    railBtnLabelShown: railBtns[0] ? getComputedStyle(railBtns[0].querySelector('.rail-btn__label')).display !== 'none' : null,
    tick: tick ? { ...r(tick), opacity: getComputedStyle(tick).opacity } : null,
    activeBtn: r(active),
    row: r(rows[0]),
    rowCount: rows.length,
    searchInput: r(searchInput),
    listVisible: listPane ? getComputedStyle(listPane).display !== 'none' : null,
    threadVisible: threadPane ? getComputedStyle(threadPane).display !== 'none' : null,
    docScrollW: document.documentElement.scrollWidth,
    bodyScrollW: document.body.scrollWidth,
    /** 触屏分支到底有没有生效——媒体特性在无头浏览器里很容易「看着像」 */
    touch: {
      hoverNone: window.matchMedia('(hover: none)').matches,
      pointerCoarse: window.matchMedia('(pointer: coarse)').matches,
      maxTouchPoints: navigator.maxTouchPoints,
      combo: window.matchMedia('(max-width: 52rem) and (hover: none) and (pointer: coarse)').matches,
    },
    /* 底部导航条上有没有多余的东西：字标、FX 开关、品牌块 */
    railExtras: {
      wordmark: !!document.querySelector('.fx-wordmark') && getComputedStyle(document.querySelector('.fx-wordmark')).display !== 'none',
      toggle: !!document.querySelector('.fx-toggle') && getComputedStyle(document.querySelector('.fx-toggle')).display !== 'none',
      brand: !!document.querySelector('.rail__brand') && getComputedStyle(document.querySelector('.rail__brand')).display !== 'none',
    },
  };
})()`;

/**
 * 会话视图测量。
 * 关注：气泡实际可用宽度（被操作道挤掉多少）、头像与气泡的对齐、
 * 输入区提示行的存在感、画布切换用的定位上下文。
 */
const MEASURE_THREAD = `(() => {
  const r = (el) => { const b = el?.getBoundingClientRect(); return b ? { w: +b.width.toFixed(1), h: +b.height.toFixed(1), l: +b.left.toFixed(1), t: +b.top.toFixed(1), r: +b.right.toFixed(1), b: +b.bottom.toFixed(1) } : null; };
  const inner = document.querySelector('.thread__inner');
  const thread = document.querySelector('.thread');
  const bodies = [...document.querySelectorAll('.msg__body')];
  const widest = bodies.reduce((a, b) => (b.getBoundingClientRect().width > (a?.getBoundingClientRect().width ?? -1) ? b : a), null);
  const mineBodies = [...document.querySelectorAll('.msg--mine .msg__body')];
  const longest = mineBodies.sort((a, b) => b.textContent.length - a.textContent.length)[0] || null;
  const longestBox = longest?.getBoundingClientRect();
  const longestText = longest?.textContent || '';
  const longestLines = longest ? Math.round(longestBox.height / parseFloat(getComputedStyle(longest).lineHeight)) : null;
  const cs = longest ? getComputedStyle(longest) : null;
  /* 一行大概能放几个汉字：用同一段文字在等宽容器里试出来 */
  let charsPerLine = null;
  if (longest && longestLines) {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;font:' + (cs?.font || '') ;
    probe.style.fontSize = cs?.fontSize;
    probe.style.fontFamily = cs?.fontFamily;
    probe.style.letterSpacing = cs?.letterSpacing;
    probe.textContent = '汉'.repeat(10);
    document.body.appendChild(probe);
    const oneChar = probe.getBoundingClientRect().width / 10;
    probe.remove();
    charsPerLine = +( (longestBox.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)) / oneChar ).toFixed(1);
  }
  const composer = document.querySelector('.composer');
  const box = document.querySelector('.composer__box');
  const hint = document.querySelector('.composer__hint');
  const prompt = document.querySelector('.composer__prompt');
  const input = document.querySelector('.composer__input');
  const msgCol = document.querySelector('.msg:not(.msg--mine) .msg__col');
  const tools = document.querySelector('.msg:not(.msg--mine) .msg__tools');
  const gridBg = thread ? getComputedStyle(thread).backgroundImage : null;
  return {
    fx: document.documentElement.dataset.fx,
    inner: r(inner),
    innerPadding: inner ? getComputedStyle(inner).padding : null,
    viewport: { w: window.innerWidth, h: window.innerHeight },
    rail: r(document.querySelector('.rail')),
    mobileLayout: window.matchMedia('(max-width: 52rem), (max-width: 60rem) and (max-height: 30rem)').matches,
    thread: r(thread),
    threadScrollW: thread ? thread.scrollWidth : null,
    threadClientW: thread ? thread.clientWidth : null,
    widestBubble: r(widest),
    longest: longestBox ? {
      w: +longestBox.width.toFixed(1),
      lines: longestLines,
      charsPerLine,
      text: longestText.slice(0, 18),
      wrapWidth: +(longestBox.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)).toFixed(1),
    } : null,
    msgCol: msgCol ? { w: +msgCol.getBoundingClientRect().width.toFixed(1), padding: getComputedStyle(msgCol).padding } : null,
    tools: r(tools),
    toolsOpacity: tools ? getComputedStyle(tools).opacity : null,
    composer: r(composer),
    composerBox: r(box),
    hint: hint ? { ...r(hint), display: getComputedStyle(hint).display, text: hint.textContent.trim() } : null,
    prompt: prompt ? { ...r(prompt), display: getComputedStyle(prompt).display } : null,
    input: r(input),
    inputFontSize: input ? getComputedStyle(input).fontSize : null,
    /* 消息流上的十二栏栅格在手机上是不是太吵（横向 1px 线的条数） */
    gridStops: gridBg && gridBg !== 'none' ? (gridBg.match(/repeating-linear-gradient/g) || []).length : 0,
    rowNumShown: (() => { const m = document.querySelector('.msg'); if (!m) return null; return getComputedStyle(m, '::before').content !== 'none'; })(),
    stage: r(document.querySelector('.fx-stage')),
    progress: (() => {
      const p = document.querySelector('.fx-progress');
      const pane = document.querySelector('.pane--thread');
      if (!p || !pane) return null;
      const pb = p.getBoundingClientRect();
      const rb = pane.getBoundingClientRect();
      return {
        t: +pb.top.toFixed(1),
        b: +pb.bottom.toFixed(1),
        paneT: +rb.top.toFixed(1),
        paneB: +rb.bottom.toFixed(1),
        width: +pb.width.toFixed(1),
        paneWidth: +rb.width.toFixed(1),
        idle: p.dataset.idle,
      };
    })(),
    docScrollW: document.documentElement.scrollWidth,
    bodyScrollW: document.body.scrollWidth,
    touch: {
      hoverNone: window.matchMedia('(hover: none)').matches,
      pointerCoarse: window.matchMedia('(pointer: coarse)').matches,
      maxTouchPoints: navigator.maxTouchPoints,
      combo: window.matchMedia('(max-width: 52rem) and (hover: none) and (pointer: coarse)').matches,
    },
  };
})()`;

/**
 * 画布式切换：连点两个会话，看 reel/stage 有没有正确接管、
 * 动画结束后有没有把真面板放回去（结构没残渣）。
 */
const SWAP_PROBE = `(async (ids) => {
  const rowFor = (id) => {
    const railBtns = [...document.querySelectorAll('.rail__nav .rail-btn')];
    railBtns[0].click();
    return document.querySelector('.pane--list .listitem[data-conv-id="' + id + '"]');
  };
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const out = { steps: [] };
  for (const id of ids) {
    const row = rowFor(id);
    if (!row) { out.steps.push({ id, missing: true }); continue; }
    row.click();
    await wait(60);
    const mid = {
      id,
      stages: document.querySelectorAll('.fx-stage').length,
      reels: document.querySelectorAll('.fx-reel').length,
      slots: document.querySelectorAll('.fx-slot').length,
    };
    await wait(1400);
    const after = {
      stages: document.querySelectorAll('.fx-stage').length,
      reels: document.querySelectorAll('.fx-reel').length,
      slots: document.querySelectorAll('.fx-slot').length,
      spacers: document.querySelectorAll('.fx-spacer').length,
      inners: document.querySelectorAll('.thread > .thread__inner').length,
      msgs: document.querySelectorAll('.thread .msg[data-msg-id]').length,
      title: document.querySelector('.pane--thread .pane__title')?.textContent,
      scrollTop: Math.round(document.querySelector('.thread')?.scrollTop ?? -1),
      maxScroll: Math.round((document.querySelector('.thread')?.scrollHeight ?? 0) - (document.querySelector('.thread')?.clientHeight ?? 0)),
    };
    out.steps.push({ id, mid, after });
    await wait(300);
  }
  return out;
})`;

/* ------------------------------------------------------------------ */

async function main() {
  if (!BASE) BASE = await startServer();
  const seeded = await seed();
  console.log(`审计目标 ${BASE}（会话 #${seeded.convId}，群 #${seeded.groupId}）`);
  await mkdir(OUT, { recursive: true });

  const profile = await mkdtemp(join(tmpdir(), 'vellum-mobile-profile-'));
  cleanup.push(() => rm(profile, { recursive: true, force: true }).catch(() => {}));
  const debugPort = 9600 + Math.floor(Math.random() * 200);
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
      browserWs = (await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json()).webSocketDebuggerUrl;
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
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const S = (m, p) => cdp.send(m, p, sessionId);
  await S('Page.enable');
  await S('Network.enable');
  await S('Runtime.enable');
  await S('Log.enable');

  const consoleErrors = [];
  cdp.on((msg) => {
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push((msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      consoleErrors.push(d.exception?.description || d.text);
    }
  });

  const evaluate = async (expression, ...args) => {
    const src = args.length ? `(${expression})(${args.map((a) => JSON.stringify(a)).join(',')})` : expression;
    const res = await S('Runtime.evaluate', { expression: src, returnByValue: true, awaitPromise: true });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
    }
    return res.result.value;
  };

  const host = new URL(BASE).hostname;
  await S('Network.setCookie', {
    name: 'vellum_session',
    value: seeded.session,
    domain: host,
    path: '/',
    httpOnly: true,
  });

  const shots = [];
  const shot = async (name, vp) => {
    const { data } = await S('Page.captureScreenshot', { format: 'png' });
    const file = join(OUT, `${name}.png`);
    await writeFile(file, Buffer.from(data, 'base64'));
    shots.push({ name, file, vp });
    console.log(`  → ${name}.png (${vp.width}×${vp.height})`);
  };

  for (const vp of VIEWPORTS) {
    console.log(`\n${'='.repeat(60)}\n视口 ${vp.width}×${vp.height}（${vp.name}）\n${'='.repeat(60)}`);
    await S('Emulation.setDeviceMetricsOverride', {
      width: vp.width,
      height: vp.height,
      deviceScaleFactor: 2,
      mobile: true,
    });
    /*
     * 光靠 setDeviceMetricsOverride 并不会让 CSS 的 hover/pointer 媒体查询
     * 变成触屏那一支 —— 无头浏览器默认还是 hover:hover / pointer:fine，
     * 于是「触屏分支」在审计里永远测不到（实测踩过：字号和提示行的检查
     * 一直红着，代码明明是对的）。直接把这两项当媒体特性覆盖掉。
     */
    await S('Emulation.setEmulatedMedia', {
      features: [
        { name: 'hover', value: 'none' },
        { name: 'pointer', value: 'coarse' },
        { name: 'any-hover', value: 'none' },
        { name: 'any-pointer', value: 'coarse' },
      ],
    });
    /* 有些版本对 setEmulatedMedia 的 pointer/hover 不认账，触摸模拟也开一手，
       两条路任意一条生效都行（下面会断言到底有没有生效）。 */
    await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

    /* ---------- 列表 ---------- */
    let list = null;
    if (vp.state !== 'thread') {
      console.log('\n[列表视图]');
      await S('Page.navigate', { url: BASE + '/' });
      await sleep(2600);
      list = await evaluate(MEASURE_LIST);
      console.log(JSON.stringify(list, null, 1));
      await shot(`${vp.key}-01-列表`, vp);

      check('列表', '移动端布局已生效（左侧竖栏变底部横条）', list.railFlex === 'row', `flex-direction: ${list.railFlex}`);
      check('列表', '只有列表栏可见，会话栏已让位', list.listVisible === true && list.threadVisible === false);
      check('列表', '页面没有横向溢出', list.docScrollW <= list.viewport.w && list.bodyScrollW <= list.viewport.w,
        `scrollWidth ${list.docScrollW}/${list.bodyScrollW} vs ${list.viewport.w}`);
      check('列表', '底部导航按钮热区 ≥ 44×44', (list.railBtn?.h ?? 0) >= 44 && (list.railBtn?.w ?? 0) >= 44,
        `${list.railBtn?.w}×${list.railBtn?.h}`);
      check('列表', '会话行高 ≥ 56（手指点得准）', (list.row?.h ?? 0) >= 56, `${list.row?.h}px`);
      check('列表', '搜索框热区 ≥ 36', (list.searchInput?.h ?? 0) >= 36, `${list.searchInput?.h}px`);
      check('列表', '底部导航条里没有塞字标 / FX 开关 / 品牌块',
        !list.railExtras.wordmark && !list.railExtras.toggle && !list.railExtras.brand,
        JSON.stringify(list.railExtras));
      check('列表', '导航滑块躺在当前项上沿（横向）',
        list.tick &&
          Math.abs(list.tick.h - 2) < 1.6 &&
          list.tick.w >= 24 &&
          list.tick.w <= (list.activeBtn?.w ?? 999) &&
          Math.abs((list.tick.l + list.tick.w / 2) - (list.activeBtn.l + list.activeBtn.w / 2)) <= 2 &&
          list.tick.opacity === '1',
        JSON.stringify({ tick: list.tick, active: list.activeBtn }));
      check('列表', '底部导航没有贴到视口最底（安全区留白）',
        list.rail && list.rail.b <= list.viewport.h + 0.5,
        `rail.bottom ${list.rail?.b} / 视口高 ${list.viewport.h}`);
    }

    /* ---------- 会话 ---------- */
    console.log('\n[会话视图]');
    await S('Page.navigate', { url: BASE + '/' });
    await sleep(2600);
    await evaluate(`document.querySelector('.pane--list .listitem[data-conv-id="${seeded.convId}"]').click()`);
    await sleep(1400);
    const thread = await evaluate(MEASURE_THREAD);
    console.log(JSON.stringify(thread, null, 1));
    await shot(`${vp.key}-02-会话`, vp);

    check('会话', '消息栏铺满可用宽度（没有残留的列表栏占位）',
      Math.abs((thread.inner?.w ?? 0) - Math.min(vp.width, 56 * 16)) <= 2,
      `inner ${thread.inner?.w}px / 视口 ${vp.width}px`);
    /* 这一条红的时候不能瞎猜：把整条祖先链的宽度和最宽气泡的文本一起打出来，
       一眼能看出是「栏被压窄」还是「断言写错了」 */
    if (Math.abs((thread.inner?.w ?? 0) - Math.min(vp.width, 56 * 16)) > 2) {
      const chain = await evaluate(`(() => {
        const out = [];
        let n = document.querySelector('.thread__inner');
        while (n && n !== document.body) {
          const b = n.getBoundingClientRect();
          out.push({
            sel: n.tagName.toLowerCase() + (n.className && typeof n.className === 'string' ? '.' + n.className.trim().split(/\\s+/).join('.') : ''),
            w: +b.width.toFixed(1),
            maxW: getComputedStyle(n).maxWidth,
            disp: getComputedStyle(n).display,
          });
          n = n.parentElement;
        }
        const app = document.querySelector('.app');
        const pane = document.querySelector('.pane--thread');
        return {
          chain: out,
          appCols: app ? getComputedStyle(app).gridTemplateColumns : null,
          railW: +document.querySelector('.rail').getBoundingClientRect().width.toFixed(1),
          listW: +document.querySelector('.pane--list').getBoundingClientRect().width.toFixed(1),
          paneW: +pane.getBoundingClientRect().width.toFixed(1),
          paneScrollW: pane.scrollWidth,
        };
      })()`);
      console.log('  祖先链宽度：', JSON.stringify(chain, null, 1));
    }
    check('会话', '消息流没有横向溢出', thread.threadScrollW <= thread.threadClientW,
      `${thread.threadScrollW} vs ${thread.threadClientW}`);
    check('会话', '气泡宽度利用充分（≥ 可用宽度的 62%）',
      (thread.widestBubble?.w ?? 0) >= Math.min(vp.width, 56 * 16) * 0.62,
      `最宽气泡 ${thread.widestBubble?.w}px / 消息列 ${thread.inner?.w}px`);
    check('会话', '长消息每行至少 12 个汉字', (thread.longest?.charsPerLine ?? 0) >= 12,
      `${thread.longest?.charsPerLine} 字/行，${thread.longest?.lines} 行`);
    check('会话', '操作道没有吃掉过多正文宽度（气泡可用宽 ≥ 消息列的 55%）',
      (thread.longest?.wrapWidth ?? 0) >= Math.min(vp.width, 56 * 16) * 0.55,
      `${thread.longest?.wrapWidth}px`);
    check('会话', '行号在窄屏已撤掉（不跟正文抢左边距）',
      thread.rowNumShown === !thread.mobileLayout,
      `::before content 显示：${thread.rowNumShown}，手机布局：${thread.mobileLayout}`);
    check('会话', '输入框字号 ≥ 16px（iOS 聚焦时不缩放）',
      parseFloat(thread.inputFontSize || '0') >= 16, `${thread.inputFontSize}`);
    check('会话', '键盘提示行在触屏上藏起来了', thread.hint?.display === 'none',
      thread.hint ? `${thread.hint.display}：${thread.hint.text}` : '不存在');
    /* 阅读进度条只在「窄屏」出现：横屏手机宽度 844px 不满足 max-width:52rem，
       那时它按宽屏规则贴在消息栏顶端 —— 与本次手机适配无关，横屏就不查了。 */
    if (vp.height >= 500) {
      check('会话', '阅读进度条收在消息栏内部（没有跑到别的栏上）',
        thread.progress &&
          thread.progress.width > vp.width * 0.9 &&
          thread.progress.t >= thread.progress.paneT - 0.5 &&
          thread.progress.b <= thread.progress.paneB + 0.5,
        JSON.stringify(thread.progress));
    }
    check('会话', '输入区完整在首屏内（没有被底部导航压住）',
      thread.composer && thread.composer.b <= vp.height + 0.5, `${thread.composer?.b} / ${vp.height}`);

    /* 横屏手机：高度只有 390，标题栏 + 输入区 + 底部导航加起来 176px 是
       定数，消息区能拿到的就是这个数。这里不追「占屏幕百分之几」——竖屏
       和横屏的分母不一样，横屏天然吃亏；只守住「还能好好看消息」的下限。 */
    if (vp.height < 500) {
      check('横屏', '底部导航在横屏时收窄（高度比宽度金贵）',
        (thread.rail?.h ?? 999) <= 48, `导航条 ${thread.rail?.h}px`);
      check('横屏', '消息区高度 ≥ 200px（约 4 行消息，不是一条缝）',
        (thread.thread?.h ?? 0) >= 200, `${thread.thread?.h}px / 视口 ${vp.height}px`);
      check('横屏', '输入区没有被压到只剩一行以下', (thread.composer?.h ?? 0) >= 44, `${thread.composer?.h}px`);
    }

    /* ---------- 画布式切换 ---------- */
    console.log('\n[画布式会话切换]');
    const swap = await evaluate(SWAP_PROBE, [seeded.groupId, seeded.convId]);
    console.log(JSON.stringify(swap, null, 1));
    const last = swap.steps[swap.steps.length - 1];
    check('切换', '切换过程中画布接管了新面板', (last?.mid?.slots ?? 0) >= 1, JSON.stringify(last?.mid));
    check('切换', '动画结束后画布残渣清理干净',
      last?.after && last.after.stages === 0 && last.after.reels === 0 && last.after.slots === 0 && last.after.spacers === 0,
      JSON.stringify(last?.after));
    check('切换', '只剩一个真面板挂回消息流', last?.after?.inners === 1, `${last?.after?.inners} 个`);
    check('切换', '切换后停在消息底部', last?.after && Math.abs(last.after.scrollTop - last.after.maxScroll) <= 4,
      `scrollTop ${last?.after?.scrollTop} / max ${last?.after?.maxScroll}`);
  }

  /* ---------- 收尾 ---------- */
  check('控制台', '审计期间没有 JS 报错', consoleErrors.length === 0, consoleErrors.join(' | ').slice(0, 300));

  ws.close();
  await sleep(200);
  for (const fn of cleanup.reverse()) await fn().catch(() => {});

  /* ---------- HTML 报告 ---------- */
  const areas = [...new Set(findings.map((f) => f.area))];
  const bad = findings.filter((f) => !f.ok && f.level === 'fail');
  const rowsHtml = areas
    .map((area) => {
      const items = findings.filter((f) => f.area === area);
      return `<section><h3>${area}</h3><ul>${items
        .map(
          (f) =>
            `<li class="${f.ok ? 'ok' : f.level}"><span class="tag">${f.ok ? '通过' : f.level === 'warn' ? '留意' : '未过'}</span> ${f.name}${
              f.detail ? `<code>${f.detail.replace(/</g, '&lt;')}</code>` : ''
            }</li>`,
        )
        .join('')}</ul></section>`;
    })
    .join('');

  const shotsHtml = shots
    .map(
      (s) =>
        `<figure><img src="${s.name}.png" alt="${s.name}"><figcaption>${s.name}<br>${s.vp.width}×${s.vp.height}</figcaption></figure>`,
    )
    .join('');

  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>Vellum 手机端审计</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; padding: 2rem clamp(1rem, 4vw, 4rem); font: 15px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; color: #16161a; background: #f6f6f7; }
  h1 { font-size: 1.5rem; margin: 0 0 .25rem; letter-spacing: -.02em; }
  .meta { color: #6b6b74; font-size: .8125rem; margin-bottom: 2rem; font-family: ui-monospace, monospace; }
  .verdict { display: inline-block; padding: .3rem .7rem; border-radius: 4px; font-weight: 600; font-size: .8125rem; }
  .verdict.bad { background: #fde8e8; color: #a01b22; }
  .verdict.good { background: #e6f5ec; color: #1c6b46; }
  section { background: #fff; border: 1px solid #e4e4e8; border-radius: 6px; padding: 1rem 1.25rem; margin-bottom: 1rem; }
  h3 { margin: 0 0 .5rem; font-size: .8125rem; text-transform: uppercase; letter-spacing: .1em; color: #6b6b74; }
  ul { list-style: none; margin: 0; padding: 0; }
  li { padding: .35rem 0; border-top: 1px solid #f0f0f2; }
  li:first-child { border-top: 0; }
  .tag { display: inline-block; min-width: 3rem; text-align: center; font-size: .6875rem; padding: .05rem .35rem; border-radius: 3px; margin-right: .5rem; }
  li.ok .tag { background: #e6f5ec; color: #1c6b46; }
  li.fail { color: #a01b22; }
  li.fail .tag { background: #fde8e8; color: #a01b22; }
  li.warn .tag { background: #fdf3e0; color: #8a5a00; }
  code { display: block; margin-top: .15rem; color: #6b6b74; font-size: .75rem; word-break: break-all; }
  .shots { display: flex; flex-wrap: wrap; gap: 1.5rem; }
  figure { margin: 0; }
  img { width: 300px; border: 1px solid #d8d8de; border-radius: 8px; background: #fff; }
  figcaption { font-size: .75rem; color: #6b6b74; margin-top: .4rem; font-family: ui-monospace, monospace; }
</style></head>
<body>
  <h1>Vellum 手机端审计</h1>
  <p class="meta">目标 ${BASE}　·　${new Date().toLocaleString('zh-CN')}　·　视口 ${VIEWPORTS.map((v) => v.width).join(' / ')}</p>
  <p><span class="verdict ${bad.length ? 'bad' : 'good'}">${
    bad.length ? `${bad.length} 项未通过` : '全部通过'
  }（共 ${findings.length} 项）</span></p>
  ${rowsHtml}
  <section><h3>截图</h3><div class="shots">${shotsHtml}</div></section>
</body></html>`;

  const report = join(OUT, '报告.html');
  await writeFile(report, html);
  console.log(`\n${'='.repeat(60)}`);
  console.log(`手机端审计：通过 ${findings.filter((f) => f.ok).length} 项，未过 ${bad.length} 项`);
  if (bad.length) {
    console.log('\n未通过：');
    for (const f of bad) console.log(`  - [${f.area}] ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
  }
  console.log(`\n报告：${report}`);
  console.log(`截图：${OUT}`);
  console.log('='.repeat(60));
  process.exit(bad.length ? 1 : 0);
}

main().catch(async (err) => {
  console.error('\n审计崩了：', err);
  for (const fn of cleanup.reverse()) await fn().catch(() => {});
  process.exit(1);
});
