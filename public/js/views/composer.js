/**
 * 输入区。
 *
 * 交互约定：
 *  - Enter 发送，Shift + Enter 换行；
 *  - 选中的附件立刻开始上传，进度显示在输入框上方，全部就绪后发送；
 *  - 语音录完即刻发送，不经过待发送区（这是最符合直觉的行为）；
 *  - 支持粘贴图片、拖拽文件、点按钮选文件三条路径。
 */
import { h, fill, toast, copyText } from '../dom.js';
import { icon } from '../icon.js';
import { api } from '../api.js';
import { state, bus, trackUpload, updateUpload, dropUpload } from '../store.js';
import { bytes, duration } from '../format.js';
import { iconButton, setProgress, progressBar } from './parts.js';
import { openMenu } from '../overlays.js';
import { uploadFile, UploadCancelled, probeAudio } from '../upload.js';
import { EMOJI_GROUPS, favoriteGroup, recentEmoji, noteEmoji } from '../emoji.js';
import { Recorder, isSupported as recorderSupported } from '../recorder.js';

/**
 * @param {HTMLElement} host
 * @param {{
 *   getConversationId: () => number|null,
 *   onTyping: () => void,
 *   onSent: () => void,
 * }} handlers
 */
export function createComposer(host, handlers) {
  const editing = { id: null, original: '' };
  const reply = { message: null };

  /* ------------------------------------------------------------------ */
  /* 输入框                                                              */
  /* ------------------------------------------------------------------ */

  const input = h('textarea.composer__input', {
    rows: 1,
    placeholder: '写点什么',
    'aria-label': '消息输入框',
    maxLength: 4000,
  });

  const sendBtn = h(
    'button.icon-btn',
    {
      type: 'button',
      'aria-label': '发送',
      title: '发送（Enter）',
      disabled: true,
      style: { width: '2.25rem', height: '2.25rem' },
    },
    icon('paper-plane-tilt', { size: 18 }),
  );

  function autoGrow() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 224)}px`;
  }

  function refreshSendState() {
    const hasText = input.value.trim().length > 0;
    const ready = readyAttachments().length > 0;
    sendBtn.disabled = !handlers.getConversationId() || (!hasText && !ready);
    sendBtn.classList.toggle('icon-btn--on', hasText || ready);
  }

  input.addEventListener('input', () => {
    autoGrow();
    refreshSendState();
    handlers.onTyping();
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
    if (e.key === 'Escape') {
      if (editing.id) cancelEdit();
      else if (reply.message) cancelReply();
    }
  });

  input.addEventListener('paste', (e) => {
    const items = [...(e.clipboardData?.items ?? [])];
    const files = items
      .filter((it) => it.kind === 'file')
      .map((it) => it.getAsFile())
      .filter(Boolean);
    if (files.length) {
      e.preventDefault();
      acceptFiles(files);
      return;
    }
    // 纯文本粘贴时清掉外部带入的富文本格式
    const text = e.clipboardData?.getData('text/plain');
    if (text && e.clipboardData?.types?.includes('text/html')) {
      e.preventDefault();
      insertAtCursor(text);
    }
  });

  /* ------------------------------------------------------------------ */
  /* 待发送附件                                                          */
  /* ------------------------------------------------------------------ */

  const tray = h('div.attach-tray', { hidden: true });
  /**
   * 待发送的附件。每条都记着自己是哪个会话的：
   * 输入区只有一个，但会话是切来切去的，不记来源的话，切走再回来
   * 那条正在传的附件就凭空消失了（上传还在后台跑，传完却没人接手）。
   * @type {Map<string, {convId: number, file: File, uploaded: object|null, meta?: object, task: object, thumbUrl?: string}>}
   */
  const pending = new Map();

  /** 当前会话的附件。别的一律不显示、不参与发送 */
  const entriesFor = (convId) =>
    convId ? [...pending.entries()].filter(([, v]) => v.convId === convId) : [];

  const readyAttachments = () =>
    entriesFor(handlers.getConversationId())
      .filter(([, v]) => v.uploaded)
      .map(([id, v]) => ({ id, ...v }));

  /** 缩略图 URL 每条只建一次：之前每重绘一次就再造一个，老的那个再也回收不了 */
  function thumbUrlFor(entry) {
    if (!entry.thumbUrl) entry.thumbUrl = URL.createObjectURL(entry.file);
    return entry.thumbUrl;
  }

  function forgetEntry(id) {
    const entry = pending.get(id);
    if (entry?.thumbUrl) URL.revokeObjectURL(entry.thumbUrl);
    pending.delete(id);
  }

  /** 清掉某个会话的附件；不传就清全部 */
  function clearPending(convId) {
    for (const [id, entry] of [...pending]) {
      if (convId === undefined || entry.convId === convId) forgetEntry(id);
    }
  }

  /** 上传中那行状态文字。单独抽出来是为了能就地改，不用整块重绘 */
  function uploadLabel(entry) {
    if (entry.task.error) return `失败：${entry.task.error}`;
    if (entry.uploaded) return `就绪 · ${bytes(entry.file.size)}`;
    const pct = Math.round((entry.task.ratio || 0) * 100);
    return `${entry.task.phase === 'merge' ? '正在合并' : '上传中'} ${pct}%`;
  }

  function renderTray() {
    const items = entriesFor(handlers.getConversationId());
    tray.hidden = items.length === 0;
    fill(
      tray,
      ...items.map(([id, entry]) => {
        const labelEl = h('div.attach-chip__meta', uploadLabel(entry));
        entry.labelEl = labelEl;
        return h(
          'div.attach-chip',
          entry.file.type.startsWith('image/')
            ? h('img.attach-chip__thumb', { src: thumbUrlFor(entry), alt: '' })
            : h('span.attach-chip__thumb', { style: { display: 'grid', placeItems: 'center' } }, icon('file', { size: 15 })),
          h(
            'div.attach-chip__main',
            h('div.attach-chip__name', { title: entry.file.name }, entry.file.name),
            labelEl,
            !entry.uploaded && !entry.task.error ? entry.task.bar : null,
          ),
          h(
            'button.icon-btn.icon-btn--sm',
            {
              type: 'button',
              'aria-label': '移除附件',
              onClick: () => {
                entry.task.controller?.abort();
                dropUpload(entry.convId, id);
                forgetEntry(id);
                renderTray();
                refreshSendState();
              },
            },
            icon('x', { size: 13 }),
          ),
        );
      }),
    );
  }

  function startUpload(file) {
    const convId = handlers.getConversationId();
    if (!convId) {
      toast('先选一个会话', { tone: 'error' });
      return;
    }
    const id = `up_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const controller = new AbortController();
    const task = {
      id,
      name: file.name,
      ratio: 0,
      phase: 'init',
      error: null,
      controller,
      bar: progressBar(0),
    };
    pending.set(id, { convId, file, uploaded: null, task });
    trackUpload(convId, task);
    renderTray();
    refreshSendState();

    uploadFile(file, {
      signal: controller.signal,
      onPhase: (phase) => {
        task.phase = phase;
        // 只发一次事件就够：输入区自己订阅了 upload:changed，会重绘一次
        updateUpload(convId, task);
      },
      onProgress: ({ ratio }) => {
        /*
         * 进度是高频事件（每个分块都来一次）。这里只动那一条状态文字和
         * 进度条，绝不整块重绘 —— 重绘会连带重建缩略图的 blob URL，
         * 几个 G 的文件传下来就是上千次 DOM 重建加上千个回收不掉的 URL。
         */
        task.ratio = ratio;
        setProgress(task.bar, ratio);
        const entry = pending.get(id);
        if (entry?.labelEl?.isConnected) entry.labelEl.textContent = uploadLabel(entry);
      },
    })
      .then(({ file: uploaded, meta }) => {
        const entry = pending.get(id);
        if (!entry) return;
        entry.uploaded = uploaded;
        entry.meta = meta;
        entry.task.bar?.remove();
        renderTray();
        refreshSendState();
      })
      .catch((err) => {
        if (err instanceof UploadCancelled || err.name === 'AbortError') return;
        const entry = pending.get(id);
        if (entry) entry.task.error = err.message || '上传失败';
        dropUpload(convId, id);
        renderTray();
        refreshSendState();
        toast(`${file.name} 上传失败：${err.message || '未知错误'}`, { tone: 'error' });
      });
  }

  function acceptFiles(files) {
    const max = state.config?.maxFileBytes || Infinity;
    for (const f of files) {
      if (f.size > max) {
        toast(`${f.name} 超过单文件上限 ${bytes(max)}`, { tone: 'error' });
        continue;
      }
      if (f.size === 0) {
        toast(`${f.name} 是空文件`, { tone: 'error' });
        continue;
      }
      startUpload(f);
    }
  }

  /* ------------------------------------------------------------------ */
  /* 回复 / 编辑横幅                                                      */
  /* ------------------------------------------------------------------ */

  const banner = h('div', { hidden: true });

  function renderBanner() {
    if (editing.id) {
      banner.hidden = false;
      fill(
        banner,
        h(
          'div.composer__reply',
          icon('pencil-simple', { size: 15 }),
          h('div', { style: { minWidth: '0', flex: '1' } }, h('b', '正在编辑'), h('span', { style: { marginLeft: '0.5em', color: 'var(--ink-3)' } }, 'Enter 保存，Esc 取消')),
          iconButton('x', { label: '取消编辑', size: 14, onClick: cancelEdit }),
        ),
      );
      return;
    }
    if (reply.message) {
      const m = reply.message;
      const preview =
        m.kind === 'text'
          ? m.body.slice(0, 100)
          : m.kind === 'image'
            ? '[图片]'
            : m.kind === 'audio'
              ? '[语音]'
              : m.kind === 'video'
                ? '[视频]'
                : `[文件] ${m.file?.name || ''}`;
      banner.hidden = false;
      fill(
        banner,
        h(
          'div.composer__reply',
          icon('arrow-bend-up-left', { size: 15 }),
          h(
            'div',
            { style: { minWidth: '0', flex: '1' } },
            h('b', `回复 ${m.sender?.displayName || '对方'}`),
            h('div', { style: { color: 'var(--ink-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, preview),
          ),
          iconButton('x', { label: '取消回复', size: 14, onClick: cancelReply }),
        ),
      );
      return;
    }
    banner.hidden = true;
    fill(banner);
  }

  function startEdit(msg) {
    editing.id = msg.id;
    editing.original = msg.body;
    reply.message = null;
    input.value = msg.body;
    autoGrow();
    renderBanner();
    refreshSendState();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  function cancelEdit() {
    editing.id = null;
    editing.original = '';
    input.value = '';
    autoGrow();
    renderBanner();
    refreshSendState();
    input.focus();
  }

  function setReply(msg) {
    reply.message = msg;
    editing.id = null;
    renderBanner();
    input.focus();
  }

  function cancelReply() {
    reply.message = null;
    renderBanner();
  }

  /* ------------------------------------------------------------------ */
  /* 表情                                                                */
  /* ------------------------------------------------------------------ */

  let emojiPanel = null;
  const emojiBtn = iconButton('smiley', { label: '表情', onClick: () => toggleEmoji() });

  function insertAtCursor(text) {
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    input.value = input.value.slice(0, start) + text + input.value.slice(end);
    const pos = start + text.length;
    input.setSelectionRange(pos, pos);
    autoGrow();
    refreshSendState();
    input.focus();
  }

  function toggleEmoji() {
    if (emojiPanel) {
      emojiPanel.remove();
      emojiPanel = null;
      emojiBtn.classList.remove('icon-btn--on');
      return;
    }
    emojiBtn.classList.add('icon-btn--on');

    const grid = h('div.emoji__grid', { role: 'listbox', 'aria-label': '表情' });
    const groups = [favoriteGroup(), ...EMOJI_GROUPS];
    const tabs = h('div.emoji__tabs', { role: 'tablist' });

    // 有历史就停在「常用」，没有就落在「表情」，
    // 否则第一次打开看到的是一页稀疏的兜底表情，观感很差。
    let current = recentEmoji().length > 0 ? groups[0].id : EMOJI_GROUPS[0].id;

    const paint = () => {
      const group = groups.find((g) => g.id === current) || groups[0];
      fill(
        grid,
        ...group.items.map((ch) =>
          h(
            'button.emoji__btn',
            {
              type: 'button',
              role: 'option',
              'aria-label': ch,
              onClick: () => {
                insertAtCursor(ch);
                noteEmoji(ch);
              },
            },
            ch,
          ),
        ),
      );
    };

    fill(
      tabs,
      ...groups.map((g) =>
        h('button.emoji__tab', {
          type: 'button',
          role: 'tab',
          text: g.label,
          'aria-selected': g.id === current ? 'true' : 'false',
          onClick: (e) => {
            current = g.id;
            for (const t of tabs.children) t.setAttribute('aria-selected', t === e.currentTarget ? 'true' : 'false');
            paint();
          },
        }),
      ),
    );

    paint();
    emojiPanel = h('div.emoji', tabs, grid);
    wrap.appendChild(emojiPanel);

    const onDocDown = (e) => {
      if (emojiPanel && !emojiPanel.contains(e.target) && !emojiBtn.contains(e.target)) {
        emojiPanel.remove();
        emojiPanel = null;
        emojiBtn.classList.remove('icon-btn--on');
        document.removeEventListener('mousedown', onDocDown, true);
      }
    };
    setTimeout(() => document.addEventListener('mousedown', onDocDown, true), 0);
  }

  /* ------------------------------------------------------------------ */
  /* 语音录制                                                            */
  /* ------------------------------------------------------------------ */

  const recorderBar = h('div', { hidden: true });
  let recorder = null;
  let recTimer = null;

  const micBtn = iconButton('microphone', {
    label: '录语音',
    onClick: () => (recorder ? finishRecording() : startRecording()),
  });

  function renderRecorder(elapsedMs = 0, level = 0) {
    recorderBar.hidden = false;
    const bars = 24;
    fill(
      recorderBar,
      h(
        'div.recorder',
        h('span.recorder__dot'),
        h('span.recorder__time', duration(elapsedMs)),
        h(
          'div.recorder__scope',
          ...Array.from({ length: bars }, (_, i) => {
            // 用最近的电平驱动一个简单的历史条，越靠右越新
            const seed = Math.abs(Math.sin((i + 1) * 1.7 + elapsedMs / 260));
            const v = i === bars - 1 ? level : seed * level;
            return h('i', { style: { height: `${Math.max(8, Math.round(v * 100))}%` } });
          }),
        ),
        h(
          'span',
          { style: { display: 'flex', gap: '2px' } },
          h(
            'button.icon-btn.icon-btn--sm',
            {
              type: 'button',
              'aria-label': '取消录音',
              onClick: () => cancelRecording(),
            },
            icon('trash', { size: 15 }),
          ),
          h(
            'button.icon-btn.icon-btn--sm',
            {
              type: 'button',
              'aria-label': '完成并发送',
              onClick: () => finishRecording(),
            },
            icon('paper-plane-tilt', { size: 15 }),
          ),
        ),
      ),
    );
  }

  async function startRecording() {
    if (!handlers.getConversationId()) {
      toast('先选一个会话', { tone: 'error' });
      return;
    }
    if (!recorderSupported()) {
      toast('这个浏览器不支持录音，可以改用「发送文件」上传音频', { tone: 'error' });
      return;
    }
    recorder = new Recorder({
      maxMs: (state.config?.maxVoiceSeconds || 300) * 1000,
      onTick: (ms) => renderRecorder(ms, recorder?._lastLevel || 0),
      onLevel: (v) => {
        if (recorder) recorder._lastLevel = v;
      },
      onAutoStop: () => {
        toast('到达最长录音时长，已自动发送');
        finishRecording();
      },
    });
    try {
      await recorder.start();
    } catch (err) {
      recorder = null;
      toast(
        err.name === 'NotAllowedError'
          ? '麦克风没有授权，请在浏览器地址栏的权限里允许'
          : err.message || '录音启动失败',
        { tone: 'error' },
      );
      return;
    }
    micBtn.classList.add('icon-btn--on');
    micBtn.setAttribute('aria-label', '完成并发送语音');
    renderRecorder(0, 0);
    recTimer = setInterval(() => {
      if (recorder) renderRecorder(recorder.elapsed(), recorder._lastLevel || 0);
    }, 120);
  }

  async function finishRecording() {
    if (!recorder) return;
    clearInterval(recTimer);
    recTimer = null;
    const rec = recorder;
    recorder = null;
    micBtn.classList.remove('icon-btn--on');
    micBtn.setAttribute('aria-label', '录语音');
    recorderBar.hidden = true;
    fill(recorderBar);

    let result;
    try {
      result = await rec.stop();
    } catch (err) {
      toast(err.message || '录音结束失败', { tone: 'error' });
      return;
    }
    if (result.durationMs < 700) {
      toast('太短了，按住多说一会儿', { tone: 'error' });
      return;
    }
    await sendAudio(result);
  }

  function cancelRecording() {
    if (!recorder) return;
    clearInterval(recTimer);
    recTimer = null;
    recorder.cancel();
    recorder = null;
    micBtn.classList.remove('icon-btn--on');
    micBtn.setAttribute('aria-label', '录语音');
    recorderBar.hidden = true;
    fill(recorderBar);
  }

  async function sendAudio({ blob, durationMs }) {
    const convId = handlers.getConversationId();
    if (!convId) return;
    const ext = (blob.type.split('/')[1] || 'webm').split(';')[0];
    const file = new File([blob], `语音-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.${ext}`, {
      type: blob.type,
    });
    // 录音时已经拿到电平，这里只需补时长和波形
    const localMeta = { durationMs };
    const id = `voice_${Date.now()}`;
    const task = {
      id,
      name: '语音消息',
      ratio: 0,
      phase: 'init',
      error: null,
      controller: new AbortController(),
      bar: progressBar(0),
    };
    pending.set(id, { convId, file, uploaded: null, task, meta: localMeta });
    renderTray();

    try {
      const { file: uploaded, meta } = await uploadFile(file, {
        signal: task.controller.signal,
        onProgress: ({ ratio }) => {
          task.ratio = ratio;
          setProgress(task.bar, ratio);
        },
      });
      forgetEntry(id);
      renderTray();
      const probe = await probeAudio(file).catch(() => ({}));
      // 明确发给录这条语音时所在的那个会话：上传可能花几秒，
      // 这期间用户完全可能已经点开另一个会话了。
      await sendMessage(
        {
          kind: 'audio',
          fileId: uploaded.id,
          meta: {
            durationMs: probe.durationMs || durationMs,
            waveform: probe.waveform || meta?.waveform || null,
          },
        },
        convId,
      );
    } catch (err) {
      if (err instanceof UploadCancelled || err.name === 'AbortError') return;
      forgetEntry(id);
      renderTray();
      toast(`语音发送失败：${err.message || '未知错误'}`, { tone: 'error' });
    }
  }

  /* ------------------------------------------------------------------ */
  /* 发送                                                                */
  /* ------------------------------------------------------------------ */

  /**
   * @param {object} payload
   * @param {number} [targetId] 目标会话。默认是「当前打开的会话」，
   *   但凡发送前有过 await 的调用方都必须把会话 id 显式传进来 ——
   *   否则用户在这段时间里切走，消息就发到别人那儿去了。
   */
  async function sendMessage(payload, targetId = handlers.getConversationId()) {
    if (!targetId) return null;
    const res = await api.send(targetId, payload);
    // 服务端会把消息推给所有成员（包括自己），这里不重复插入
    return res.message;
  }

  async function submit() {
    const convId = handlers.getConversationId();
    if (!convId) return;

    const text = input.value.trim();
    const attachments = readyAttachments();
    const stillUploading = entriesFor(convId).filter(([, v]) => !v.uploaded && !v.task.error);

    /* 编辑模式 */
    if (editing.id) {
      if (!text) {
        toast('消息不能为空', { tone: 'error' });
        return;
      }
      try {
        const res = await api.editMessage(editing.id, text);
        bus.emit('message:changed', res.message);
        cancelEdit();
      } catch (err) {
        toast(err.message, { tone: 'error' });
      }
      return;
    }

    if (!text && attachments.length === 0) return;
    if (stillUploading.length) {
      toast(`还有 ${stillUploading.length} 个附件在上传，稍等一下`, { tone: 'error' });
      return;
    }

    const replyTo = reply.message?.id ?? null;
    input.value = '';
    autoGrow();
    refreshSendState();

    try {
      if (attachments.length === 0) {
        await sendMessage({ kind: 'text', body: text, replyTo }, convId);
      } else {
        // 多附件：第一件带正文，其余作为跟进消息
        // 循环里每一件都要等上一次发完，所以目标会话必须显式钉住
        for (let i = 0; i < attachments.length; i += 1) {
          const att = attachments[i];
          const kind = att.uploaded.kind;
          await sendMessage(
            {
              kind,
              body: i === 0 ? text : '',
              fileId: att.uploaded.id,
              meta: att.meta || null,
              replyTo: i === 0 ? replyTo : null,
            },
            convId,
          );
          forgetEntry(att.id);
        }
        renderTray();
      }
      cancelReply();
      handlers.onSent();
    } catch (err) {
      toast(err.message || '发送失败', { tone: 'error' });
      // 失败就把文字还回输入框，别让人白打一遍
      if (!input.value && text) {
        input.value = text;
        autoGrow();
        refreshSendState();
      }
    }
  }

  sendBtn.addEventListener('click', submit);

  /* ------------------------------------------------------------------ */
  /* 工具栏                                                              */
  /* ------------------------------------------------------------------ */

  const imageInput = h('input', {
    type: 'file',
    accept: 'image/*',
    multiple: true,
    hidden: true,
    onChange: (e) => {
      acceptFiles([...e.target.files]);
      e.target.value = '';
    },
  });

  const fileInput = h('input', {
    type: 'file',
    multiple: true,
    hidden: true,
    onChange: (e) => {
      acceptFiles([...e.target.files]);
      e.target.value = '';
    },
  });

  const attachBtn = iconButton('plus', {
    label: '添加附件',
    onClick: () => {
      openMenu({
        anchor: attachBtn,
        items: [
          { label: '图片', icon: 'image', onClick: () => imageInput.click() },
          { label: '任意文件', icon: 'paperclip', onClick: () => fileInput.click() },
          { separator: true },
          {
            label: '粘贴图片',
            icon: 'copy',
            onClick: async () => {
              try {
                const items = await navigator.clipboard.read();
                const files = [];
                for (const item of items) {
                  const type = item.types.find((t) => t.startsWith('image/'));
                  if (!type) continue;
                  const blob = await item.getType(type);
                  files.push(new File([blob], `粘贴的图片-${Date.now()}.${type.split('/')[1]}`, { type }));
                }
                if (files.length) acceptFiles(files);
                else toast('剪贴板里没有图片', { tone: 'error' });
              } catch {
                toast('浏览器不允许读取剪贴板，可以直接在输入框里 Ctrl+V', { tone: 'error' });
              }
            },
          },
        ],
      });
    },
  });

  void copyText;

  /* ------------------------------------------------------------------ */
  /* 组装                                                                */
  /* ------------------------------------------------------------------ */

  const wrap = h(
    'div',
    { style: { position: 'relative' } },
    banner,
    recorderBar,
    tray,
    // 提示行放在输入框上面：放下面的话，中文输入法的候选框（跟着光标
    // 出现在输入框下方）会正好把它盖住。
    h(
      'div.composer__foot',
      h('span.composer__hint', h('kbd', 'Enter'), ' 发送  ·  ', h('kbd', 'Shift+Enter'), ' 换行'),
      h('span.composer__hint', { id: 'composer-status' }),
    ),
    h(
      'div.composer__box',
      h('div.composer__tools', attachBtn, emojiBtn, micBtn),
      input,
      h('div.composer__tools', sendBtn),
    ),
    imageInput,
    fileInput,
  );

  fill(host, wrap);

  /* 拖拽进输入框 */
  const box = wrap.querySelector('.composer__box');
  box.addEventListener('dragover', (e) => {
    e.preventDefault();
    box.classList.add('composer__box--drop');
  });
  box.addEventListener('dragleave', () => box.classList.remove('composer__box--drop'));
  box.addEventListener('drop', (e) => {
    e.preventDefault();
    box.classList.remove('composer__box--drop');
    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.length) acceptFiles(files);
  });

  const offs = [
    bus.on('conversation:removed', (conversationId) => {
      // 只有当前会话没了才需要清草稿区；别的会话被移除不该动我这儿正在写的东西
      if (conversationId !== handlers.getConversationId()) return;
      clearPending(conversationId);
      cancelEdit();
      cancelReply();
      renderTray();
      renderRecorder(0, 0);
      recorderBar.hidden = true;
      refreshSendState();
    }),
    bus.on('upload:changed', ({ conversationId }) => {
      if (conversationId === handlers.getConversationId()) renderTray();
    }),
  ];

  autoGrow();
  refreshSendState();

  return {
    startEdit,
    setReply,
    cancelReply,
    focus: () => input.focus(),
    refresh: refreshSendState,
    /**
     * 会话切换时重置草稿区。
     *
     * 只清「文字/回复/编辑」这些跟输入框绑定的东西。附件不清：它们各自
     * 记着自己是哪个会话的，切走时只是不显示，切回来还在；正在传的也让它
     * 继续传完。以前这里一律 clear()，结果是切一下会话，传到一半的大文件
     * 就从界面上消失了，传完也没人接手（文件留在服务器上，消息永远发不出去）。
     */
    reset() {
      cancelEdit();
      cancelReply();
      renderTray();
      refreshSendState();
    },
    destroy() {
      offs.forEach((off) => off?.());
      cancelRecording();
      for (const entry of pending.values()) {
        try {
          entry.task.controller?.abort();
        } catch {
          /* 已经结束了 */
        }
      }
      clearPending();
    },
    get editing() {
      return editing;
    },
    get reply() {
      return reply;
    },
  };
}
