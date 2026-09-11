/**
 * 消息流。
 *
 * 关键实现取舍：不做「每次变动都整段重渲染」。消息节点按 id 缓存，
 * 新消息只 append，编辑/撤回只替换那一个节点。这样滚动位置天然稳定，
 * 长会话也不会因为一次推送就重排几百个节点。
 */
import { h, fill, copyText, toast, isNearBottom, scrollToBottom, nextFrame } from '../dom.js';
import { icon } from '../icon.js';
import { api } from '../api.js';
import { state, bus, messagesOf, upsertMessage, setMessages, userName, typingUsers } from '../store.js';
import {
  timeShort,
  timeFull,
  timeAgo,
  dayLabel,
  duration,
  bytes,
  fileIconName,
  toneFor,
} from '../format.js';
import { avatarNode, paneHead, iconButton, emptyState, skeletonRows } from './parts.js';
import { openMenu, openLightbox, confirmDialog } from '../overlays.js';
import { openForwardPicker } from './dialogs.js';
import { sendRead, sendTyping } from '../socket.js';

const GROUP_WINDOW_MS = 5 * 60_000;
const PAGE_SIZE = 50;

/** 全局只允许一个音频在播 */
let currentAudio = null;
const stopCurrentAudio = () => {
  if (currentAudio) {
    try {
      currentAudio.pause();
    } catch {
      /* 已经停了 */
    }
    currentAudio = null;
  }
};

/**
 * @param {HTMLElement} headHost
 * @param {HTMLElement} scrollHost
 * @param {HTMLElement} footHost
 * @param {{
 *   onBack: () => void,
 *   onOpenProfile: () => void,
 *   onOpenMembers: () => void,
 *   onStartChatWith: (userId: number) => void,
 *   replyTarget: object|null,
 *   onReply: (msg: object) => void,
 *   onCancelReply: () => void,
 *   onEdit: (msg: object) => void,
 * }} handlers
 */
export function createThread(headHost, scrollHost, footHost, handlers) {
  /** @type {Map<number, HTMLElement>} */
  const nodes = new Map();
  let inner = null;
  let jumpBtn = null;
  let loadingOlder = false;
  let activeId = null;
  let lastDayKey = null;
  let composing = false;

  const editing = { id: null };

  /* ------------------------------------------------------------------ */
  /* 头像 / 头部                                                         */
  /* ------------------------------------------------------------------ */

  function renderHead() {
    const conv = activeId ? state.conversations.get(activeId) : null;
    if (!conv) {
      fill(headHost);
      return;
    }

    const typing = typingUsers(conv.id);
    let sub;
    if (typing.length) {
      sub = typing.length === 1 ? `${userName(typing[0])} 正在输入` : `${typing.length} 人正在输入`;
    } else if (conv.type === 'group') {
      const online = (conv.members || []).filter((m) => m.id !== state.me.id && state.presence.has(m.id)).length;
      sub = `${conv.memberCount} 位成员${online ? ` · ${online} 人在线` : ''}`;
    } else if (conv.peer) {
      sub = state.presence.has(conv.peer.id) ? '在线' : timeAgo(conv.peer.lastSeenAt);
    } else {
      sub = '私聊';
    }

    const backBtn = iconButton('caret-left', { label: '返回会话列表', onClick: handlers.onBack });
    backBtn.classList.add('thread-back');

    const moreBtn = iconButton('dots-three-vertical', { label: '更多操作' });
    moreBtn.addEventListener('click', () => {
      if (conv.type === 'group') {
        openMenu({
          anchor: moreBtn,
          items: [
            { label: '群成员', icon: 'users-three', onClick: handlers.onOpenMembers },
            { label: '群资料', icon: 'info', onClick: handlers.onOpenProfile },
            { separator: true },
            {
              label: conv.muted ? '取消静音' : '静音通知',
              icon: conv.muted ? 'bell' : 'bell-slash',
              onClick: () => toggleMute(conv),
            },
            { separator: true },
            {
              label: '退出群聊',
              icon: 'sign-out',
              danger: true,
              onClick: () => leaveGroup(conv),
            },
          ],
        });
        return;
      }
      openMenu({
        anchor: moreBtn,
        items: [
          { label: '查看资料', icon: 'user', onClick: handlers.onOpenProfile },
          { separator: true },
          {
            label: conv.muted ? '取消静音' : '静音通知',
            icon: conv.muted ? 'bell' : 'bell-slash',
            onClick: () => toggleMute(conv),
          },
          {
            label: '从列表移除',
            icon: 'trash',
            danger: true,
            onClick: async () => {
              const ok = await confirmDialog({
                title: `从列表移除「${conv.title}」？`,
                desc: '对方不会收到通知，历史消息仍然保留。他再发消息给你时，会话会重新出现。',
                confirmLabel: '移除',
                danger: true,
              });
              if (!ok) return;
              try {
                await api.hideConversation(conv.id);
                bus.emit('conversation:removed', conv.id);
                handlers.onBack();
              } catch (err) {
                toast(err.message, { tone: 'error' });
              }
            },
          },
        ],
      });
    });

    const headAvatar = conv.type === 'group'
      ? h(
          'span.avatar.avatar--sm',
          { 'aria-hidden': 'true' },
          conv.avatarUrl
            ? h('img', { src: conv.avatarUrl, alt: '' })
            : h('span', (conv.title || '#')[0]),
        )
      : avatarNode(conv.peer, { size: 'sm' });

    fill(
      headHost,
      ...paneHead({
        leading: backBtn,
        title: conv.title,
        sub,
        actions: [
          conv.type === 'group'
            ? iconButton('users-three', { label: '群成员', onClick: handlers.onOpenMembers })
            : null,
          moreBtn,
        ].filter(Boolean),
      }),
    );
  }

  async function toggleMute(conv) {
    try {
      const res = await api.muteConversation(conv.id, !conv.muted);
      conv.muted = res.muted;
      bus.emit('conversation:changed', conv);
      bus.emit('conversations:changed');
      toast(res.muted ? '已静音，不再计入未读' : '已取消静音', { tone: 'ok' });
    } catch (err) {
      toast(err.message, { tone: 'error' });
    }
  }

  async function leaveGroup(conv) {
    const ok = await confirmDialog({
      title: `退出「${conv.title}」？`,
      desc: '退出后不再收到这个群的消息。历史记录保留在本机，但不会再更新。',
      confirmLabel: '退出群聊',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.leaveConversation(conv.id);
      bus.emit('conversation:removed', conv.id);
      handlers.onBack();
      toast('已退出群聊', { tone: 'ok' });
    } catch (err) {
      toast(err.message, { tone: 'error' });
    }
  }

  /* ------------------------------------------------------------------ */
  /* 消息节点                                                            */
  /* ------------------------------------------------------------------ */

  function dayKeyOf(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  }

  /** 判断是否延续上一条（同一人、时间接近、同一天、都不是系统消息） */
  function isContinued(prev, msg) {
    if (!prev || !msg) return false;
    if (prev.kind === 'system' || msg.kind === 'system') return false;
    if (prev.sender?.id !== msg.sender?.id) return false;
    if (dayKeyOf(prev.createdAt) !== dayKeyOf(msg.createdAt)) return false;
    return msg.createdAt - prev.createdAt < GROUP_WINDOW_MS;
  }

  function quoteNode(reply, onJump) {
    if (!reply) return null;
    const preview =
      reply.kind === 'image'
        ? '[图片]'
        : reply.kind === 'audio'
          ? '[语音]'
          : reply.kind === 'video'
            ? '[视频]'
            : reply.kind === 'file'
              ? `[文件] ${reply.file?.name || ''}`
              : (reply.body || '').slice(0, 120);
    return h(
      'div.quote.quote--clickable',
      {
        role: 'button',
        tabIndex: 0,
        title: '跳到这条消息',
        onClick: (e) => {
          e.stopPropagation();
          onJump(reply.id);
        },
        onKeydown: (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onJump(reply.id);
          }
        },
      },
      h(
        'div',
        { style: { minWidth: '0' } },
        h('span.quote__who', userName(reply.sender?.id)),
        h('span.quote__text', preview),
      ),
    );
  }

  function imageNode(file, msg) {
    const ratio = file.width && file.height ? file.width / file.height : 4 / 3;
    const wide = ratio > 1.15;
    const box = h(
      `button.msg__image${!wide ? '.msg__image--tall' : ''}`,
      {
        type: 'button',
        'aria-label': `查看图片 ${file.name}`,
        style: { aspectRatio: `${file.width || 4} / ${file.height || 3}` },
      },
      h('img', {
        src: file.url,
        alt: file.name,
        loading: 'lazy',
        decoding: 'async',
        onLoad: (e) => {
          e.target.style.opacity = '1';
        },
        style: { opacity: '0', transition: 'opacity 180ms ease' },
      }),
    );
    box.addEventListener('click', () =>
      openLightbox({ file, senderName: userName(msg.sender?.id), createdAt: msg.createdAt }),
    );
    return box;
  }

  function audioNode(file, msg) {
    const wave = msg.meta?.waveform;
    const ms = msg.meta?.durationMs || file.durationMs || 0;

    const audio = h('audio', { src: file.url, preload: 'metadata' });
    const btn = h('button.audio-msg__btn', { type: 'button', 'aria-label': '播放语音' }, icon('play', { size: 16 }));
    const timeEl = h('span.audio-msg__time', duration(ms));

    let bars = null;
    if (Array.isArray(wave) && wave.length) {
      bars = wave.map((v) =>
        h('i.audio-msg__bar', {
          style: { height: `${Math.max(8, Math.round(v * 100))}%` },
        }),
      );
    }

    const mid = h(
      'div.audio-msg__mid',
      bars
        ? h('div.audio-msg__wave', { role: 'presentation' }, ...bars)
        : h('div', h('span.audio-msg__time', '点击播放')),
      h('div', { style: { display: 'flex', justifyContent: 'space-between' } }, timeEl),
    );

    const paint = () => {
      const p = audio.duration ? audio.currentTime / audio.duration : 0;
      if (bars) {
        const upto = Math.round(p * bars.length);
        bars.forEach((b, i) => b.classList.toggle('audio-msg__bar--played', i < upto));
      }
      timeEl.textContent =
        audio.currentTime > 0 ? `${duration(audio.currentTime * 1000)} / ${duration(ms)}` : duration(ms);
    };

    btn.addEventListener('click', () => {
      if (audio.paused) {
        stopCurrentAudio();
        currentAudio = audio;
        audio.play().catch(() => toast('播放失败，可能是格式不被浏览器支持', { tone: 'error' }));
      } else {
        audio.pause();
      }
    });

    if (bars) {
      mid.querySelector('.audio-msg__wave').addEventListener('click', (e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
        if (audio.duration) {
          audio.currentTime = ratio * audio.duration;
          paint();
        }
      });
    }

    audio.addEventListener('play', () => {
      fill(btn, icon('pause', { size: 16 }));
      btn.setAttribute('aria-label', '暂停');
    });
    audio.addEventListener('pause', () => {
      fill(btn, icon('play', { size: 16 }));
      btn.setAttribute('aria-label', '播放');
    });
    audio.addEventListener('ended', () => {
      audio.currentTime = 0;
      paint();
    });
    audio.addEventListener('timeupdate', paint);
    audio.addEventListener('loadedmetadata', () => {
      if (!ms) timeEl.textContent = duration(audio.duration * 1000);
    });
    audio.addEventListener('error', () => {
      // 浏览器解不了这个编码时，退回原生控件，至少让人能听
      const fallback = h('audio.audio-plain', { src: file.url, controls: true, preload: 'metadata' });
      fill(mid.parentElement, fallback);
    });

    return h('div.audio-msg', btn, mid);
  }

  function fileNode(file) {
    return h(
      'div.file-msg',
      h('span.file-msg__icon', icon(fileIconName(file.mime, file.name), { size: 20 })),
      h(
        'div.file-msg__main',
        h('div.file-msg__name', { title: file.name }, file.name),
        h('div.file-msg__meta', bytes(file.size)),
      ),
      h(
        'a.icon-btn',
        {
          href: `${file.url}?download=1`,
          download: file.name,
          'aria-label': `下载 ${file.name}`,
          title: '下载',
        },
        icon('download-simple', { size: 17 }),
      ),
    );
  }

  function messageTools(msg, conv) {
    const items = [];
    items.push({ label: '回复', icon: 'arrow-bend-up-left', onClick: () => handlers.onReply(msg) });
    if (msg.kind === 'text') {
      items.push({
        label: '复制文字',
        icon: 'copy',
        onClick: async () => {
          const ok = await copyText(msg.body || '');
          toast(ok ? '已复制' : '复制失败，请手动选中', { tone: ok ? 'ok' : 'error' });
        },
      });
    }
    items.push({
      label: '转发',
      icon: 'paper-plane-tilt',
      onClick: () => openForwardPicker(msg),
    });

    if (msg.sender?.id === state.me?.id && msg.kind === 'text') {
      items.push({
        label: '编辑',
        icon: 'pencil-simple',
        onClick: () => handlers.onEdit(msg),
      });
    }
    if (msg.sender?.id === state.me?.id) {
      const withinWindow =
        !state.config?.recallWindowSeconds ||
        Date.now() - msg.createdAt < state.config.recallWindowSeconds * 1000;
      items.push({ separator: true });
      items.push({
        label: withinWindow ? '撤回' : `超过 ${state.config?.recallWindowSeconds || 0} 秒，不能撤回`,
        icon: 'arrow-clockwise',
        danger: withinWindow,
        disabled: !withinWindow,
        onClick: () => recall(msg),
      });
    }
    void conv;
    return items;
  }

  async function recall(msg) {
    const ok = await confirmDialog({
      title: '撤回这条消息？',
      desc: '对方那里会显示「此消息已撤回」，内容不会被保留。',
      confirmLabel: '撤回',
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await api.recallMessage(msg.id);
      upsertMessage(res.message);
    } catch (err) {
      toast(err.message, { tone: 'error' });
    }
  }

  function jumpTo(messageId) {
    const node = nodes.get(messageId);
    if (!node) {
      toast('这条消息在当前范围内找不到', { tone: 'error' });
      return;
    }
    node.scrollIntoView({ block: 'center', behavior: 'smooth' });
    node.classList.remove('msg--flash');
    void node.offsetWidth; // 重启动画
    node.classList.add('msg--flash');
    setTimeout(() => node.classList.remove('msg--flash'), 1800);
  }

  function messageNode(msg, prev) {
    /* 系统消息 */
    if (msg.kind === 'system') {
      return h('div.sysmsg', msg.body);
    }

    const mine = msg.sender?.id === state.me?.id;
    const conv = state.conversations.get(msg.conversationId);
    const cont = isContinued(prev, msg);

    const tools = h('div.msg__tools');
    const toolBtn = h(
      'button.icon-btn.icon-btn--sm',
      {
        type: 'button',
        'aria-label': '消息操作',
        onClick: (e) => {
          e.stopPropagation();
          openMenu({ anchor: toolBtn, items: messageTools(msg, conv) });
        },
      },
      icon('dots-three', { size: 14 }),
    );
    tools.appendChild(toolBtn);

    /* 正文 */
    let body;
    if (msg.kind === 'deleted') {
      body = h('div.msg__body', '此消息已撤回');
    } else if (msg.kind === 'image') {
      body = h(
        'div.msg__body',
        { style: { padding: '0', border: 'none', background: 'none' } },
        imageNode(msg.file, msg),
        msg.body ? h('div', { style: { marginTop: 'var(--s2)' } }, msg.body) : null,
      );
    } else if (msg.kind === 'audio') {
      body = h('div.msg__body', { style: { padding: 'var(--s1) var(--s2)' } }, audioNode(msg.file, msg));
    } else if (msg.kind === 'video') {
      body = h(
        'div.msg__body',
        { style: { padding: '0', border: 'none', background: 'none' } },
        h('video.msg__video', {
          src: msg.file.url,
          controls: true,
          preload: 'metadata',
          playsInline: true,
        }),
        msg.body ? h('div', { style: { marginTop: 'var(--s2)' } }, msg.body) : null,
      );
    } else if (msg.kind === 'file') {
      body = h('div.msg__body', { style: { padding: 'var(--s1) var(--s3)' } }, fileNode(msg.file));
    } else {
      body = h('div.msg__body', msg.body);
    }

    /* 状态行：我发的消息显示送达/已读 */
    let status = null;
    if (mine && msg.kind !== 'system') {
      if (msg.kind === 'file' || msg.kind === 'image' || msg.kind === 'video' || msg.kind === 'audio') {
        // 媒体消息的状态显示在气泡下方
      }
      const read = (conv?.peerReadMessageId || 0) >= msg.id;
      status = h(
        'div.msg__status',
        icon(read ? 'checks' : 'check', { size: 13 }),
        h('span', read ? '已读' : '已送达'),
        msg.editedAt ? h('span', '· 已编辑') : null,
      );
    }

    const header =
      cont || msg.kind === 'deleted'
        ? null
        : h(
            'div.msg__name',
            h('b', mine ? '我' : userName(msg.sender?.id)),
            h('span', timeShort(msg.createdAt)),
          );

    const node = h(
      `div.msg${mine ? '.msg--mine' : ''}${cont ? '.msg--cont' : ''}${msg.kind === 'deleted' ? '.msg--deleted' : ''}`,
      { dataset: { msgId: String(msg.id) } },
      h('div.msg__gutter', avatarNode(msg.sender, { size: 'sm', showPresence: false })),
      h(
        'div.msg__col',
        header,
        h(
          'div',
          {
            style: {
              position: 'relative',
              display: 'flex',
              flexDirection: 'column',
              alignItems: mine ? 'flex-end' : 'flex-start',
              maxWidth: '100%',
            },
            title: timeFull(msg.createdAt),
          },
          tools,
          msg.replyTo ? quoteNode(msg.replyTo, jumpTo) : null,
          body,
        ),
        status,
      ),
    );

    // 左侧竖线按发送者取色，方便快速分辨
    if (!mine && msg.sender) body.style.setProperty('--msg-tone', toneFor(msg.sender.id));
    node._body = body;
    return node;
  }

  /* ------------------------------------------------------------------ */
  /* 整段渲染                                                            */
  /* ------------------------------------------------------------------ */

  function daySeparator(ts) {
    return h('div.daysep', h('span.daysep__text', dayLabel(ts)));
  }

  function renderAll() {
    const list = activeId ? messagesOf(activeId) : [];
    nodes.clear();
    lastDayKey = null;

    // 没选中会话时不显示输入区，空状态能占满整栏，也避免对着一个发不出去的框发呆
    footHost.hidden = !activeId;

    if (!activeId) {
      inner = null;
      fill(scrollHost, emptyState({
        mark: 'chats-circle',
        title: '选一个会话开始',
        text: '左边挑一个人或一个群，消息就会出现在这里。',
      }));
      fill(headHost);
      return;
    }

    if (list.length === 0) {
      const conv = state.conversations.get(activeId);
      inner = null;
      fill(
        scrollHost,
        emptyState({
          mark: conv?.type === 'group' ? 'users-three' : 'chats-circle',
          title: conv?.type === 'group' ? `「${conv.title}」建好了` : `和 ${conv?.title || ''} 还没有聊过`,
          text: '说点什么吧，图片、语音、文件都能发。',
        }),
      );
      return;
    }

    const frag = document.createDocumentFragment();
    const container = h('div.thread__inner');
    let prev = null;
    for (const msg of list) {
      const key = dayKeyOf(msg.createdAt);
      if (key !== lastDayKey) {
        container.appendChild(daySeparator(msg.createdAt));
        lastDayKey = key;
        prev = null;
      }
      const node = messageNode(msg, prev);
      nodes.set(msg.id, node);
      container.appendChild(node);
      prev = msg.kind === 'system' ? null : msg;
    }

    inner = container;
    scrollHost.replaceChildren(container);
    ensureJumpButton();
  }

  /* ------------------------------------------------------------------ */
  /* 增量更新                                                            */
  /* ------------------------------------------------------------------ */

  function appendMessage(msg) {
    if (msg.conversationId !== activeId) return false;
    if (nodes.has(msg.id)) {
      updateMessage(msg);
      return true;
    }
    if (!inner) {
      renderAll();
      return true;
    }

    const list = messagesOf(activeId);
    const idx = list.findIndex((m) => m.id === msg.id);
    const prev = idx > 0 ? list[idx - 1] : null;

    const key = dayKeyOf(msg.createdAt);
    const newDay = key !== lastDayKey;
    if (newDay) {
      inner.appendChild(daySeparator(msg.createdAt));
      lastDayKey = key;
    }
    // 换了天就不参与「连续消息」判断
    const prevForGroup = !newDay && prev && prev.kind !== 'system' ? prev : null;

    const node = messageNode(msg, prevForGroup);
    // 上一条如果本来带了名字，现在要变成连续的，重新算一次
    if (prev && nodes.has(prev.id)) {
      const prevNode = nodes.get(prev.id);
      const shouldContinue = isContinued(prev, msg) && !prevNode.classList.contains('msg--cont');
      if (shouldContinue && prevNode.querySelector('.msg__name')) {
        prevNode.querySelector('.msg__name').remove();
        prevNode.classList.add('msg--cont');
      }
    }

    nodes.set(msg.id, node);
    inner.appendChild(node);
    node.classList.add('msg--enter');
    setTimeout(() => node.classList.remove('msg--enter'), 300);
    return true;
  }

  function updateMessage(msg) {
    if (msg.conversationId !== activeId) return;
    const old = nodes.get(msg.id);
    if (!old) return;
    const list = messagesOf(activeId);
    const idx = list.findIndex((m) => m.id === msg.id);
    // 编辑/撤回后，后续那条的「连续」状态可能变化，简单起见重建这一个节点
    const prev = idx > 0 ? list[idx - 1] : null;
    const next = messageNode(msg, prev && prev.kind !== 'system' ? prev : null);
    old.replaceWith(next);
    nodes.set(msg.id, next);
  }

  /* ------------------------------------------------------------------ */
  /* 滚动与已读                                                          */
  /* ------------------------------------------------------------------ */

  function ensureJumpButton() {
    jumpBtn?.remove();
    jumpBtn = h(
      'button.jumpdown',
      {
        type: 'button',
        onClick: () => {
          scrollToBottom(scrollHost, true);
          markRead();
        },
      },
      icon('arrow-down', { size: 15 }),
      h('span', '回到最新'),
    );
    jumpBtn.hidden = true;
  }

  function updateJumpButton() {
    if (!jumpBtn) return;
    const far = !isNearBottom(scrollHost, 240);
    jumpBtn.hidden = !far;
    if (far && inner && !jumpBtn.isConnected) scrollHost.appendChild(jumpBtn);
    if (!far && jumpBtn.isConnected) jumpBtn.remove();
  }

  let readTimer = null;
  function markRead(immediate = false) {
    if (!activeId) return;
    const list = messagesOf(activeId);
    const last = list[list.length - 1];
    if (!last) return;
    const conv = state.conversations.get(activeId);
    if (conv && (conv.lastReadMessageId || 0) >= last.id) return;

    const run = () => {
      if (conv) {
        conv.lastReadMessageId = last.id;
        conv.unread = 0;
        bus.emit('conversation:changed', conv);
        bus.emit('conversations:changed');
      }
      if (!sendRead(activeId, last.id)) {
        api.markRead(activeId, last.id).catch(() => {});
      }
    };
    clearTimeout(readTimer);
    if (immediate) run();
    else readTimer = setTimeout(run, 400);
  }

  async function loadOlder() {
    if (!activeId || loadingOlder) return;
    const list = messagesOf(activeId);
    const oldest = list[0];
    if (!oldest) return;

    loadingOlder = true;
    const beforeHeight = scrollHost.scrollHeight;
    try {
      const res = await api.messages(activeId, { before: oldest.id, limit: PAGE_SIZE });
      if (res.messages.length === 0) {
        state.hasMore.set(activeId, false);
        return;
      }
      const frag = document.createDocumentFragment();
      const batch = h('div');
      let prev = null;
      let dayKey = lastDayKey;

      // 新的一批要接在现有内容之前，日期分隔逻辑单独算
      let lastKey = null;
      for (const msg of res.messages) {
        const key = dayKeyOf(msg.createdAt);
        if (key !== lastKey) {
          batch.appendChild(daySeparator(msg.createdAt));
          lastKey = key;
          prev = null;
        }
        const node = messageNode(msg, prev);
        nodes.set(msg.id, node);
        batch.appendChild(node);
        prev = msg.kind === 'system' ? null : msg;
      }
      void dayKey;
      while (batch.firstChild) frag.appendChild(batch.firstChild);
      inner.prepend(frag);

      // 保持视觉位置不跳
      await nextFrame();
      scrollHost.scrollTop += scrollHost.scrollHeight - beforeHeight;
    } catch (err) {
      toast(err.message || '加载更早的消息失败', { tone: 'error' });
    } finally {
      loadingOlder = false;
    }
  }

  let scrollTick = null;
  scrollHost.addEventListener('scroll', () => {
    updateJumpButton();
    if (scrollTick) return;
    scrollTick = setTimeout(() => {
      scrollTick = null;
      if (scrollHost.scrollTop < 200) loadOlder();
      if (isNearBottom(scrollHost, 160)) markRead();
    }, 120);
  });

  /* ------------------------------------------------------------------ */
  /* 订阅                                                                */
  /* ------------------------------------------------------------------ */

  const offs = [
    bus.on('message:added', ({ message }) => {
      if (message.conversationId !== activeId) return;
      const stick = isNearBottom(scrollHost, 200);
      appendMessage(message);
      updateJumpButton();
      if (stick) {
        scrollToBottom(scrollHost, true);
        markRead();
      } else if (message.sender?.id !== state.me?.id) {
        updateJumpButton();
      }
    }),
    bus.on('message:changed', (message) => updateMessage(message)),
    bus.on('messages:reset', ({ conversationId }) => {
      if (conversationId === activeId) {
        renderAll();
        scrollToBottom(scrollHost, false);
      }
    }),
    bus.on('conversation:changed', (conv) => {
      if (conv.id === activeId) renderHead();
    }),
    bus.on('typing:changed', ({ conversationId }) => {
      if (conversationId === activeId) renderHead();
    }),
    bus.on('presence:changed', () => renderHead()),
    bus.on('conversation:removed', (id) => {
      if (id === activeId) {
        activeId = null;
        renderAll();
      }
    }),
  ];

  /* ------------------------------------------------------------------ */
  /* 对外接口                                                            */
  /* ------------------------------------------------------------------ */

  const apiOut = {
    /** 打开一个会话 */
    async open(conversationId) {
      if (activeId === conversationId) return;
      activeId = conversationId;
      state.activeId = conversationId;
      editing.id = null;
      stopCurrentAudio();

      const conv = state.conversations.get(conversationId);
      renderHead();

      const cached = messagesOf(conversationId);
      if (cached.length === 0) {
        fill(scrollHost, h('div', { style: { padding: 'var(--s4)' } }, skeletonRows(5)));
        try {
          const res = await api.messages(conversationId, { limit: PAGE_SIZE });
          if (activeId !== conversationId) return; // 用户又切走了
          setMessages(conversationId, res.messages, res.hasMore);
        } catch (err) {
          if (activeId !== conversationId) return;
          fill(
            scrollHost,
            h(
              'div',
              { style: { padding: 'var(--s5)' } },
              h(
                'div.banner.banner--error',
                icon('warning-circle', { size: 15 }),
                h('span', { style: { flex: '1' } }, err.message || '加载消息失败'),
                h('div.banner__actions', [
                  h('button.btn.btn--outline', {
                    type: 'button',
                    text: '重试',
                    onClick: () => apiOut.open(conversationId),
                  }),
                ]),
              ),
            ),
          );
          return;
        }
      } else {
        renderAll();
      }

      renderAll();
      await nextFrame();
      scrollToBottom(scrollHost, false);
      markRead(true);
      void conv;
    },

    close() {
      activeId = null;
      state.activeId = null;
      stopCurrentAudio();
      renderAll();
    },

    refresh: renderHead,

    /** 从搜索结果跳到某条消息 */
    async jumpToMessage(conversationId, messageId) {
      if (activeId !== conversationId) await apiOut.open(conversationId);
      await nextFrame();
      // 目标不在当前加载范围时，往前翻几页
      let guard = 0;
      while (!nodes.has(messageId) && guard < 6) {
        const before = messagesOf(conversationId)[0]?.id;
        if (!before) break;
        const more = state.hasMore.get(conversationId) !== false;
        if (!more) break;
        await loadOlder();
        guard += 1;
      }
      jumpTo(messageId);
    },

    /** 会话内的「正在输入」节流上报 */
    notifyTyping: (() => {
      let last = 0;
      return () => {
        const now = Date.now();
        if (now - last < 3500) return;
        last = now;
        if (activeId) sendTyping(activeId);
      };
    })(),

    setComposing(on) {
      composing = on;
      void composing;
    },

    get activeId() {
      return activeId;
    },

    scrollHost,
    footHost,
    editing,
    destroy() {
      offs.forEach((off) => off?.());
      stopCurrentAudio();
    },
  };

  renderAll();
  return apiOut;
}
