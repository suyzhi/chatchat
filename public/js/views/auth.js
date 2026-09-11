/**
 * 登录 / 注册页。
 *
 * 非对称分栏：左边陈述这个站是什么，右边是表单。
 * 不做居中的大标题，也不放任何营销话术，因为访客本来就只有几个人。
 */
import { h, fill } from '../dom.js';
import { icon } from '../icon.js';
import { api } from '../api.js';
import { bytes } from '../format.js';

/**
 * @param {HTMLElement} root 挂载点
 * @param {{config: object, onDone: (user: object, opts?: {becameAdmin?: boolean}) => void}} opts
 */
export function renderAuth(root, { config, onDone }) {
  let mode = 'login'; // login | register

  const errorBox = h('div.banner.banner--error', { hidden: true });
  const setError = (msg) => {
    if (!msg) {
      errorBox.hidden = true;
      return;
    }
    fill(errorBox, icon('warning-circle', { size: 15 }), h('span', { style: { flex: '1' } }, msg));
    errorBox.hidden = false;
  };

  /* ---------------- 表单字段 ---------------- */

  const usernameInput = h('input.input', {
    type: 'text',
    name: 'username',
    autocomplete: 'username',
    required: true,
    placeholder: '例如 lin',
    maxLength: 24,
    autocapitalize: 'none',
    spellcheck: false,
  });

  const displayNameInput = h('input.input', {
    type: 'text',
    name: 'displayName',
    autocomplete: 'nickname',
    placeholder: '朋友看到的名字',
    maxLength: 32,
  });

  const passwordInput = h('input.input', {
    type: 'password',
    name: 'password',
    autocomplete: 'current-password',
    required: true,
    placeholder: '至少 8 位',
  });

  const inviteInput = h('input.input', {
    type: 'text',
    name: 'inviteCode',
    placeholder: '向管理员要',
    autocomplete: 'off',
    spellcheck: false,
  });

  const showPasswordBtn = h(
    'button.icon-btn.input-wrap__action',
    {
      type: 'button',
      'aria-label': '显示密码',
      title: '显示密码',
      onClick: () => {
        const show = passwordInput.type === 'password';
        passwordInput.type = show ? 'text' : 'password';
        fill(showPasswordBtn, icon(show ? 'eye-slash' : 'eye', { size: 16 }));
        showPasswordBtn.setAttribute('aria-label', show ? '隐藏密码' : '显示密码');
        showPasswordBtn.title = show ? '隐藏密码' : '显示密码';
      },
    },
    icon('eye', { size: 16 }),
  );

  const submitBtn = h('button.btn.btn--primary.btn--lg.btn--block', { type: 'submit' });

  const form = h(
    'form.auth__form',
    { novalidate: true },
    errorBox,
    h('div.field', h('label.field__label', { for: 'au-username' }, '用户名'), Object.assign(usernameInput, { id: 'au-username' })),
    mode === 'register'
      ? h(
          'div.field',
          h('label.field__label', { for: 'au-display' }, '昵称'),
          Object.assign(displayNameInput, { id: 'au-display' }),
          h('p.field__hint', '群里和消息旁边显示的名字，随时能改'),
        )
      : null,
    h(
      'div.field',
      h('label.field__label', { for: 'au-password' }, '密码'),
      h('div.input-wrap', Object.assign(passwordInput, { id: 'au-password' }), showPasswordBtn),
      mode === 'register' ? h('p.field__hint', '至少 8 位。这是私人站点，别用你在别处用过的密码') : null,
    ),
    mode === 'register' && config.registration.needsInvite
      ? h('div.field', h('label.field__label', { for: 'au-invite' }, '邀请码'), Object.assign(inviteInput, { id: 'au-invite' }))
      : null,
    submitBtn,
  );

  /* ---------------- 提交 ---------------- */

  let busy = false;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    setError(null);

    const username = usernameInput.value.trim();
    const password = passwordInput.value;

    if (!username) return setError('请填写用户名');
    if (!password) return setError('请填写密码');
    if (mode === 'register' && password.length < 8) return setError('密码至少 8 位');

    busy = true;
    submitBtn.disabled = true;
    const label = mode === 'login' ? '登录' : '创建账号';
    fill(submitBtn, mode === 'login' ? icon('sign-in', { size: 17 }) : icon('user-plus', { size: 17 }), h('span', label));

    try {
      if (mode === 'login') {
        const res = await api.login({ username, password });
        onDone(res.user);
      } else {
        const res = await api.register({
          username,
          displayName: displayNameInput.value.trim() || username,
          password,
          inviteCode: inviteInput.value.trim(),
        });
        onDone(res.user, { becameAdmin: res.becameAdmin });
      }
    } catch (err) {
      setError(err.message || '出错了，再试一次');
      // 密码错误时把焦点送回去，省一次点击
      if (err.status === 401 || err.status === 400) {
        passwordInput.select();
      }
    } finally {
      busy = false;
      submitBtn.disabled = false;
      fill(submitBtn, mode === 'login' ? icon('sign-in', { size: 17 }) : icon('user-plus', { size: 17 }), h('span', label));
    }
  });

  /* ---------------- 组装 ---------------- */

  const switchBtn = h('button', {
    type: 'button',
    style: {
      color: 'var(--accent)',
      fontWeight: '600',
      textDecoration: 'underline',
      textUnderlineOffset: '0.18em',
    },
    onClick: () => {
      mode = mode === 'login' ? 'register' : 'login';
      setError(null);
      render();
    },
  });

  const titleEl = h('h1.auth__title');
  const noteEl = h('p.auth__note');
  const switchRow = h('p.auth__switch');

  function render() {
    const registering = mode === 'register';
    titleEl.textContent = registering ? '创建一个账号' : '登录';
    noteEl.textContent = registering ? '注册之后就能互相找到了。' : '欢迎回来。';
    // 占位提示和自动填充语义都要跟着模式变，「至少 8 位」不该出现在登录框里
    passwordInput.placeholder = registering ? '至少 8 位' : '你的密码';
    passwordInput.autocomplete = registering ? 'new-password' : 'current-password';
    fill(
      switchRow,
      registering ? '已经有账号了？ ' : '还没有账号？ ',
      Object.assign(switchBtn, { textContent: registering ? '去登录' : '去注册' }),
    );

    // 重建表单内容以匹配当前模式
    const fields = [
      errorBox,
      h('div.field', h('label.field__label', { for: 'au-username' }, '用户名'), usernameInput),
    ];
    if (registering) {
      fields.push(
        h(
          'div.field',
          h('label.field__label', { for: 'au-display' }, '昵称'),
          displayNameInput,
          h('p.field__hint', '群里和消息旁边显示的名字，随时能改'),
        ),
      );
    }
    fields.push(
      h(
        'div.field',
        h('label.field__label', { for: 'au-password' }, '密码'),
        h('div.input-wrap', passwordInput, showPasswordBtn),
        registering ? h('p.field__hint', '至少 8 位。这是私人站点，别用你在别处用过的密码') : null,
      ),
    );
    if (registering && config.registration.needsInvite) {
      fields.push(
        h('div.field', h('label.field__label', { for: 'au-invite' }, '邀请码'), inviteInput),
      );
    }
    fields.push(submitBtn);

    // 保留 form 元素本身（事件监听还在上面），只换内容
    fill(form, fields);
    fill(submitBtn, registering ? icon('user-plus', { size: 17 }) : icon('sign-in', { size: 17 }), h('span', registering ? '创建账号' : '登录'));
    usernameInput.focus({ preventScroll: true });
  }

  const maxFile = config.maxFileBytes ? `${bytes(config.maxFileBytes)}` : '';

  const side = h(
    'div.auth__side',
    h('div.auth__wordmark', h('b', config.siteName || 'Vellum'), h('span.meta', 'PRIVATE')),
    h(
      'div',
      h('h2.auth__headline', '只给几个人的地方'),
      h('p.auth__sub', config.siteTagline || '没有信息流，没有推荐，没有陌生人。'),
    ),
    h(
      'div.auth__facts',
      h('span.auth__fact', icon('shield-check', { size: 15 }), '数据只存在自己的服务器'),
      h('span.auth__fact', icon('users-three', { size: 15 }), '仅限被邀请的人'),
      maxFile ? h('span.auth__fact', icon('file-arrow-down', { size: 15 }), `单文件最大 ${maxFile}`) : null,
    ),
  );

  const formSide = h(
    'div.auth__form-side',
    h('div.auth__card', titleEl, noteEl, form, switchRow),
  );

  root.className = 'auth';
  fill(root, side, formSide);

  // 注册关闭时直接提示，别让人填完才发现
  if (!config.registration.open) {
    setError(config.registration.reason || '站点已关闭注册');
  }

  render();

  return { focus: () => usernameInput.focus({ preventScroll: true }) };
}
