/**
 * 端到端冒烟测试。
 *
 * 不是单元测试，而是把「两个人真的聊起来」这件事从头跑一遍：
 * 注册 → 登录 → 加好友 → 私聊 → 发各种消息 → 传大文件（分块）→
 * 建群 → 已读回执 → 搜索 → 撤回 → 转发 → 权限校验。
 *
 * 用法： 先起服务，然后 node tools/smoke.mjs [baseUrl]
 */
import { createHash, randomBytes } from 'node:crypto';

// 默认端口跟 src/config.js 的 PORT 默认值保持一致：npm start 起在 8787，
// 以前这里写的是 8390，直接 npm run smoke 只会得到 ECONNREFUSED。
const BASE =
  process.argv[2] || process.env.SMOKE_BASE || `http://127.0.0.1:${process.env.PORT || 8787}`;

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    failures.push(`${name}${detail ? `  <- ${detail}` : ''}`);
    console.log(`  FAIL ${name}${detail ? `  <- ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

/** 带 cookie 罐的极简 HTTP 客户端 */
function makeClient(label) {
  const jar = new Map();
  return {
    label,
    async req(method, path, { json, raw, headers = {}, expectRaw = false } = {}) {
      const h = { ...headers };
      if (jar.size) {
        h.cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
      }
      let body;
      if (json !== undefined) {
        h['content-type'] = 'application/json';
        body = JSON.stringify(json);
      } else if (raw !== undefined) {
        body = raw;
      }
      const res = await fetch(BASE + path, { method, headers: h, body, redirect: 'manual' });

      const setCookie = res.headers.getSetCookie?.() ?? [];
      for (const c of setCookie) {
        const [pair] = c.split(';');
        const eq = pair.indexOf('=');
        const k = pair.slice(0, eq).trim();
        const v = pair.slice(eq + 1).trim();
        if (v === '') jar.delete(k);
        else jar.set(k, v);
      }

      if (expectRaw) return { status: res.status, res };
      const text = await res.text();
      let data = null;
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
      return { status: res.status, data, res };
    },
    get(p, o) {
      return this.req('GET', p, o);
    },
    post(p, json, o) {
      return this.req('POST', p, { json, ...o });
    },
    patch(p, json) {
      return this.req('PATCH', p, { json });
    },
    del(p) {
      return this.req('DELETE', p);
    },
    hasSession() {
      return jar.has('vellum_session');
    },
  };
}

const stamp = Date.now().toString(36);
const alice = makeClient('alice');
const bob = makeClient('bob');
const carol = makeClient('carol');

/* ------------------------------------------------------------------ */

async function run() {
  console.log(`冒烟测试目标： ${BASE}`);

  section('1. 公开配置与鉴权边界');
  {
    const cfg = await alice.get('/api/auth/config');
    check('GET /api/auth/config 返回 200', cfg.status === 200, `status=${cfg.status}`);
    check('配置里有 chunkBytes', Number.isInteger(cfg.data?.chunkBytes));
    check('未登录访问 /api/auth/me 返回 401', (await alice.get('/api/auth/me')).status === 401);
    check('未登录访问 /api/conversations 返回 401', (await alice.get('/api/conversations')).status === 401);
    check('未登录访问未知接口返回 401（不泄露路由表）', (await alice.get('/api/nope')).status === 401);
    check('路径穿越尝试被挡住', (await alice.get('/api/files/..%2f..%2fetc%2fpasswd')).status === 401);
  }

  section('2. 注册、邀请码与登录');
  let inviteCode = null;
  {
    const r1 = await alice.post('/api/auth/register', {
      username: `alice_${stamp}`,
      displayName: '爱丽丝',
      password: 'correct-horse-battery',
    });
    check('第一个注册者成功（无需邀请码）', r1.status === 201, JSON.stringify(r1.data).slice(0, 160));
    check('第一个注册者成为管理员', r1.data?.user?.isAdmin === true || r1.data?.becameAdmin === true);
    check('注册后立刻拿到会话 cookie', alice.hasSession());

    // 管理员能拿到邀请码
    const invite = await alice.get('/api/admin/invite');
    check('管理员可以读取邀请码', invite.status === 200 && typeof invite.data?.code === 'string',
      JSON.stringify(invite.data).slice(0, 120));
    inviteCode = invite.data?.code;
    check('自动生成了邀请码', inviteCode?.length >= 8, `code=${inviteCode}`);
    check('注册开关显示为开放', invite.data?.registrationOpen === true);

    // 非管理员不能读
    const guestInvite = await makeClient('guest').get('/api/admin/invite');
    check('未登录读不到邀请码', guestInvite.status === 401);

    const noInvite = await makeClient('ni').post('/api/auth/register', {
      username: `ni_${stamp}`,
      displayName: '没带邀请码',
      password: 'correct-horse-battery',
    });
    check('第二个注册者不带邀请码被拒', noInvite.status === 403, `status=${noInvite.status}`);

    const wrongInvite = await makeClient('wi').post('/api/auth/register', {
      username: `wi_${stamp}`,
      displayName: '邀请码错',
      password: 'correct-horse-battery',
      inviteCode: 'WRONGCODE9',
    });
    check('邀请码错误被拒', wrongInvite.status === 403);

    const dup = await makeClient('dup').post('/api/auth/register', {
      username: `alice_${stamp}`,
      displayName: '冒名',
      password: 'correct-horse-battery',
      inviteCode,
    });
    check('用户名重复被拒', dup.status === 400, `status=${dup.status}`);

    const weak = await makeClient('weak').post('/api/auth/register', {
      username: `weak_${stamp}`,
      displayName: '短密码',
      password: '123',
      inviteCode,
    });
    check('太短的密码被拒', weak.status === 400);

    const badname = await makeClient('bn').post('/api/auth/register', {
      username: '有 空格 和中文',
      password: 'correct-horse-battery',
      inviteCode,
    });
    check('非法用户名被拒', badname.status === 400);

    const b = await bob.post('/api/auth/register', {
      username: `bob_${stamp}`,
      displayName: '鲍勃',
      password: 'another-long-password',
      inviteCode,
    });
    check('带上邀请码就能注册（第 2 人）', b.status === 201, JSON.stringify(b.data).slice(0, 120));
    check('第二个注册者不是管理员', bob.hasSession() && b.data?.becameAdmin === false);

    const c = await carol.post('/api/auth/register', {
      username: `carol_${stamp}`,
      displayName: '卡罗尔',
      password: 'third-long-password',
      inviteCode,
    });
    check('第三个注册者成功', c.status === 201);

    // 换码之后旧码立刻失效
    const rotated = await alice.post('/api/admin/invite/rotate');
    check('管理员可以更换邀请码', rotated.status === 200 && rotated.data?.code !== inviteCode);
    const staleCode = await makeClient('sc').post('/api/auth/register', {
      username: `sc_${stamp}`,
      displayName: '旧码注册',
      password: 'sixth-long-password',
      inviteCode,
    });
    check('换码之后旧邀请码失效', staleCode.status === 403, `status=${staleCode.status}`);
    inviteCode = rotated.data.code;

    const wrong = await makeClient('w').post('/api/auth/login', {
      username: `alice_${stamp}`,
      password: 'wrong-password-here',
    });
    check('错误密码被拒', wrong.status === 401);

    const ghost = await makeClient('g').post('/api/auth/login', {
      username: `nobody_${stamp}`,
      password: 'whatever-long-pass',
    });
    check('不存在的用户登录失败', ghost.status === 401);
  }

  section('3. 用户目录与联系人');
  let aliceId;
  let bobId;
  let carolId;
  {
    const me = await alice.get('/api/auth/me');
    aliceId = me.data?.user?.id;
    check('GET /api/auth/me 正常', me.status === 200 && !!aliceId);

    const users = (await alice.get('/api/users')).data?.users ?? [];
    check('能看到全部 3 个用户', users.length === 3, `实际 ${users.length}`);
    check('列表里标出了自己', users.some((u) => u.isSelf && u.id === aliceId));

    bobId = users.find((u) => u.username === `bob_${stamp}`)?.id;
    carolId = users.find((u) => u.username === `carol_${stamp}`)?.id;
    check('找到 bob 和 carol 的 id', !!bobId && !!carolId);

    const add = await alice.post('/api/contacts', { userId: bobId, alias: '老鲍' });
    check('添加联系人成功', add.status === 201, JSON.stringify(add.data).slice(0, 120));

    const contacts = (await alice.get('/api/contacts')).data?.contacts ?? [];
    check('联系人列表里有 bob', contacts.some((c) => c.id === bobId));
    check('备注名被记住', contacts.find((c) => c.id === bobId)?.alias === '老鲍');

    const upd = await alice.patch(`/api/contacts/${bobId}`, { alias: '鲍勃同学' });
    check('修改备注名成功', upd.status === 200 && upd.data?.contact?.alias === '鲍勃同学');

    const self = await alice.post('/api/contacts', { userId: aliceId });
    check('不能加自己为联系人', self.status === 400);

    const noSuch = await alice.post('/api/contacts', { username: `nobody_${stamp}` });
    check('添加不存在的用户返回 404', noSuch.status === 404);
  }

  section('4. 私聊与消息');
  let dmId;
  {
    const create = await alice.post('/api/conversations', { type: 'dm', userId: bobId });
    check('创建私聊成功', create.status === 201 || create.status === 200, JSON.stringify(create.data).slice(0, 140));
    dmId = create.data?.conversation?.id;
    check('私聊有 id', !!dmId);
    check('私聊标题取的是自己的备注名', create.data?.conversation?.title === '鲍勃同学', create.data?.conversation?.title);

    const again = await alice.post('/api/conversations', { type: 'dm', userId: bobId });
    check('重复创建返回同一个会话', again.data?.conversation?.id === dmId && again.data?.created === false);

    const bobList = (await bob.get('/api/conversations')).data?.conversations ?? [];
    check('bob 那边也出现了这个会话', bobList.some((c) => c.id === dmId));
    check('bob 看到的是未读 0 起步', bobList.find((c) => c.id === dmId)?.unread === 0);

    const selfDm = await alice.post('/api/conversations', { type: 'dm', userId: aliceId });
    check('不能和自己私聊', selfDm.status === 400);

    // 发消息
    const m1 = await alice.post(`/api/conversations/${dmId}/messages`, {
      kind: 'text',
      body: '第一行\n第二行 <img src=x onerror=alert(1)>',
    });
    check('发送文本消息成功', m1.status === 201, JSON.stringify(m1.data).slice(0, 140));
    check('消息原样返回未被转义', m1.data?.message?.body?.includes('<img src=x'));

    const empty = await alice.post(`/api/conversations/${dmId}/messages`, { kind: 'text', body: '   ' });
    check('空消息被拒', empty.status === 400);

    const badKind = await alice.post(`/api/conversations/${dmId}/messages`, { kind: 'exploit', body: 'x' });
    check('未知消息类型被拒', badKind.status === 400);

    // bob 未读
    const bobList2 = (await bob.get('/api/conversations')).data?.conversations ?? [];
    const bobConv = bobList2.find((c) => c.id === dmId);
    check('bob 有 1 条未读', bobConv?.unread === 1, `unread=${bobConv?.unread}`);
    check('列表里能看到最后一条消息预览', bobConv?.lastMessage?.preview?.includes('第一行'));

    // 分页
    for (let i = 0; i < 12; i += 1) {
      await alice.post(`/api/conversations/${dmId}/messages`, { kind: 'text', body: `批量消息 ${i}` });
    }
    const page1 = await alice.get(`/api/conversations/${dmId}/messages?limit=5`);
    const p1 = page1.data?.messages ?? [];
    check('分页返回 5 条', p1.length === 5, `实际 ${p1.length}`);
    check('分页结果升序', p1.every((m, i, a) => i === 0 || a[i - 1].id < m.id));
    check('还有更多', page1.data?.hasMore === true);

    const oldest = p1[0]?.id;
    const page2 = await alice.get(`/api/conversations/${dmId}/messages?before=${oldest}&limit=5`);
    const p2 = page2.data?.messages ?? [];
    check('往前翻页拿到更早的消息', p2.length > 0 && p2.every((m) => m.id < oldest));
    check('两页不重叠', !p2.some((m) => p1.some((x) => x.id === m.id)));

    // 已读
    const lastMsgId = p1[p1.length - 1]?.id;
    const read = await bob.post(`/api/conversations/${dmId}/read`, { messageId: lastMsgId });
    check('标记已读成功', read.status === 200);

    const aliceConv = (await alice.get(`/api/conversations/${dmId}`)).data?.conversation;
    check('alice 看到对方已读到最新', aliceConv?.peerReadMessageId === lastMsgId, `peerRead=${aliceConv?.peerReadMessageId} 期望 ${lastMsgId}`);

    const bobUnread = (await bob.get('/api/unread')).data?.unread;
    check('bob 的未读清零', bobUnread === 0, `unread=${bobUnread}`);

    // 编辑
    const target = m1.data.message.id;
    const edit = await alice.patch(`/api/messages/${target}`, { body: '改过的内容' });
    check('编辑自己的消息成功', edit.status === 200 && edit.data?.message?.body === '改过的内容');
    check('编辑留下了 editedAt', !!edit.data?.message?.editedAt);

    const bobEdit = await bob.patch(`/api/messages/${target}`, { body: '我要改别人的' });
    check('不能编辑别人的消息', bobEdit.status === 403, `status=${bobEdit.status}`);

    // 回复
    const reply = await bob.post(`/api/conversations/${dmId}/messages`, {
      kind: 'text',
      body: '这是一条回复',
      replyTo: target,
    });
    check('回复消息成功', reply.status === 201);
    check('回复里带了被引用的消息', reply.data?.message?.replyTo?.id === target);

    const badReply = await bob.post(`/api/conversations/${dmId}/messages`, {
      kind: 'text',
      body: '引用不存在的消息',
      replyTo: 99999999,
    });
    check('引用不存在的消息被拒', badReply.status === 400);
  }

  section('5. 分块大文件上传');
  let fileId;
  let uploadedBytes;
  {
    // 用一个 9.5 MB 的伪随机文件，确保跨越多个分块
    const size = 9_500_000;
    const payload = randomBytes(size);
    const sha = createHash('sha256').update(payload).digest('hex');

    const init = await alice.post('/api/uploads/init', {
      name: '测试大文件.bin',
      size,
      mime: 'application/octet-stream',
    });
    check('创建上传任务成功', init.status === 201, JSON.stringify(init.data).slice(0, 140));
    const { uploadId, chunkSize, totalChunks } = init.data || {};
    check('分块数正确', totalChunks === Math.ceil(size / chunkSize), `${totalChunks} vs ${Math.ceil(size / chunkSize)}`);

    const status0 = await alice.get(`/api/uploads/${uploadId}`);
    check('查询上传进度返回空列表', Array.isArray(status0.data?.received) && status0.data.received.length === 0);

    // 并发传 3 块
    const indices = Array.from({ length: totalChunks }, (_, i) => i);
    let cursor = 0;
    await Promise.all(
      Array.from({ length: 3 }, async () => {
        for (;;) {
          const i = cursor++;
          if (i >= indices.length) return;
          const idx = indices[i];
          const slice = payload.subarray(idx * chunkSize, Math.min((idx + 1) * chunkSize, size));
          const r = await alice.req('PUT', `/api/uploads/${uploadId}/chunk/${idx}`, {
            raw: slice,
            headers: { 'content-type': 'application/octet-stream' },
          });
          if (r.status !== 200) throw new Error(`分块 ${idx} 上传失败 ${r.status} ${JSON.stringify(r.data)}`);
        }
      }),
    );
    check(`全部 ${totalChunks} 个分块上传完成`, true);
    void chunkSize;

    // 错误的块会被拒
    const wrongSize = await alice.req('PUT', `/api/uploads/${uploadId}/chunk/0`, {
      raw: Buffer.from('short'),
      headers: { 'content-type': 'application/octet-stream' },
    });
    check('大小不对的分块被拒', wrongSize.status === 400);

    const oob = await alice.req('PUT', `/api/uploads/${uploadId}/chunk/9999`, {
      raw: Buffer.alloc(10),
      headers: { 'content-type': 'application/octet-stream' },
    });
    check('越界分块序号被拒', oob.status === 400);

    // 别人不能碰我的上传
    const bobPeek = await bob.get(`/api/uploads/${uploadId}`);
    check('别人看不到我的上传任务', bobPeek.status === 403, `status=${bobPeek.status}`);

    const done = await alice.post(`/api/uploads/${uploadId}/complete`);
    check('合并成功', done.status === 201, JSON.stringify(done.data).slice(0, 160));
    fileId = done.data?.file?.id;
    uploadedBytes = done.data?.file?.size;
    check('文件 id 是随机十六进制', /^[0-9a-f]{32}$/.test(fileId || ''), fileId);
    check('服务端记录的大小与上传一致', uploadedBytes === size, `${uploadedBytes} vs ${size}`);
    check('kind 归类为 file', done.data?.file?.kind === 'file');

    // 下载并校验内容
    const dl = await alice.get(`/api/files/${fileId}`, { expectRaw: true });
    check('下载返回 200', dl.status === 200, `status=${dl.status}`);
    const buf = Buffer.from(await dl.res.arrayBuffer());
    check('下载大小一致', buf.length === size, `${buf.length} vs ${size}`);
    check('下载内容 sha256 与上传前一致', createHash('sha256').update(buf).digest('hex') === sha);

    // 断点续传：重开一个任务，只传一半，再查进度
    const init2 = await alice.post('/api/uploads/init', { name: '续传测试.bin', size, mime: 'application/octet-stream' });
    const up2 = init2.data;
    await alice.req('PUT', `/api/uploads/${up2.uploadId}/chunk/0`, {
      raw: payload.subarray(0, up2.chunkSize),
      headers: { 'content-type': 'application/octet-stream' },
    });
    const st = await alice.get(`/api/uploads/${up2.uploadId}`);
    check('续传进度记录到第 0 块', st.data?.received?.join(',') === '0', JSON.stringify(st.data?.received));

    const early = await alice.post(`/api/uploads/${up2.uploadId}/complete`);
    check('缺块时合并被拒（409）', early.status === 409, `status=${early.status}`);
    check('缺块响应里列出缺失的块号', Array.isArray(early.data?.missing) && early.data.missing.length === up2.totalChunks - 1);

    const abort = await alice.del(`/api/uploads/${up2.uploadId}`);
    check('取消上传成功', abort.status === 200);

    // 上传的文件还没被任何消息引用，bob 不该能下载
    const bobDl = await bob.get(`/api/files/${fileId}`);
    check('未被引用的文件别人下不了', bobDl.status === 404, `status=${bobDl.status}`);

    const nosuch = await alice.get('/api/files/deadbeefdeadbeefdeadbeefdeadbeef');
    check('不存在的文件返回 404', nosuch.status === 404);
  }

  section('6. 图片与语音消息');
  {
    // 一个 1x1 的合法 PNG，用来验证服务端的尺寸嗅探
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    const init = await alice.post('/api/uploads/init', { name: '像素.png', size: png.length, mime: 'image/png' });
    await alice.req('PUT', `/api/uploads/${init.data.uploadId}/chunk/0`, {
      raw: png,
      headers: { 'content-type': 'application/octet-stream' },
    });
    const done = await alice.post(`/api/uploads/${init.data.uploadId}/complete`);
    check('图片上传成功', done.status === 201);
    check('kind 归类为 image', done.data?.file?.kind === 'image');
    check('服务端嗅探出了宽高', done.data?.file?.width === 1 && done.data?.file?.height === 1,
      `${done.data?.file?.width}x${done.data?.file?.height}`);

    const imgMsg = await alice.post(`/api/conversations/${dmId}/messages`, {
      kind: 'image',
      fileId: done.data.file.id,
      body: '看这个',
    });
    check('发送图片消息成功', imgMsg.status === 201);
    check('消息里带上了文件信息', !!imgMsg.data?.message?.file?.url);

    // 前端伪造的宽高不可信，服务端以嗅探结果为准
    const spoof = await alice.post(`/api/conversations/${dmId}/messages`, {
      kind: 'image',
      fileId: done.data.file.id,
      meta: { width: 99999, height: 99999 },
    });
    check('消息元信息里的宽高以服务端为准', spoof.data?.message?.meta?.width === 1,
      JSON.stringify(spoof.data?.message?.meta));

    // 现在文件被消息引用了，bob 应该能下载
    const bobDl = await bob.get(`/api/files/${done.data.file.id}`, { expectRaw: true });
    check('会话成员可以下载消息里的文件', bobDl.status === 200, `status=${bobDl.status}`);

    // carol 不在这个会话里
    const carolDl = await carol.get(`/api/files/${done.data.file.id}`);
    check('非会话成员下不了这个文件', carolDl.status === 404, `status=${carolDl.status}`);

    // 别拿别人的文件冒充自己的
    const steal = await bob.post(`/api/conversations/${dmId}/messages`, {
      kind: 'image',
      fileId: done.data.file.id,
    });
    check('不能发送别人上传的文件', steal.status === 403, `status=${steal.status}`);

    // 语音消息 + 波形
    const voice = Buffer.from(randomBytes(2048));
    const vInit = await alice.post('/api/uploads/init', { name: '语音.webm', size: voice.length, mime: 'audio/webm' });
    await alice.req('PUT', `/api/uploads/${vInit.data.uploadId}/chunk/0`, {
      raw: voice,
      headers: { 'content-type': 'application/octet-stream' },
    });
    const vDone = await alice.post(`/api/uploads/${vInit.data.uploadId}/complete`);
    check('语音文件归类为 audio', vDone.data?.file?.kind === 'audio');

    const wave = Array.from({ length: 200 }, (_, i) => (i % 100) / 100);
    const vMsg = await alice.post(`/api/conversations/${dmId}/messages`, {
      kind: 'audio',
      fileId: vDone.data.file.id,
      meta: { durationMs: 4200, waveform: wave },
    });
    check('发送语音消息成功', vMsg.status === 201);
    check('波形被截断到 64 点', vMsg.data?.message?.meta?.waveform?.length === 64,
      `长度 ${vMsg.data?.message?.meta?.waveform?.length}`);
    check('波形值被收敛到 0-1', vMsg.data.message.meta.waveform.every((v) => v >= 0 && v <= 1));
    check('时长被保留', vMsg.data?.message?.meta?.durationMs === 4200);
  }

  section('7. 群聊');
  let groupId;
  {
    const create = await alice.post('/api/conversations', {
      type: 'group',
      title: '周末去哪儿',
      memberIds: [bobId, carolId],
    });
    check('建群成功', create.status === 201, JSON.stringify(create.data).slice(0, 160));
    groupId = create.data?.conversation?.id;
    check('群里有 3 个人', create.data?.conversation?.memberCount === 3, `memberCount=${create.data?.conversation?.memberCount}`);
    check('创建者是群主', create.data?.conversation?.myRole === 'owner');
    check('群成员列表已返回', create.data?.conversation?.members?.length === 3);

    const g1 = await alice.post(`/api/conversations/${groupId}/messages`, { kind: 'text', body: '大家有空吗' });
    check('群里发消息成功', g1.status === 201);

    const bobGroups = (await bob.get('/api/conversations')).data?.conversations ?? [];
    check('bob 的列表里有这个群', bobGroups.some((c) => c.id === groupId));
    check('bob 有 1 条未读', bobGroups.find((c) => c.id === groupId)?.unread === 1);

    const noMembers = await alice.post('/api/conversations', { type: 'group', title: '空群', memberIds: [] });
    check('空成员的群被拒', noMembers.status === 400);

    const noTitle = await alice.post('/api/conversations', { type: 'group', title: '  ', memberIds: [bobId] });
    check('群名不能为空', noTitle.status === 400);

    // carol 不是管理员，不能改群名
    const carolRename = await carol.patch(`/api/conversations/${groupId}`, { title: '我说了算' });
    check('普通成员不能改群名', carolRename.status === 403, `status=${carolRename.status}`);

    const rename = await alice.patch(`/api/conversations/${groupId}`, { title: '周末去爬山' });
    check('群主可以改群名', rename.status === 200 && rename.data?.conversation?.title === '周末去爬山');

    // 加人：先注册第四个人
    const dave = makeClient('dave');
    const daveReg = await dave.post('/api/auth/register', {
      username: `dave_${stamp}`,
      displayName: '戴夫',
      password: 'fourth-long-password',
      inviteCode,
    });
    const daveId = daveReg.data?.user?.id;
    check('第四个用户注册成功', daveReg.status === 201);

    const addM = await alice.post(`/api/conversations/${groupId}/members`, { userIds: [daveId] });
    check('群主可以加人', addM.status === 200, JSON.stringify(addM.data).slice(0, 120));
    check('成员数变成 4', addM.data?.conversation?.memberCount === 4);

    const carolAdd = await carol.post(`/api/conversations/${groupId}/members`, { userIds: [aliceId] });
    check('普通成员不能加人', carolAdd.status === 403);

    // 非成员完全看不到这个群
    const outsider = makeClient('outsider');
    await outsider.post('/api/auth/register', {
      username: `eve_${stamp}`,
      displayName: '夏娃',
      password: 'fifth-long-password',
      inviteCode,
    });
    check('非成员读群消息被拒', (await outsider.get(`/api/conversations/${groupId}/messages`)).status === 403);
    check('非成员往群里发消息被拒',
      (await outsider.post(`/api/conversations/${groupId}/messages`, { kind: 'text', body: 'hi' })).status === 403);
    check('非成员标记已读被拒', (await outsider.post(`/api/conversations/${groupId}/read`, {})).status === 403);

    // 退群
    const leave = await carol.post(`/api/conversations/${groupId}/leave`);
    check('普通成员可以退群', leave.status === 200);
    const after = (await alice.get(`/api/conversations/${groupId}`)).data?.conversation;
    check('退群后成员数减少', after?.memberCount === 3, `memberCount=${after?.memberCount}`);
    check('退群留下了系统消息', after?.lastMessage?.kind === 'system', after?.lastMessage?.kind);
    check('carol 的列表里没有这个群了',
      !((await carol.get('/api/conversations')).data?.conversations ?? []).some((c) => c.id === groupId));

    // 踢人
    const kick = await alice.del(`/api/conversations/${groupId}/members/${daveId}`);
    check('群主可以移除成员', kick.status === 200);
    check('被移除的人收到会话消失',
      !((await dave.get('/api/conversations')).data?.conversations ?? []).some((c) => c.id === groupId));

    const selfKick = await bob.del(`/api/conversations/${groupId}/members/${aliceId}`);
    check('普通成员不能踢群主', selfKick.status === 403);
  }

  section('8. 撤回、转发、搜索');
  {
    const sent = await alice.post(`/api/conversations/${dmId}/messages`, {
      kind: 'text',
      body: '这条马上要被撤回',
    });
    const mid = sent.data.message.id;

    const recallByBob = await bob.post(`/api/messages/${mid}/recall`);
    check('不能撤回别人的消息', recallByBob.status === 403);

    const recall = await alice.post(`/api/messages/${mid}/recall`);
    check('撤回自己的消息成功', recall.status === 200, JSON.stringify(recall.data).slice(0, 140));
    check('撤回后 kind 变成 deleted', recall.data?.message?.kind === 'deleted');
    check('撤回后正文被清空', recall.data?.message?.body === '');
    check('撤回后文件引用被清空', recall.data?.message?.file === null);

    const replyToDeleted = await bob.post(`/api/conversations/${dmId}/messages`, {
      kind: 'text',
      body: '回复一条被撤回的',
      replyTo: mid,
    });
    check('不能回复已撤回的消息', replyToDeleted.status === 400);

    // 搜索
    const marker = `独特标记${stamp}`;
    await alice.post(`/api/conversations/${dmId}/messages`, { kind: 'text', body: `包含 ${marker} 的消息` });
    const found = await alice.get(`/api/messages/search?q=${encodeURIComponent(marker)}`);
    check('能搜到自己发的消息', found.status === 200 && found.data?.results?.length === 1,
      `结果数 ${found.data?.results?.length}`);

    const bobSearch = await bob.get(`/api/messages/search?q=${encodeURIComponent(marker)}`);
    check('对方也能搜到同一条消息', bobSearch.data?.results?.length === 1);

    const outsiderSearch = await alice.get(`/api/messages/search?q=${encodeURIComponent('批量消息')}&conversationId=${groupId}`);
    check('按会话过滤搜索可用', outsiderSearch.status === 200);

    const pct = await alice.get('/api/messages/search?q=%25');
    check('LIKE 通配符被转义，% 不会扫出全部', pct.status === 200 && (pct.data?.results?.length ?? 0) === 0,
      `结果数 ${pct.data?.results?.length}`);

    const nothing = await alice.get(`/api/messages/search?q=${encodeURIComponent('绝对不存在的字符串xyz')}`);
    check('搜不到时返回空数组', Array.isArray(nothing.data?.results) && nothing.data.results.length === 0);

    // 转发
    const src = await alice.post(`/api/conversations/${dmId}/messages`, { kind: 'text', body: '要转发的内容' });
    const fwd = await alice.post(`/api/messages/${src.data.message.id}/forward`, {
      conversationIds: [groupId],
    });
    check('转发成功', fwd.status === 201 && fwd.data?.messages?.length === 1, JSON.stringify(fwd.data).slice(0, 140));
    check('转发的是同一份内容', fwd.data.messages[0].body === '要转发的内容');
    check('转发到了正确的会话', fwd.data.messages[0].conversationId === groupId);

    const fwdBad = await alice.post(`/api/messages/${src.data.message.id}/forward`, {
      conversationIds: [999999],
    });
    check('转发到不存在的会话被拒', fwdBad.status === 400);

    // 隐藏会话
    const hide = await alice.post(`/api/conversations/${dmId}/hide`);
    check('隐藏会话成功', hide.status === 200);
    check('隐藏后不在列表里',
      !((await alice.get('/api/conversations')).data?.conversations ?? []).some((c) => c.id === dmId));
    const unhide = await alice.post(`/api/conversations/${dmId}/unhide`);
    check('取消隐藏成功', unhide.status === 200);

    // 静音
    const mute = await alice.post(`/api/conversations/${dmId}/mute`, { muted: true });
    check('静音成功', mute.status === 200 && mute.data?.muted === true);
    await alice.post(`/api/conversations/${dmId}/mute`, { muted: false });

    // 输入中（走 HTTP 那条路）
    const typing = await alice.post(`/api/conversations/${dmId}/typing`);
    check('输入中上报成功', typing.status === 200);
  }

  section('9. 个人资料与密码');
  {
    const upd = await alice.patch('/api/auth/me', { displayName: '爱丽丝二世', about: '在山里' });
    check('修改昵称和签名成功', upd.status === 200 && upd.data?.user?.displayName === '爱丽丝二世');

    const empty = await alice.patch('/api/auth/me', { displayName: '   ' });
    check('昵称不能为空', empty.status === 400);

    const longAbout = await alice.patch('/api/auth/me', { about: 'x'.repeat(500) });
    check('签名超长被拒', longAbout.status === 400);

    // 改密会踢掉所有会话，所以用一个独立客户端来测，测完再让 alice 重新登录
    const pwdClient = makeClient('pwd');
    const login1 = await pwdClient.post('/api/auth/login', {
      username: `alice_${stamp}`,
      password: 'correct-horse-battery',
    });
    check('用原密码在第二台设备登录成功', login1.status === 200);

    const wrongPwd = await pwdClient.post('/api/auth/password', {
      currentPassword: 'not-the-password',
      newPassword: 'new-long-password-1',
    });
    check('当前密码错误时改密被拒', wrongPwd.status === 401);

    const change = await pwdClient.post('/api/auth/password', {
      currentPassword: 'correct-horse-battery',
      newPassword: 'new-long-password-1',
    });
    check('改密成功', change.status === 200);
    check('发起改密的这台设备仍然登录着', (await pwdClient.get('/api/auth/me')).status === 200);
    check('其他设备被登出了', (await alice.get('/api/auth/me')).status === 401);

    const oldLogin = await makeClient('old').post('/api/auth/login', {
      username: `alice_${stamp}`,
      password: 'correct-horse-battery',
    });
    check('旧密码不能再登录', oldLogin.status === 401);

    const relogin = await alice.post('/api/auth/login', {
      username: `alice_${stamp}`,
      password: 'new-long-password-1',
    });
    check('新密码可以登录', relogin.status === 200);
    check('重新登录后拿到了新 cookie', alice.hasSession());
  }

  section('10. 登出');
  {
    const before = await bob.get('/api/auth/me');
    check('登出前能拿到自己', before.status === 200);

    const out = await bob.post('/api/auth/logout');
    check('登出返回成功', out.status === 200);
    check('登出后不能再访问', (await bob.get('/api/auth/me')).status === 401);
    check('登出后会话列表也不可访问', (await bob.get('/api/conversations')).status === 401);
  }

  section('11. 其他');
  {
    const health = await alice.get('/healthz');
    check('健康检查可用', health.status === 200 && health.data?.ok === true);

    check('已登录访问未知接口返回 404', (await alice.get('/api/nope')).status === 404);

    const anon = makeClient('anon');
    const head = await anon.get('/api/files/anything', { expectRaw: true });
    check('未登录请求文件返回 401', head.status === 401, `status=${head.status}`);

    const overview = await alice.get('/api/admin/overview');
    check('管理员可以看站点概况', overview.status === 200 && overview.data?.counts?.users >= 5,
      JSON.stringify(overview.data?.counts));
    check('概况里带了磁盘余量', typeof overview.data?.freeDiskBytes === 'number');

    const carolOverview = await carol.get('/api/admin/overview');
    check('普通用户看不了站点概况', carolOverview.status === 403, `status=${carolOverview.status}`);

    // 非法 JSON
    const badJson = await alice.req('POST', '/api/auth/login', {
      raw: '{not json',
      headers: { 'content-type': 'application/json' },
    });
    check('非法 JSON 返回 400', badJson.status === 400, `status=${badJson.status}`);
  }

  section('12. 回归项（曾经出过的问题）');
  {
    // 第 10 节把 bob 登出了，这里要用他先登回来
    await bob.post('/api/auth/login', { username: `bob_${stamp}`, password: 'another-long-password' });

    // 查询参数里的 limit 必须落成整数：LIMIT 2.5 会让 SQLite 抛
    // SQLITE_MISMATCH，接口变成 500。
    const dm = await alice.post('/api/conversations', { type: 'dm', userId: bobId });
    const dmId = dm.data?.conversation?.id;
    await alice.post(`/api/conversations/${dmId}/messages`, { kind: 'text', body: '回归测试' });
    check('limit=2.5 不再 500', (await alice.get(`/api/conversations/${dmId}/messages?limit=2.5`)).status === 200);
    check('limit=abc 回落到默认值', (await alice.get(`/api/conversations/${dmId}/messages?limit=abc`)).status === 200);
    check('搜索 limit=10.5 不再 500',
      (await alice.get('/api/messages/search?q=%E5%9B%9E%E5%BD%92&limit=10.5')).status === 200);

    // intId 不接受 true / '0x10' 这类值（Number() 会把它们变成合法 id）
    check('userId=true 被拒',
      (await alice.post('/api/conversations', { type: 'dm', userId: true })).status === 400);
    check('before=0x10 被拒',
      (await alice.get(`/api/conversations/${dmId}/messages?before=0x10`)).status === 400);

    // 已读位置钳位：乱填一个很大的 messageId 不能把未读算错
    const msgs = await alice.get(`/api/conversations/${dmId}/messages`);
    const maxMsgId = msgs.data?.messages?.at(-1)?.id ?? 0;
    await bob.post(`/api/conversations/${dmId}/read`, { messageId: 99999999 });
    const bobView = (await bob.get(`/api/conversations/${dmId}`)).data?.conversation;
    check('已读位置被钳到本会话的消息区间', bobView?.lastReadMessageId === maxMsgId,
      `lastRead=${bobView?.lastReadMessageId} max=${maxMsgId}`);

    // 上传任务的大小必须是整数，否则任务永远完不成
    check('上传 size=1.5 被拒',
      (await alice.post('/api/uploads/init', { name: 'x.bin', size: 1.5 })).status === 400);
    check('上传 size=true 被拒',
      (await alice.post('/api/uploads/init', { name: 'x.bin', size: true })).status === 400);

    // 并发 complete 只能落一份文件
    const race = await alice.post('/api/uploads/init', { name: 'race.bin', size: 16, mime: 'application/octet-stream' });
    await alice.req('PUT', `/api/uploads/${race.data.uploadId}/chunk/0`, {
      raw: new Uint8Array(16),
      headers: { 'content-type': 'application/octet-stream' },
    });
    const both = await Promise.all([
      alice.post(`/api/uploads/${race.data.uploadId}/complete`),
      alice.post(`/api/uploads/${race.data.uploadId}/complete`),
    ]);
    const codes = both.map((r) => r.status).sort();
    check('并发合并只成功一次', codes[0] === 201 && codes[1] === 409, JSON.stringify(codes));

    // 群头像：不是消息附件，成员也必须能看
    const gInit = await alice.post('/api/uploads/init', { name: 'group.png', size: 8, mime: 'image/png' });
    await alice.req('PUT', `/api/uploads/${gInit.data.uploadId}/chunk/0`, {
      raw: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      headers: { 'content-type': 'application/octet-stream' },
    });
    const gFile = (await alice.post(`/api/uploads/${gInit.data.uploadId}/complete`)).data?.file;
    await alice.patch(`/api/conversations/${groupId}`, { avatarFileId: gFile?.id });
    // 第 7 节里 carol 已经退群、dave 被踢了，现在群里只剩 alice 和 bob
    check('群成员能读到群头像', (await bob.get(`/api/files/${gFile?.id}`, { expectRaw: true })).status === 200);

    // 后加入的成员不该替入群之前的历史背未读
    const late = makeClient('late');
    await late.post('/api/auth/register', {
      username: `late_${stamp}`,
      displayName: '后来的人',
      password: 'sixth-long-password',
      inviteCode,
    });
    const lateId = (await late.get('/api/auth/me')).data?.user?.id;
    await alice.post(`/api/conversations/${groupId}/members`, { userIds: [lateId] });
    const lateView = (await late.get(`/api/conversations/${groupId}`)).data?.conversation;
    check('新成员进群没有历史未读', lateView?.unread === 0, `unread=${lateView?.unread}`);

    // 群主退群之后要有人接手，否则这个群永久没人能管
    await alice.post(`/api/conversations/${groupId}/leave`);
    const afterLeave = (await bob.get(`/api/conversations/${groupId}`)).data?.conversation;
    check('群主退群后群主自动转移',
      (afterLeave?.members || []).some((m) => m.role === 'owner'),
      JSON.stringify((afterLeave?.members || []).map((m) => m.role)));
    check('接手的人真的能管理群聊',
      (await bob.patch(`/api/conversations/${groupId}`, { title: '接手之后改的名' })).status === 200);
  }

  /* ------------------------------------------------------------------ */

  console.log(`\n${'='.repeat(56)}`);
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  if (failures.length) {
    console.log('\n失败明细：');
    for (const f of failures) console.log(`  - ${f}`);
  }
  console.log('='.repeat(56));
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error('\n冒烟测试崩了：', err);
  process.exit(1);
});
