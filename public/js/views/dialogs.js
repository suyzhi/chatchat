/**
 * 功能对话框：新建会话、建群、群管理、资料卡、加联系人、转发、设置。
 */
import { h, fill, toast, copyText } from '../dom.js';
import { icon } from '../icon.js';
import { api } from '../api.js';
import { state, bus, conversations, userName } from '../store.js';
import { avatarNode } from './parts.js';
import { openDialog, confirmDialog, promptDialog } from '../overlays.js';
import { bytes, timeAgo, duration } from '../format.js';
import { uploadFile } from '../upload.js';

/* ------------------------------------------------------------------ */
/* 新建私聊                                                            */
/* ------------------------------------------------------------------ */

/**
 * @param {{ openConversation: (id: number) => void }} ctx
 */
export function openNewChat(ctx) {
  const search = h('input.input', { type: 'search', placeholder: '搜索名字或用户名', autocomplete: 'off' });
  const listHost = h('div.picker');

  function rowFor(u) {
    return h(
      'button.picker__row',
      {
        type: 'button',
        style: { cursor: 'pointer', gridTemplateColumns: 'auto minmax(0,1fr)' },
        onClick: async () => {
          try {
            const res = await api.createConversation({ type: 'dm', userId: u.id });
            bus.emit('conversation:new', res.conversation);
            dialog.close();
            ctx.openConversation(res.conversation.id);
          } catch (err) {
            toast(err.message, { tone: 'error' });
          }
        },
      },
      avatarNode(u, { size: 'sm' }),
      h(
        'div',
        { style: { minWidth: '0' } },
        h('div', { style: { fontWeight: '550' } }, state.contacts.get(u.id)?.alias || u.displayName),
        h('div.meta', { style: { textTransform: 'none', letterSpacing: '0.02em' } }, `@${u.username}${u.online ? '  ·  在线' : ''}`),
      ),
    );
  }

  function paint() {
    const q = search.value.trim().toLowerCase();
    const people = [...state.users.values()]
      .filter((u) => u.id !== state.me?.id)
      .filter(
        (u) =>
          !q ||
          u.displayName.toLowerCase().includes(q) ||
          u.username.toLowerCase().includes(q),
      )
      .sort((a, b) => {
        const ac = state.contacts.has(a.id) ? 0 : 1;
        const bc = state.contacts.has(b.id) ? 0 : 1;
        return ac - bc || a.displayName.localeCompare(b.displayName, 'zh');
      });

    if (people.length === 0) {
      fill(
        listHost,
        h(
          'div',
          { style: { padding: 'var(--s4)', textAlign: 'center', color: 'var(--ink-2)', fontSize: 'var(--t-small)' } },
          state.users.size <= 1 ? '站点上还没有别人。把地址发给朋友，他们注册后就会出现在这里。' : '没有匹配的人。',
        ),
      );
      return;
    }
    fill(listHost, ...people.map(rowFor));
  }

  search.addEventListener('input', paint);
  paint();

  const dialog = openDialog({
    title: '开始新聊天',
    desc: '选一个人，如果之前聊过就会打开原来的会话。',
    body: h('div.field', search, listHost),
  });
  setTimeout(() => search.focus({ preventScroll: true }), 40);
}

/* ------------------------------------------------------------------ */
/* 建群                                                                */
/* ------------------------------------------------------------------ */

export function openNewGroup(ctx) {
  const titleInput = h('input.input', { type: 'text', placeholder: '给群起个名字', maxLength: 40 });
  const search = h('input.input', { type: 'search', placeholder: '筛选成员', autocomplete: 'off' });
  const listHost = h('div.picker');
  const countEl = h('span.meta');
  const selected = new Set();

  function paint() {
    const q = search.value.trim().toLowerCase();
    const people = [...state.users.values()]
      .filter((u) => u.id !== state.me?.id)
      .filter((u) => !q || u.displayName.toLowerCase().includes(q) || u.username.toLowerCase().includes(q));

    countEl.textContent = `已选 ${selected.size} 人`;
    if (people.length === 0) {
      fill(listHost, h('div', { style: { padding: 'var(--s4)', textAlign: 'center', color: 'var(--ink-2)', fontSize: 'var(--t-small)' } }, '还没有别人可以拉进来。'));
      return;
    }
    fill(
      listHost,
      ...people.map((u) => {
        const on = selected.has(u.id);
        const cb = h('input', { type: 'checkbox', checked: on, tabIndex: -1 });
        const row = h(
          `label.picker__row${on ? '.picker__row--on' : ''}`,
          cb,
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 'var(--s3)', minWidth: '0' } },
            avatarNode(u, { size: 'sm' }),
            h('span', { style: { fontWeight: '550' } }, state.contacts.get(u.id)?.alias || u.displayName),
          ),
          h('span.meta', { style: { textTransform: 'none' } }, u.online ? '在线' : ''),
        );
        cb.addEventListener('change', () => {
          if (cb.checked) selected.add(u.id);
          else selected.delete(u.id);
          row.classList.toggle('picker__row--on', cb.checked);
          countEl.textContent = `已选 ${selected.size} 人`;
        });
        return row;
      }),
    );
  }

  search.addEventListener('input', paint);
  paint();

  const createBtn = h('button.btn.btn--primary', { type: 'button', text: '创建群聊' });

  const dialog = openDialog({
    title: '建一个新群',
    desc: '群聊里的每个人都能看到彼此和历史消息。',
    wide: true,
    body: h(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: 'var(--s4)' } },
      h('div.field', h('label.field__label', '群名'), titleInput),
      h(
        'div.field',
        h('div', { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' } },
          h('label.field__label', '成员'), countEl),
        search,
        listHost,
      ),
    ),
    actions: (close) => [
      h('button.btn.btn--outline', { type: 'button', text: '取消', onClick: () => close(null) }),
      createBtn,
    ],
  });

  createBtn.addEventListener('click', async () => {
    const title = titleInput.value.trim();
    if (!title) {
      toast('给群起个名字', { tone: 'error' });
      titleInput.focus();
      return;
    }
    if (selected.size === 0) {
      toast('至少要选一个人', { tone: 'error' });
      return;
    }
    createBtn.disabled = true;
    try {
      const res = await api.createConversation({
        type: 'group',
        title,
        memberIds: [...selected],
      });
      bus.emit('conversation:new', res.conversation);
      dialog.close();
      ctx.openConversation(res.conversation.id);
      toast('群聊建好了', { tone: 'ok' });
    } catch (err) {
      toast(err.message, { tone: 'error' });
    } finally {
      createBtn.disabled = false;
    }
  });

  setTimeout(() => titleInput.focus({ preventScroll: true }), 40);
}

/* ------------------------------------------------------------------ */
/* 资料卡                                                              */
/* ------------------------------------------------------------------ */

export function openProfile(userId, ctx) {
  const user = state.users.get(userId);
  if (!user) {
    toast('找不到这个用户', { tone: 'error' });
    return;
  }
  const contact = state.contacts.get(userId);
  const isSelf = userId === state.me?.id;

  const meta = h('div', { style: { display: 'flex', gap: 'var(--s4)', fontSize: 'var(--t-small)', color: 'var(--ink-2)' } });

  const actions = [];
  if (!isSelf) {
    actions.push(
      h(
        'button.btn.btn--primary.btn--block',
        {
          type: 'button',
          onClick: async () => {
            dialog.close();
            try {
              const res = await api.createConversation({ type: 'dm', userId });
              bus.emit('conversation:new', res.conversation);
              ctx.openConversation(res.conversation.id);
            } catch (err) {
              toast(err.message, { tone: 'error' });
            }
          },
        },
        icon('paper-plane-tilt', { size: 16 }),
        h('span', '发消息'),
      ),
    );
  }

  const contactBtn = h('button.btn.btn--outline.btn--block', {
    type: 'button',
    text: contact ? '编辑备注名' : '加为联系人',
  });
  contactBtn.addEventListener('click', async () => {
    if (contact) {
      const alias = await promptDialog({
        title: '备注名',
        desc: '只对你自己生效，别人看不到。留空可以清除。',
        label: '备注名',
        value: contact.alias || '',
        allowEmpty: true,
        maxLength: 32,
        confirmLabel: '保存',
      });
      if (alias === null) return;
      try {
        const res = await api.updateContact(userId, { alias: alias || null });
        state.contacts.set(userId, res.contact);
        bus.emit('contacts:changed');
        dialog.close();
        toast('备注名已更新', { tone: 'ok' });
      } catch (err) {
        toast(err.message, { tone: 'error' });
      }
    } else {
      try {
        const res = await api.addContact({ userId });
        state.contacts.set(userId, res.contact);
        bus.emit('contacts:changed');
        dialog.close();
        toast(`已把 ${res.contact.displayName} 加为联系人`, { tone: 'ok' });
      } catch (err) {
        toast(err.message, { tone: 'error' });
      }
    }
  });
  if (!isSelf) actions.push(contactBtn);

  const dialog = openDialog({
    title: isSelf ? '我的账号' : '资料',
    body: h(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: 'var(--s4)' } },
      h(
        'div.profile',
        avatarNode(user, { size: 'xl', showPresence: !isSelf }),
        h('div', h('div.profile__name', contact?.alias || user.displayName), h('div.profile__handle', `@${user.username}`)),
        user.about ? h('p.profile__about', user.about) : null,
        h(
          'div.profile__stats',
          h('div.profile__stat', h('b', user.online && !isSelf ? '在线' : user.lastSeenAt ? timeAgo(user.lastSeenAt).replace('在线', '') : '未知'), h('span.meta', '状态')),
          user.isAdmin ? h('div.profile__stat', h('b', '是'), h('span.meta', '管理员')) : null,
        ),
      ),
      meta,
      actions.length ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 'var(--s2)' } }, ...actions) : null,
    ),
    actions: contact
      ? (close) => [
          h('button.btn.btn--danger', {
            type: 'button',
            text: '从联系人移除',
            onClick: async () => {
              close(null);
              try {
                await api.removeContact(userId);
                state.contacts.delete(userId);
                bus.emit('contacts:changed');
                toast('已从联系人移除', { tone: 'ok' });
              } catch (err) {
                toast(err.message, { tone: 'error' });
              }
            },
          }),
        ]
      : undefined,
  });

  void meta;
}

/* ------------------------------------------------------------------ */
/* 加联系人                                                            */
/* ------------------------------------------------------------------ */

export function openAddContact() {
  const input = h('input.input', { type: 'text', placeholder: '输入对方的用户名', autocomplete: 'off', spellcheck: false });
  const result = h('div');
  const errorEl = h('p.field__error', { hidden: true });

  const dialog = openDialog({
    title: '添加联系人',
    desc: '输入对方注册时用的用户名，精确匹配。',
    body: h('div.field', h('label.field__label', '用户名'), input, errorEl, result),
    actions: (close) => [
      h('button.btn.btn--outline', { type: 'button', text: '取消', onClick: () => close(null) }),
      h('button.btn.btn--primary', { type: 'button', text: '查找并添加', onClick: submit }),
    ],
  });

  async function submit() {
    const username = input.value.trim();
    errorEl.hidden = true;
    if (!username) {
      fill(errorEl, icon('warning-circle', { size: 14 }), h('span', '请输入用户名'));
      errorEl.hidden = false;
      return;
    }
    try {
      const res = await api.addContact({ username });
      state.contacts.set(res.contact.id, { ...res.contact, alias: null });
      bus.emit('contacts:changed');
      dialog.close();
      toast(`已添加 ${res.contact.displayName}`, { tone: 'ok' });
    } catch (err) {
      fill(errorEl, icon('warning-circle', { size: 14 }), h('span', err.message));
      errorEl.hidden = false;
    }
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });
  setTimeout(() => input.focus({ preventScroll: true }), 40);
}

/* ------------------------------------------------------------------ */
/* 群管理                                                              */
/* ------------------------------------------------------------------ */

export function openGroupInfo(conversationId, ctx) {
  const conv = state.conversations.get(conversationId);
  if (!conv) return;

  const canManage = conv.myRole === 'owner' || conv.myRole === 'admin' || state.me?.isAdmin;
  const memberHost = h('div.picker');

  function paintMembers() {
    fill(
      memberHost,
      ...(conv.members || []).map((m) => {
        const isOwner = m.role === 'owner';
        const row = h(
          'div.picker__row',
          { style: { gridTemplateColumns: 'auto minmax(0,1fr) auto' } },
          avatarNode(m, { size: 'sm' }),
          h(
            'div',
            { style: { minWidth: '0' } },
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 'var(--s2)' } },
              h('span', { style: { fontWeight: '550' } }, m.id === state.me?.id ? '我' : userName(m.id)),
              isOwner ? icon('crown-simple', { size: 13, className: 'ico' }) : null,
            ),
            h('div.meta', { style: { textTransform: 'none', letterSpacing: '0.02em' } }, `@${m.username}${m.online ? '  ·  在线' : ''}`),
          ),
          canManage && m.id !== state.me?.id
            ? h(
                'button.icon-btn.icon-btn--sm.icon-btn--danger',
                {
                  type: 'button',
                  'aria-label': `移出 ${m.displayName}`,
                  onClick: async () => {
                    const ok = await confirmDialog({
                      title: `把 ${m.displayName} 移出群聊？`,
                      confirmLabel: '移出',
                      danger: true,
                    });
                    if (!ok) return;
                    try {
                      await api.removeMember(conversationId, m.id);
                      toast('已移出群聊', { tone: 'ok' });
                    } catch (err) {
                      toast(err.message, { tone: 'error' });
                    }
                  },
                },
                icon('x', { size: 14 }),
              )
            : null,
        );
        return row;
      }),
    );
  }
  paintMembers();

  const renameBtn = canManage
    ? h(
        'button.btn.btn--outline.btn--block',
        {
          type: 'button',
          onClick: async () => {
            const title = await promptDialog({
              title: '修改群名',
              label: '群名',
              value: conv.title,
              maxLength: 40,
              confirmLabel: '保存',
            });
            if (!title) return;
            try {
              const res = await api.updateConversation(conversationId, { title });
              bus.emit('conversation:changed', res.conversation);
              bus.emit('conversations:changed');
              dialog.close();
              toast('群名已更新', { tone: 'ok' });
            } catch (err) {
              toast(err.message, { tone: 'error' });
            }
          },
        },
        icon('pencil-simple', { size: 15 }),
        h('span', '修改群名'),
      )
    : null;

  const addBtn = canManage
    ? h(
        'button.btn.btn--outline.btn--block',
        {
          type: 'button',
          onClick: () => addMembers(conversationId, new Set((conv.members || []).map((m) => m.id)), () => {
            dialog.close();
          }),
        },
        icon('user-plus', { size: 15 }),
        h('span', '添加成员'),
      )
    : null;

  const dialog = openDialog({
    title: conv.title,
    desc: `${conv.memberCount} 位成员`,
    wide: true,
    body: h(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: 'var(--s4)' } },
      h(
        'div.profile',
        avatarNode({ displayName: conv.title, avatarUrl: conv.avatarUrl }, { size: 'lg', showPresence: false }),
      ),
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 'var(--s2)' } }, renameBtn, addBtn),
      h('div.field', h('label.field__label', '成员'), memberHost),
    ),
    actions: (close) => [
      h('button.btn.btn--outline', { type: 'button', text: '关闭', onClick: () => close(null) }),
    ],
  });
  void ctx;
}

/** 成员选择器，复用在建群和加人两处 */
function addMembers(conversationId, existing, onDone) {
  const search = h('input.input', { type: 'search', placeholder: '筛选', autocomplete: 'off' });
  const listHost = h('div.picker');
  const selected = new Set();

  const candidates = () =>
    [...state.users.values()]
      .filter((u) => !existing.has(u.id))
      .filter((u) => {
        const q = search.value.trim().toLowerCase();
        return !q || u.displayName.toLowerCase().includes(q) || u.username.toLowerCase().includes(q);
      });

  function paint() {
    const people = candidates();
    if (people.length === 0) {
      fill(listHost, h('div', { style: { padding: 'var(--s4)', textAlign: 'center', color: 'var(--ink-2)', fontSize: 'var(--t-small)' } }, '没有可添加的人。'));
      return;
    }
    fill(
      listHost,
      ...people.map((u) => {
        const cb = h('input', { type: 'checkbox', tabIndex: -1 });
        const row = h(
          'label.picker__row',
          cb,
          h('span', { style: { fontWeight: '550' } }, state.contacts.get(u.id)?.alias || u.displayName),
          h('span.meta', { style: { textTransform: 'none' } }, `@${u.username}`),
        );
        cb.addEventListener('change', () => {
          if (cb.checked) selected.add(u.id);
          else selected.delete(u.id);
          row.classList.toggle('picker__row--on', cb.checked);
        });
        return row;
      }),
    );
  }

  search.addEventListener('input', paint);
  paint();

  const dialog = openDialog({
    title: '添加成员',
    body: h('div.field', search, listHost),
    actions: (close) => [
      h('button.btn.btn--outline', { type: 'button', text: '取消', onClick: () => close(null) }),
      h('button.btn.btn--primary', {
        type: 'button',
        text: '添加',
        onClick: async () => {
          if (selected.size === 0) {
            toast('先选人', { tone: 'error' });
            return;
          }
          try {
            await api.addMembers(conversationId, [...selected]);
            close(null);
            onDone?.();
            toast('已添加', { tone: 'ok' });
          } catch (err) {
            toast(err.message, { tone: 'error' });
          }
        },
      }),
    ],
  });
  setTimeout(() => search.focus({ preventScroll: true }), 40);
  return dialog;
}

/* ------------------------------------------------------------------ */
/* 转发                                                                */
/* ------------------------------------------------------------------ */

export function openForwardPicker(message) {
  const selected = new Set();
  const listHost = h('div.picker');
  const convs = conversations();

  if (convs.length === 0) {
    toast('还没有可以转发的会话', { tone: 'error' });
    return;
  }

  fill(
    listHost,
    ...convs.map((c) => {
      const cb = h('input', { type: 'checkbox', tabIndex: -1 });
      const row = h(
        'label.picker__row',
        cb,
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 'var(--s3)', minWidth: '0' } },
          c.type === 'group'
            ? h('span.avatar.avatar--sm', { 'aria-hidden': 'true' }, c.avatarUrl ? h('img', { src: c.avatarUrl, alt: '' }) : h('span', (c.title || '#')[0]))
            : avatarNode(c.peer, { size: 'sm', showPresence: false }),
          h('span', { style: { fontWeight: '550', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, c.title),
        ),
        h('span.meta', { style: { textTransform: 'none' } }, c.type === 'group' ? `${c.memberCount} 人` : '私聊'),
      );
      cb.addEventListener('change', () => {
        if (cb.checked) selected.add(c.id);
        else selected.delete(c.id);
        row.classList.toggle('picker__row--on', cb.checked);
      });
      return row;
    }),
  );

  const preview =
    message.kind === 'text'
      ? message.body.slice(0, 120)
      : message.kind === 'image'
        ? '[图片]'
        : message.kind === 'audio'
          ? '[语音]'
          : message.kind === 'video'
            ? '[视频]'
            : `[文件] ${message.file?.name || ''}`;

  const dialog = openDialog({
    title: '转发消息',
    desc: preview,
    body: h('div.field', h('label.field__label', '转发到'), listHost),
    actions: (close) => [
      h('button.btn.btn--outline', { type: 'button', text: '取消', onClick: () => close(null) }),
      h('button.btn.btn--primary', {
        type: 'button',
        text: '转发',
        onClick: async () => {
          if (selected.size === 0) {
            toast('先选一个会话', { tone: 'error' });
            return;
          }
          try {
            await api.forwardMessage(message.id, [...selected]);
            close(null);
            toast(`已转发到 ${selected.size} 个会话`, { tone: 'ok' });
          } catch (err) {
            toast(err.message, { tone: 'error' });
          }
        },
      }),
    ],
  });
  return dialog;
}

/* ------------------------------------------------------------------ */
/* 设置                                                                */
/* ------------------------------------------------------------------ */

export function openSettings(ctx) {
  const me = state.me;

  /* --- 资料 --- */
  const nameInput = h('input.input', { type: 'text', value: me.displayName, maxLength: 32 });
  const aboutInput = h('input.input', { type: 'text', value: me.about || '', maxLength: 140, placeholder: '一句话介绍自己' });
  const avatarInput = h('input', {
    type: 'file',
    accept: 'image/*',
    hidden: true,
  });
  const avatarPreview = h('div', avatarNode(me, { size: 'lg', showPresence: false }));

  avatarInput.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast('头像必须是图片', { tone: 'error' });
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      toast('头像不要超过 8 MB', { tone: 'error' });
      return;
    }
    try {
      const { file: uploaded } = await uploadFile(file, { name: file.name });
      const res = await api.updateMe({ avatarFileId: uploaded.id });
      state.me = res.user;
      bus.emit('me:changed', res.user);
      fill(avatarPreview, avatarNode(res.user, { size: 'lg', showPresence: false }));
      toast('头像已更新', { tone: 'ok' });
    } catch (err) {
      toast(err.message || '头像上传失败', { tone: 'error' });
    }
  });

  const saveBtn = h('button.btn.btn--primary', {
    type: 'button',
    text: '保存资料',
    onClick: async () => {
      const displayName = nameInput.value.trim();
      if (!displayName) {
        toast('昵称不能为空', { tone: 'error' });
        return;
      }
      saveBtn.disabled = true;
      try {
        const res = await api.updateMe({ displayName, about: aboutInput.value.trim() });
        state.me = res.user;
        bus.emit('me:changed', res.user);
        toast('已保存', { tone: 'ok' });
      } catch (err) {
        toast(err.message, { tone: 'error' });
      } finally {
        saveBtn.disabled = false;
      }
    },
  });

  /* --- 改密码 --- */
  const curPwd = h('input.input', { type: 'password', autocomplete: 'current-password', placeholder: '当前密码' });
  const newPwd = h('input.input', { type: 'password', autocomplete: 'new-password', placeholder: '至少 8 位' });
  const pwdBtn = h('button.btn.btn--outline', {
    type: 'button',
    text: '修改密码',
    onClick: async () => {
      if (newPwd.value.length < 8) {
        toast('新密码至少 8 位', { tone: 'error' });
        return;
      }
      pwdBtn.disabled = true;
      try {
        await api.changePassword({ currentPassword: curPwd.value, newPassword: newPwd.value });
        curPwd.value = '';
        newPwd.value = '';
        toast('密码已修改，其他设备已退出登录', { tone: 'ok' });
      } catch (err) {
        toast(err.message, { tone: 'error' });
      } finally {
        pwdBtn.disabled = false;
      }
    },
  });

  /* --- 存储占用 --- */
  const quotaBits = [];
  if (state.config?.dailyUploadQuota) {
    quotaBits.push(`每日上传上限 ${bytes(state.config.dailyUploadQuota)}`);
  }

  /* --- 邀请码（仅管理员）：先放占位，异步填 --- */
  const inviteHost = h('section', { style: { display: 'flex', flexDirection: 'column', gap: 'var(--s3)' }, hidden: true });

  async function loadAdminSection() {
    if (!me.isAdmin) return;
    let data;
    try {
      data = await api.adminInvite();
    } catch {
      return; // 不是管理员或接口不可用，静默隐藏，不打扰
    }
    inviteHost.hidden = false;

    let overview = null;
    try {
      overview = await api.adminOverview();
    } catch {
      /* 概况拿不到就先只显示邀请码 */
    }

    const codeEl = h('code', {
      text: data.code,
      style: {
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--t-lead)',
        letterSpacing: '0.16em',
        fontWeight: '600',
        userSelect: 'all',
      },
    });

    const copyBtn = h('button.btn.btn--outline', { type: 'button' }, icon('copy', { size: 15 }), h('span', '复制'));
    copyBtn.addEventListener('click', async () => {
      const ok = await copyText(data.code);
      toast(ok ? '邀请码已复制' : '复制失败，请手动选中', { tone: ok ? 'ok' : 'error' });
    });

    const rotateBtn = h('button.btn.btn--outline', { type: 'button' }, icon('arrow-clockwise', { size: 15 }), h('span', '换一个'));
    if (!data.rotatable) {
      rotateBtn.disabled = true;
      rotateBtn.title = '邀请码被 INVITE_CODE 环境变量固定了';
    }
    rotateBtn.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: '更换邀请码？',
        desc: '旧邀请码会立刻失效。已经注册的人不受影响。',
        confirmLabel: '换一个',
      });
      if (!ok) return;
      try {
        const res = await api.adminRotateInvite();
        fill(codeEl, res.code);
        toast('已生成新的邀请码', { tone: 'ok' });
      } catch (err) {
        toast(err.message, { tone: 'error' });
      }
    });

    fill(
      inviteHost,
      h('h3.meta', '邀请码（管理员）'),
      h(
        'p',
        { style: { fontSize: 'var(--t-small)', color: 'var(--ink-2)', lineHeight: 'var(--lh-snug)' } },
        '把本站地址和这串邀请码一起发给朋友，他们就能注册。注册关闭时这里不再生效。',
      ),
      h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--s3)',
            padding: 'var(--s3) var(--s4)',
            background: 'var(--accent-wash)',
            border: '1px solid var(--accent-line)',
            borderRadius: 'var(--r)',
            flexWrap: 'wrap',
          },
        },
        codeEl,
        h('span', { style: { flex: '1' } }),
        copyBtn,
        rotateBtn,
      ),
      data.source === 'env'
        ? h('p.field__hint', '这个邀请码来自服务器的 INVITE_CODE 环境变量，想换请改配置后重启。')
        : h('p.field__hint', '邀请码自动生成并保存在数据库里，重启不会变。'),
      overview
        ? h(
            'div',
            {
              style: {
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(7rem, 1fr))',
                gap: 'var(--s3)',
                paddingTop: 'var(--s2)',
              },
            },
            ...[
              ['成员', String(overview.counts.users)],
              ['在线', String(overview.counts.online)],
              ['会话', String(overview.counts.conversations)],
              ['消息', String(overview.counts.messages)],
              ['文件', String(overview.counts.files)],
              ['占用', bytes(overview.counts.storageBytes)],
              ['剩余磁盘', bytes(overview.freeDiskBytes)],
            ].map(([label, value]) =>
              h(
                'div',
                { style: { display: 'grid', gap: '0.1rem' } },
                h('b', { style: { fontSize: 'var(--t-body)', fontWeight: '620' } }, value),
                h('span.meta', label),
              ),
            ),
          )
        : null,
    );
  }

  const dialog = openDialog({
    title: '设置',
    wide: true,
    body: h(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: 'var(--s5)' } },

      h(
        'section',
        { style: { display: 'flex', flexDirection: 'column', gap: 'var(--s3)' } },
        h('h3.meta', '我的资料'),
        h(
          'div',
          { style: { display: 'flex', gap: 'var(--s4)', alignItems: 'center' } },
          avatarPreview,
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 'var(--s2)' } },
            h('button.btn.btn--outline', { type: 'button', text: '更换头像', onClick: () => avatarInput.click() }),
            h('span.field__hint', '建议正方形，不超过 8 MB'),
          ),
          avatarInput,
        ),
        h('div.field', h('label.field__label', '昵称'), nameInput),
        h('div.field', h('label.field__label', '一句话'), aboutInput),
        h('div', saveBtn),
      ),

      h('hr.hairline'),

      h(
        'section',
        { style: { display: 'flex', flexDirection: 'column', gap: 'var(--s3)' } },
        h('h3.meta', '修改密码'),
        h('div.field', h('label.field__label', '当前密码'), curPwd),
        h('div.field', h('label.field__label', '新密码'), newPwd, h('p.field__hint', '改完之后其他设备会被登出，这台保留')),
        h('div', pwdBtn),
      ),

      h('hr.hairline'),

      h(
        'section',
        { style: { display: 'flex', flexDirection: 'column', gap: 'var(--s3)' } },
        h('h3.meta', '服务器'),
        h(
          'div',
          { style: { fontSize: 'var(--t-small)', color: 'var(--ink-2)', display: 'grid', gap: 'var(--s1)' } },
          h('div', `单文件上限 ${bytes(state.config?.maxFileBytes || 0)}`),
          h('div', `语音最长 ${duration((state.config?.maxVoiceSeconds || 0) * 1000)}`),
          h('div', state.config?.recallWindowSeconds ? `消息可在 ${state.config.recallWindowSeconds} 秒内撤回` : '消息随时可撤回'),
          ...quotaBits.map((t) => h('div', t)),
        ),
      ),

      h('hr.hairline'),

      inviteHost,

      h(
        'section',
        { style: { display: 'flex', flexDirection: 'column', gap: 'var(--s2)' } },
        h('h3.meta', '登录状态'),
        h(
          'div',
          { style: { display: 'flex', gap: 'var(--s2)', flexWrap: 'wrap' } },
          h('button.btn.btn--outline', {
            type: 'button',
            text: '退出登录',
            onClick: async () => {
              dialog.close();
              ctx.logout();
            },
          }),
          h('button.btn.btn--danger', {
            type: 'button',
            text: '登出所有设备',
            onClick: async () => {
              const ok = await confirmDialog({
                title: '登出所有设备？',
                desc: '包括你现在用的这一台，之后需要用密码重新登录。',
                confirmLabel: '全部登出',
                danger: true,
              });
              if (!ok) return;
              dialog.close();
              ctx.logout({ all: true });
            },
          }),
        ),
      ),
    ),
    actions: (close) => [h('button.btn.btn--outline', { type: 'button', text: '关闭', onClick: () => close(null) })],
  });

  loadAdminSection();

  return dialog;
}
