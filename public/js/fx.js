/**
 * 前卫层（FX）的运行时。
 *
 * 这一层不改任何业务逻辑：它只观察 DOM，给新出现的东西挂上入场动画，
 * 再补几件「仪器」——滚动进度、坐标十字线、实时钟、导航滑块、电平条。
 *
 * 全部效果都由 html[data-fx="on"] 下的 CSS 承担，所以关掉开关就是干净的
 * 原版界面；这里的 JS 也就不需要写「卸载」逻辑。
 *
 * 开关：左下角 FX 小按钮，或 Shift+F，或 URL 上带 ?fx=off / ?fx=on。
 * 选择会记进 localStorage；首次访问跟随系统的「减弱动态效果」偏好。
 */
import { state, bus } from './store.js';

const FX_KEY = 'vellum.fx';
const root = document.documentElement;

const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)');
/* 触屏设备没有指针，十字准线和悬停取景框没有意义 */
const FINE_POINTER = window.matchMedia('(hover: hover) and (pointer: fine)');

let enabled = false;

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/* 重新播放一段 CSS 动画：必须先摘掉类并强制重排，否则浏览器认为它没变过 */
function replay(nodes, cls) {
  if (!nodes.length) return;
  for (const n of nodes) n.classList.remove(cls);
  void document.body.offsetWidth;
  for (const n of nodes) n.classList.add(cls);
}

const raf = (fn) => {
  let queued = false;
  let lastArgs = null;
  return (...args) => {
    lastArgs = args;
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      fn(...lastArgs);
    });
  };
};

/* ------------------------------------------------------------------ */
/* 开关                                                                */
/* ------------------------------------------------------------------ */

function resolveInitial() {
  const q = new URLSearchParams(location.search).get('fx');
  if (q === 'off') return false;
  if (q === 'on') return true;
  try {
    const saved = localStorage.getItem(FX_KEY);
    if (saved === 'on') return true;
    if (saved === 'off') return false;
  } catch {
    /* 隐私模式下 localStorage 会抛错，当作没存过 */
  }
  return !REDUCED.matches;
}

function apply(on) {
  enabled = on;
  root.dataset.fx = on ? 'on' : 'off';
  const pill = document.querySelector('.fx-toggle');
  if (pill) {
    pill.setAttribute('aria-pressed', on ? 'true' : 'false');
    pill.title = on ? '特效层已开（Shift+F 关闭）' : '特效层已关（Shift+F 打开）';
  }
  /* 关掉时把指针引导一并收走，别留一条线挂在屏幕上 */
  if (!on) document.querySelector('.fx-cross')?.setAttribute('data-on', 'false');
}

function toggle() {
  const next = !enabled;
  try {
    localStorage.setItem(FX_KEY, next ? 'on' : 'off');
  } catch {
    /* 存不下就算了，本次会话仍然生效 */
  }
  apply(next);
  if (next) {
    /* 刚打开时把已经存在的东西补一次入场，不然要等下一次渲染才看得到 */
    const body = document.querySelector('.pane--list .pane__body');
    if (body) staggerRows(body);
    const host = document.querySelector('.thread');
    if (host) markMessages(host);
  }
}

/* ------------------------------------------------------------------ */
/* 中栏：会话行的错峰入场 + 活动扫光 + 副标题重放                       */
/* ------------------------------------------------------------------ */

/* key -> 那一行的文本指纹。只有文本真的变了才重放动画，
   否则每次有人上下线、每次输入状态刷新，整列都会再动一遍。 */
const rowSigs = new Map();

function staggerRows(body) {
  const rows = [...body.querySelectorAll('.listitem')];
  if (rows.length === 0) {
    rowSigs.clear();
    return;
  }
  const changed = [];
  const next = new Map();
  rows.forEach((row, i) => {
    const key = row.dataset.convId || row.dataset.userId || `#${i}`;
    const sig = row.textContent;
    if (rowSigs.get(key) !== sig) changed.push(row);
    next.set(key, sig);
  });
  rowSigs.clear();
  for (const [k, v] of next) rowSigs.set(k, v);

  changed.forEach((row, i) => row.style.setProperty('--fx-i', String(i)));
  replay(changed, 'fx-row-in');
}

function mountListBody(body) {
  const pass = raf(() => staggerRows(body));
  new MutationObserver(pass).observe(body, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  staggerRows(body);
}

function mountListPane(pane) {
  /* 1px 的活动扫光：贴在搜索栏和列表之间，平时就是一条发丝线 */
  const strip = el('div', 'fx-activity');
  const body = pane.querySelector('.pane__body');
  if (body) pane.insertBefore(strip, body);

  const pulse = (() => {
    let last = 0;
    return () => {
      const now = performance.now();
      if (now - last < 260) return;
      last = now;
      replay([strip], 'fx-on');
    };
  })();

  for (const evt of ['message:added', 'conversations:changed', 'presence:changed', 'ws:message:new']) {
    bus.on(evt, pulse);
  }

  /* 副标题里的数字变了，重放一次擦除动画当作「读数更新」 */
  const head = pane.querySelector('.pane__head');
  if (!head) return;
  let lastSub = '';
  const check = () => {
    const sub = head.querySelector('.pane__sub');
    if (!sub) return;
    if (sub.textContent === lastSub) return;
    lastSub = sub.textContent;
    replay([sub], 'fx-sub-in');
  };
  new MutationObserver(raf(check)).observe(head, { childList: true, subtree: true, characterData: true });
  check();
}

/* ------------------------------------------------------------------ */
/* 消息栏：新消息的方向入场 + 阅读进度                                  */
/* ------------------------------------------------------------------ */


const msgSeen = new Set();

/* 上一次渲染结束时屏幕上那份 .thread__inner。换会话时它就是「旧面板」。 */
let currentInner = null;
let lastConvId = null;
/* 滚动监听实时记一份，只在没有切换快照时当兜底 */
let lastScrollTop = 0;
/*
 * 换会话那一刻，**旧面板**在屏幕上的滚动位置。
 *
 * 必须在 active:changed 时抓：紧接着 renderAll 就会把内容换成新会话的，
 * .thread 的 scrollTop 被夹到新会话的可滚范围里，那个 scroll 事件会顺着
 * 滚动监听把 lastScrollTop 覆盖掉。用被覆盖的值去摆旧面板，它就会从中段
 * 开始显示 —— 表现就是切走的一瞬间，旧会话「自己往上跳了一下」。
 */
let oldScrollAtSwitch = null;
/* 正在等新会话内容到齐的那次切换（见下面的两阶段） */
let pendingSwap = null;
/* 换会话动画进行中：这期间忽略观察者，别把自己搬 DOM 的动作当成新渲染 */
let swapping = false;

/** 这个会话在中栏列表里排第几。用来决定新面板从上面还是下面滑进来 */
function orderOf(conversationId) {
  if (conversationId === null || conversationId === undefined) return -1;
  const rows = document.querySelectorAll('.pane--list .listitem[data-conv-id]');
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i].dataset.convId === String(conversationId)) return i;
  }
  return -1;
}

/** 点的是列表里更靠上的人 → 'up'（画布向下走），否则 'down' */
function swapDir() {
  const prev = orderOf(lastConvId);
  const next = orderOf(state.activeId);
  return prev >= 0 && next >= 0 && next < prev ? 'up' : 'down';
}

/* ------------------------------------------------------------------ */
/* 换会话 = 一条画布在移，分两阶段                                      */
/* ------------------------------------------------------------------ */
/*
 * 之所以要分两段：切到没缓存过的会话时，open() 会先往 .thread 里塞一屏
 * 骨架屏（灰块），等接口回来才换成真消息。如果只在真消息到齐时才建画布，
 * 中间那段时间屏幕上就是「旧会话消失 → 灰块闪一下 → 新会话滑进来」。
 *
 *   阶段一：骨架屏出现，立刻把旧面板挂进画布顶住，静止不动
 *   阶段二：真消息到齐，把新面板接到画布另一头，整体滑一屏
 *
 * 会话已经缓存时（大多数切换）两段在同一个微任务里跑完，中间没有任何绘制。
 */

function startSwap(host, oldInner, dir) {
  const pane = document.querySelector('.pane--thread');
  if (!pane || !oldInner) return null;

  const slotH = Math.max(host.clientHeight, 160);
  const stage = el('div', 'fx-stage');
  stage.style.top = `${host.offsetTop}px`;
  stage.style.height = `${slotH}px`;
  stage.style.width = `${host.clientWidth}px`;
  /* 走一屏的距离用变量传进去，关键帧里不用百分比也不用固定值 */
  stage.style.setProperty('--fx-reel-h', `${slotH}px`);

  /* 用 keyframes 而不是 transition：reel 是刚插进来的新元素，
     transition 拿不到「变化前」的样式，会直接瞬移到位。 */
  const reel = el('div', 'fx-reel');
  const slotOld = el('div', 'fx-slot');
  slotOld.style.height = `${slotH}px`;
  slotOld.appendChild(oldInner);

  /* 残影里的视频/语音不该继续出声 */
  for (const m of oldInner.querySelectorAll('video, audio')) {
    try {
      m.pause();
      m.muted = true;
    } catch {
      /* 有些浏览器对未加载的媒体会抛错，忽略 */
    }
  }

  reel.appendChild(slotOld);
  stage.appendChild(reel);
  pane.appendChild(stage);

  /* 旧面板留在它原来的阅读位置 */
  const oldScroll = oldScrollAtSwitch ?? lastScrollTop;
  const oldMax = Math.max(0, slotOld.scrollHeight - slotOld.clientHeight);
  slotOld.scrollTop = Math.min(Math.max(0, oldScroll), oldMax);

  return { host, oldInner, dir, stage, reel, slotOld, slotH };
}

function completeSwap(pending, newInner) {
  const { host, dir, stage, reel, slotOld, slotH } = pending;
  const newH = newInner.offsetHeight;

  /*
   * 占位块的高度必须等于**新面板**。
   *
   * 应用在这次切换里要滚到的是新会话的底部；新面板被搬进画布之后 .thread
   * 会变成空容器，scrollHeight 塌掉，open() 里那次 scrollToBottom 就落空了。
   * 用等高的占位块顶住，滚动几何全程不变。
   *
   * 千万别「补偿成旧面板的高度」——那会把 .thread 的可滚范围先压小，
   * scrollToBottom 被夹到一个小值，等真面板放回来视线就停在很靠上的位置。
   */
  const spacer = el('div', 'fx-spacer');
  spacer.style.height = `${newH}px`;
  host.appendChild(spacer);
  pending.spacer = spacer;

  const slotNew = el('div', 'fx-slot');
  slotNew.style.height = `${slotH}px`;
  slotNew.appendChild(newInner);

  /*
   * 上面那块在前时，画布停在 0 展示的是新面板；否则停在 0 展示的是旧面板。
   *
   * 这里**只把新面板插进去，绝不动 slotOld**：元素一旦被摘出文档
   * （比如用 replaceChildren 重排），滚动位置会被清零，旧面板就会从顶部
   * 开始显示 —— 那正是「旧会话在切换瞬间自己往上跳了一下」。
   */
  if (dir === 'up') reel.insertBefore(slotNew, slotOld);
  else reel.appendChild(slotNew);

  const bottom = (slot) => Math.max(0, slot.scrollHeight - slot.clientHeight);
  slotNew.scrollTop = bottom(slotNew);

  /*
   * 把 .thread 的滚动**瞬时**顶到新会话底部。
   *
   * open() 里那次 scrollToBottom 走的是 .thread 上的 scroll-behavior: smooth，
   * 是几百毫秒的异步滚动，和面板滑动差不多长。不同步顶住的话，动画落地那一刻
   * .thread 还没滚完，真面板接回来后它继续滚 —— 看着就是「面板已就位，内容
   * 又自己往上拉一下」。面板滑动已经是转场了，不需要再叠一层内部滚动。
   *
   * 瞬时赋值要先把 scroll-behavior 压成 auto，否则赋值本身又走平滑。
   */
  const prevBehavior = host.style.scrollBehavior;
  host.style.scrollBehavior = 'auto';
  /* 各用各的上限：占位块和真面板算出来的可滚高度可能差几个像素 */
  host.scrollTop = Math.max(0, host.scrollHeight - host.clientHeight);
  host.style.scrollBehavior = prevBehavior;

  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    swapping = false;
    cancelAnimationFrame(pending.mirrorId);
    /* 先把占位块和旧 inner 撤掉，再把真面板放回同一位置。
       同一次同步执行里完成，scrollHeight 不变，滚动位置不会跳。 */
    spacer.remove();
    for (const n of host.querySelectorAll(':scope > .thread__inner')) n.remove();
    host.appendChild(newInner);
    stage.remove();
    currentInner = newInner;
    lastConvId = state.activeId;
    markMessages(host);
    updateProgress();
  };
  pending.finish = finish;

  /*
   * 滑动期间持续把 .thread 的滚动位置镜像进新面板：正常情况下两边已经一致、
   * 是个空转；但从搜索结果跳转（jumpToMessage）会在滑动中途改 .thread 的滚动，
   * 镜像一下那块面板就会跟着走到目标消息，落地时不跳。
   */
  const maxNew = bottom(slotNew);
  const mirror = () => {
    if (done) return;
    slotNew.scrollTop = Math.min(host.scrollTop, maxNew);
    pending.mirrorId = requestAnimationFrame(mirror);
  };
  pending.mirrorId = requestAnimationFrame(mirror);

  swapping = true;
  /* 挂上方向才触发动画：阶段一没有这个属性，画布静止 */
  reel.dataset.dir = dir;

  reel.addEventListener('animationend', (e) => {
    if (e.target === reel) finish();
  });
  /* 过渡被打断（切标签页、动画被系统关掉）时的兜底 */
  setTimeout(finish, 2000);
}

function markMessages(host) {
  const inner = host.querySelector('.thread__inner');
  const nodes = [...host.querySelectorAll('.msg[data-msg-id]')];

  if (nodes.length === 0) {
    /*
     * 内容还在路上：open() 先塞了一屏骨架屏。
     * 这时候把旧面板挂到画布上顶着，别让灰块闪出来。
     */
    if (host.querySelector('.skeleton') && enabled && currentInner && !currentInner.isConnected) {
      pendingSwap = startSwap(host, currentInner, swapDir());
    } else if (!host.querySelector('.skeleton')) {
      /* 真正的空状态（这个会话还没聊过）才把记录清掉 */
      currentInner = null;
    }
    msgSeen.clear();
    lastConvId = state.activeId;
    oldScrollAtSwitch = null;
    return;
  }

  /* 整屏都是没见过的 id ⇒ 换了会话，之前的记录作废 */
  let overlap = false;
  for (const n of nodes) {
    if (msgSeen.has(n.dataset.msgId)) {
      overlap = true;
      break;
    }
  }
  const switched = !overlap;
  if (switched) msgSeen.clear();
  for (const n of nodes) msgSeen.add(n.dataset.msgId);

  if (switched && enabled && currentInner && !currentInner.isConnected) {
    /* 会话是缓存过的：两阶段在同一个微任务里跑完，中间没有绘制 */
    const pending = startSwap(host, currentInner, swapDir());
    if (pending) completeSwap(pending, inner);
  }

  /* 逐条消息不再做错峰入场：整块面板已经在滑了，再叠一层淡入只会看起来在闪。
     真正新到的消息由 thread.js 打的 .msg--enter 负责。 */
  if (!swapping) currentInner = inner;
  lastConvId = state.activeId;
  /* 这一轮用不到就丢掉，免得留到下一次切换变成过期值 */
  oldScrollAtSwitch = null;
}

function mountThread(host) {
  /*
   * 同步处理，不排到下一帧。
   *
   * renderAll 一执行，.thread 里就已经是新会话的内容（scrollTop 还被夹在
   * 新会话的范围里）。观察者回调是微任务，能保证在同一次绘制前把画布盖上；
   * 再往后拖一帧就存在「新内容已经画出来、画布还没盖上」的窗口 —— 那就是
   * 偶尔闪一下的来源。
   */
  new MutationObserver(() => {
    /* 阶段一已经挂上画布了：等真消息到齐就跑阶段二 */
    if (pendingSwap) {
      const inner = host.querySelector('.thread__inner');
      if (inner && inner.querySelector('.msg[data-msg-id]')) {
        const p = pendingSwap;
        pendingSwap = null;
        completeSwap(p, inner);
      }
      return;
    }
    if (swapping) return;
    markMessages(host);
    updateProgress();
  }).observe(host, { childList: true, subtree: true });

  host.addEventListener(
    'scroll',
    () => {
      /* 同步记一份，切换时万一没有快照可以退回它 */
      if (!swapping) lastScrollTop = host.scrollTop;
    },
    { passive: true },
  );
  host.addEventListener('scroll', raf(updateProgress), { passive: true });
}

let progressEl = null;
let threadHost = null;
/* 整个聊天窗口（含标题栏和输入区）。十字准线要铺满这一块，而不是只铺消息区 */
let threadPaneEl = null;

function updateProgress() {
  if (!progressEl || !threadHost) return;
  const max = threadHost.scrollHeight - threadHost.clientHeight;
  if (max <= 4) {
    progressEl.dataset.idle = 'true';
    progressEl.style.transform = 'scaleX(1)';
    return;
  }
  progressEl.dataset.idle = 'false';
  const p = Math.min(1, Math.max(0, threadHost.scrollTop / max));
  progressEl.style.transform = `scaleX(${p.toFixed(4)})`;
}

function mountThreadPane(pane) {
  threadPaneEl = pane;
  progressEl = el('i', 'fx-progress');
  progressEl.dataset.idle = 'true';
  pane.appendChild(progressEl);
}

/* ------------------------------------------------------------------ */
/* 消息栏头部：实时钟 + 连接状态                                        */
/* ------------------------------------------------------------------ */

function paintClock() {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  const text = `${hh}:${mm}:${ss}`;
  /* 只有「在线」才算亮，其余状态一律当异常处理 */
  const ok = state.connection === 'online';
  for (const clock of document.querySelectorAll('.fx-clock')) {
    const t = clock.querySelector('.fx-clock__time');
    const d = clock.querySelector('.fx-clock__dot');
    if (t && t.textContent !== text) t.textContent = text;
    if (d) d.dataset.state = ok ? 'on' : 'off';
  }
}

function ensureClock(head) {
  const existing = head.querySelector('.fx-clock');
  /* 没选中会话时头部是空的，这时候挂一个钟只会显得莫名其妙 */
  if (!head.querySelector('.pane__head-main')) {
    existing?.remove();
    return;
  }
  if (existing) return;
  const clock = el('div', 'fx-clock');
  clock.append(el('i', 'fx-clock__dot'), el('span', 'fx-clock__time'));
  const actions = head.querySelector('.pane__head-actions');
  if (actions) head.insertBefore(clock, actions);
  else head.appendChild(clock);
  paintClock();
}

function mountThreadHead(head) {
  new MutationObserver(raf(() => ensureClock(head))).observe(head, { childList: true, subtree: true });
  ensureClock(head);
}

/* ------------------------------------------------------------------ */
/* 左栏：导航滑块、竖排字标、FX 开关                                    */
/* ------------------------------------------------------------------ */

let railTick = null;
let railHost = null;

function placeRailTick(instant = false) {
  if (!railTick || !railHost || !railTick.isConnected) return;
  const active = railHost.querySelector('.rail-btn[aria-current="true"]');
  if (!active) {
    railTick.style.opacity = '0';
    return;
  }
  const rr = railHost.getBoundingClientRect();
  const ar = active.getBoundingClientRect();
  if (ar.width === 0 || ar.height === 0) {
    railTick.style.opacity = '0';
    return;
  }
  if (instant) railTick.style.transition = 'none';
  /* 窄屏左栏变成底部横条，滑块跟着躺下 */
  const horizontal = getComputedStyle(railHost).flexDirection === 'row';
  if (horizontal) {
    railTick.style.width = `${ar.width}px`;
    railTick.style.height = '2px';
    railTick.style.transform = `translate3d(${ar.left - rr.left}px, 0, 0)`;
  } else {
    railTick.style.width = '2px';
    railTick.style.height = `${ar.height}px`;
    railTick.style.transform = `translate3d(0, ${ar.top - rr.top}px, 0)`;
  }
  railTick.style.opacity = '1';
  if (instant) requestAnimationFrame(() => { railTick.style.transition = ''; });
}

function mountRail(rail) {
  railHost = rail;

  railTick = el('i', 'fx-rail-tick');
  rail.appendChild(railTick);

  /* 竖排字标：把左栏下段那块一直空着的地方用起来 */
  const wordmark = el('div', 'fx-wordmark', 'VELLUM');
  const foot = rail.querySelector('.rail__foot');

  /* FX 开关。决定采用这套风格之后这一块可以直接删掉。 */
  const pill = el('button', 'fx-toggle');
  pill.type = 'button';
  pill.append(el('span', 'fx-toggle__dot'), el('span', null, 'FX'));
  pill.addEventListener('click', toggle);

  rail.insertBefore(wordmark, foot);
  rail.insertBefore(pill, foot);

  new MutationObserver(() => placeRailTick()).observe(rail, {
    subtree: true,
    attributes: true,
    attributeFilter: ['aria-current'],
  });
  /* 布局稳定之后再量一次，首帧字体/滚动条宽度都还没定下来 */
  requestAnimationFrame(() => placeRailTick(true));
  setTimeout(() => placeRailTick(true), 320);
}

/* ------------------------------------------------------------------ */
/* 输入区：打字电平条 + 发送爆点                                        */
/* ------------------------------------------------------------------ */

function burst(anchor) {
  if (!anchor || !enabled) return;
  const r = anchor.getBoundingClientRect();
  for (const extra of ['', ' fx-burst--2']) {
    const b = el('div', `fx-burst${extra}`);
    b.style.left = `${r.left + r.width / 2}px`;
    b.style.top = `${r.top + r.height / 2}px`;
    document.body.appendChild(b);
    b.addEventListener('animationend', () => b.remove(), { once: true });
    /* 动画被减弱动态压成 1ms 时也要有人收拾 */
    setTimeout(() => b.remove(), 1200);
  }
}

function mountComposer(composer) {
  const foot = composer.querySelector('.composer__foot');
  const input = composer.querySelector('.composer__input');
  const send = composer.querySelector('.composer__tools:last-of-type .icon-btn');
  if (!foot || !input) return;

  /* 电平条：静止时几乎看不见，敲键盘才跳起来 */
  const eq = el('div', 'fx-eq');
  const bars = Array.from({ length: 5 }, () => {
    const b = el('i');
    eq.appendChild(b);
    return b;
  });
  foot.insertBefore(eq, foot.children[1] ?? null);

  const level = bars.map(() => 0);
  let rafId = 0;
  const decay = () => {
    let alive = false;
    bars.forEach((b, i) => {
      level[i] *= 0.85;
      if (level[i] > 0.02) alive = true;
      b.style.height = `${Math.max(level[i], 0.09) * 0.85}rem`;
    });
    if (alive) {
      rafId = requestAnimationFrame(decay);
    } else {
      rafId = 0;
      eq.dataset.hot = 'false';
    }
  };
  const kick = () => {
    eq.dataset.hot = 'true';
    for (let i = 0; i < level.length; i += 1) level[i] = 0.32 + Math.random() * 0.68;
    if (!rafId) rafId = requestAnimationFrame(decay);
  };

  input.addEventListener('input', kick);
  input.addEventListener('keydown', (e) => {
    if (e.key.length === 1 || e.key === 'Backspace' || e.key === 'Enter') kick();
  });

  /* 发送成功的判断：一小会儿之后输入框被清空了，就说明真发出去了 */
  const maybeBurst = () => {
    const had = input.value.trim().length > 0 || Boolean(composer.querySelector('.attach-chip'));
    if (!had) return;
    setTimeout(() => {
      if (input.value.trim().length === 0) burst(send);
    }, 170);
  };
  send?.addEventListener('click', maybeBurst);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) maybeBurst();
  });
}

/* ------------------------------------------------------------------ */
/* 坐标十字线                                                          */
/* ------------------------------------------------------------------ */

function mountCrosshair() {
  if (!FINE_POINTER.matches) return;
  const cross = el('div', 'fx-cross');
  cross.setAttribute('aria-hidden', 'true');
  const h = el('i', 'fx-cross__h');
  const v = el('i', 'fx-cross__v');
  const read = el('span', 'fx-cross__read');
  cross.append(h, v, read);
  document.body.appendChild(cross);

  const move = raf((x, y) => {
    const host = threadPaneEl;
    if (!host || !host.isConnected) return;
    const r = host.getBoundingClientRect();
    const inside = x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    if (!inside) {
      cross.dataset.on = 'false';
      return;
    }
    cross.style.setProperty('--fx-x', `${Math.round(x)}px`);
    cross.style.setProperty('--fx-y', `${Math.round(y)}px`);
    cross.style.setProperty('--fx-left', `${Math.round(r.left)}px`);
    cross.style.setProperty('--fx-top', `${Math.round(r.top)}px`);
    cross.style.setProperty('--fx-width', `${Math.round(r.width)}px`);
    cross.style.setProperty('--fx-height', `${Math.round(r.height)}px`);
    read.textContent = `X ${String(Math.round(x - r.left)).padStart(4, '0')}  Y ${String(
      Math.round(y - r.top),
    ).padStart(4, '0')}`;
    cross.dataset.on = 'true';
  });

  window.addEventListener(
    'pointermove',
    (e) => {
      if (!enabled || e.pointerType !== 'mouse') return;
      move(e.clientX, e.clientY);
    },
    { passive: true },
  );
  window.addEventListener('pointerdown', () => { cross.dataset.on = 'false'; }, { passive: true });
}

/* ------------------------------------------------------------------ */
/* 装配                                                                */
/* ------------------------------------------------------------------ */

const mounted = new Map();

/** 元素换了（登出再登录会整块重建）就重新挂一次 */
function need(name, node) {
  if (!node) return false;
  const current = mounted.get(name);
  if (current === node && node.isConnected) return false;
  mounted.set(name, node);
  return true;
}

function tryMountShell() {
  const rail = document.querySelector('.rail');
  if (need('rail', rail)) mountRail(rail);

  const listPane = document.querySelector('.pane--list');
  if (need('listPane', listPane)) mountListPane(listPane);

  const listBody = document.querySelector('.pane--list .pane__body');
  if (need('listBody', listBody)) mountListBody(listBody);

  const thread = document.querySelector('.thread');
  if (need('thread', thread)) {
    threadHost = thread;
    mountThread(thread);
  }

  const threadPane = document.querySelector('.pane--thread');
  if (need('threadPane', threadPane)) mountThreadPane(threadPane);

  const threadHead = document.querySelector('.pane--thread .pane__head');
  if (need('threadHead', threadHead)) mountThreadHead(threadHead);

  const composer = document.querySelector('.composer');
  if (need('composer', composer)) mountComposer(composer);

  placeRailTick();
  updateProgress();
}

export function installFx() {
  apply(resolveInitial());

  /* 应用外壳是登录之后才建出来的，所以盯着 #app 的直接子节点变化 */
  const app = document.getElementById('app');
  if (app) {
    new MutationObserver(() => tryMountShell()).observe(app, { childList: true });
  }
  tryMountShell();

  /* 动画跑完就把类摘掉，免得几十个 animation-fill-mode 长期挂着 */
  document.addEventListener(
    'animationend',
    (e) => {
      const t = e.target;
      if (!t?.classList || e.pseudoElement) return;
      if (t.classList.contains('fx-row-in')) t.classList.remove('fx-row-in');
    },
    true,
  );

  mountCrosshair();

  /* .thread 马上要被新会话的内容替换掉，趁这一瞬间记下旧面板滚到哪了 */
  bus.on('active:changed', () => {
    if (threadHost) {
      oldScrollAtSwitch = threadHost.scrollTop;
      lastScrollTop = threadHost.scrollTop;
    }
  });

  /* 窗口尺寸变了要重新量导航滑块 */
  window.addEventListener('resize', raf(placeRailTick), { passive: true });

  /* 实时钟 */
  setInterval(paintClock, 1000);
  bus.on('connection:changed', paintClock);

  /* Shift+F 切换。输入框里按 Shift+F 是在打大写字母，不能被吃掉 */
  window.addEventListener('keydown', (e) => {
    if (!e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key.toLowerCase() !== 'f') return;
    const a = document.activeElement;
    const typing =
      a instanceof HTMLInputElement ||
      a instanceof HTMLTextAreaElement ||
      a?.isContentEditable === true;
    if (typing) return;
    e.preventDefault();
    toggle();
  });

  return { toggle, get enabled() { return enabled; } };
}
