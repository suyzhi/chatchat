# Vellum

一个只给几个人用的私人聊天站。自己部署在自己的服务器上，没有注册入口给陌生人，没有信息流，没有推荐。

亮色编辑感：纸白底、墨黑字、一个冷钴蓝强调色。整套界面只有一套圆角规则、六档字阶、一个彩色。

---

## 它有什么

**聊天**
- 单聊和群聊（建群、拉人、退群、移除成员、改群名）
- 文字、图片、语音、视频、任意文件
- 回复引用、编辑、撤回、转发
- 已读回执、正在输入、在线状态
- 历史消息分页、全文搜索、未读计数
- 消息按天分组，同一人连续发言自动合并

**发东西的三种方式**
- 点按钮选文件、直接 Ctrl+V 粘贴、把文件拖进窗口

**大文件**
- 分块上传，单文件默认上限 4 GB（可调到更大）
- 上传时并发 3 块，出错的块单独重试 3 次
- 传了一半断开或刷新页面，重新选同一个文件会接着传，不用从零开始
- 服务端边收边落盘，内存占用和文件大小无关

**语音**
- 浏览器直接录，实时电平显示，最长 5 分钟（可调）
- 短语音自动解码出波形，播放时可以点进度条跳转

**其他**
- 图片点开有大图灯箱，保留原始宽高比不跳版
- 系统通知（页面在后台时），标题栏未读数
- 手机端自适应，底部导航
- 深色模式：本版本不含，加的话只需要补一组 CSS 变量

**安全**
- 邀请码注册，第一个账号自动成为管理员
- 密码用 scrypt 哈希（内存硬，抗 GPU 爆破）
- 会话存在数据库里，可以「登出所有设备」
- 文件下载要校验你是不是这条消息的接收方，不是猜不到 URL 就能下
- 所有用户内容走 `textContent` 渲染，不拼 HTML
- 登录限流、上传配额、磁盘余量保护

---

## 本地跑起来

需要 Node.js 20 或更高。

```bash
npm install
npm start
```

打开 `http://127.0.0.1:8787`，注册第一个账号（自动成为管理员）。

可选：把 `.env.example` 复制成 `.env` 改配置。不配也能跑，会话密钥会随机生成（代价是重启后需要重新登录）。

```bash
cp .env.example .env
```

---

## 部署到腾讯云

看 [`deploy/README.md`](deploy/README.md)，从买服务器到朋友能聊天，一步一步写好了。

一句话版本：

```bash
bash deploy/prepare.sh      # 生成配置、建数据目录
docker compose up -d        # 起应用 + Caddy（自动 HTTPS）
docker compose logs vellum  # 看邀请码
```

---

## 技术选择

| 决定 | 原因 |
| --- | --- |
| **零构建前端** | 原生 ES 模块 + 手写 CSS。服务器上不需要 `npm run build`，改完刷新就生效。部署产物就是源码本身 |
| **SQLite（better-sqlite3）** | 几个人的聊天量，一个文件就是一个数据库。备份就是拷一个文件，迁移就是拷一个目录 |
| **WebSocket 只负责推送** | 写操作全走 HTTP：错误能正常返回、断线不丢消息、反代不用特殊配置。即使 WebSocket 挂了，除了不实时之外一切照常 |
| **服务端嗅探图片尺寸** | 读文件头拿宽高，不装图像库，也让前端能在图片加载前就按真实比例占位，不跳版 |
| **字体自托管** | 只发拉丁字母子集（约 82 KB），中文交给各平台系统字体。不引 CDN，私有部署不该依赖外网 |
| **图标从官方源生成** | `tools/build-icons.mjs` 从 `@phosphor-icons/core` 提取用到的路径，产物 26 KB，没有手写的 SVG |

### 目录

```
src/
  server.js        进程入口：静态资源、API 挂载、优雅退出
  config.js        所有环境变量在这里收口
  db.js            表结构 + 常用查询
  auth.js          scrypt 密码、数据库会话、限流
  invite.js        邀请码（自动生成 + 轮换）
  realtime.js      WebSocket：推送、在线状态、心跳
  presence.js      在线状态表（单独成模块，避免循环依赖）
  serialize.js     数据库行 -> 对外 JSON
  conv.js          会话视图组装（HTTP 和 WebSocket 共用）
  http.js          异步包装、参数校验、安全响应头
  util.js          MIME 归类、图片尺寸嗅探、磁盘余量
  routes/          auth / admin / users / conversations / messages / uploads / files

public/
  index.html
  css/tokens.css   设计令牌：颜色、字阶、间距、圆角、动效
  css/app.css      布局与组件
  js/
    app.js         入口：装配视图、接通实时事件、通知
    api.js         HTTP 封装
    store.js       应用状态 + 事件总线
    socket.js      WebSocket 客户端（指数退避重连）
    upload.js      分块上传（并发、重试、断点续传、音频探测）
    recorder.js    录音（按浏览器能力挑编码）
    dom.js         DOM 小工具（不拼 innerHTML）
    emoji.js       表情数据
    format.js      时间、字节、文件类型
    icon.js        图标渲染（路径来自生成文件）
    icons.js       自动生成，勿手改
    overlays.js    对话框、菜单、灯箱
    views/         auth / shell / parts / list / thread / composer / dialogs

tools/
  build-icons.mjs    从 Phosphor 官方源生成图标模块
  check-imports.mjs  静态检查前端模块的 import / export 一致性
  smoke.mjs          接口层端到端测试（163 项）
  browser-check.mjs  真浏览器端到端测试（70 项）
  screenshot.mjs     界面截图，用来肉眼检查排版
```

---

## 配置

全部环境变量和说明在 [`.env.example`](.env.example)。只有两个建议一定要设：

```bash
SESSION_SECRET=$(openssl rand -hex 32)   # 不设的话重启会让所有人重新登录
SITE_DOMAIN=chat.example.com            # 自动签发 HTTPS 证书要用
```

---

## 测试

```bash
npm run smoke      # 接口层：注册、鉴权、消息、分块上传、群聊、撤回、搜索、权限
npm run check      # 前端模块 import / export 一致性（浏览器里才会炸的错误）
npm run browser    # 真浏览器跑一遍界面，顺便收集控制台报错
npm run shots      # 截图到 ./screenshots
```

`smoke` 需要一个干净数据库（第一个账号免邀请码）。`browser` 会自己起一个临时实例，可以反复跑。

`check` 这个检查值得单独说一句：ESM 的具名导入是运行时解析的，把 `highlight` 从 `format.js` 里导入（实际在 `dom.js`）这种错误，Node 静态检查和编辑器都不一定报，只有在浏览器里打开才会白屏。这个脚本专门盯这类问题。

---

## 还没做的

诚实列一下，免得你以为是 bug：

- **没有深色模式**。令牌已经按可换肤的方式组织好了，补一组变量和 `prefers-color-scheme` 就行。
- **没有表情回应（reaction）**。要加的话需要一张新表和几个接口。
- **没有「删除单条消息只对自己」**。撤回是双方都撤，不保留原文。
- **没有端到端加密**。这是自托管站点，服务器管理员（也就是你）能看到所有消息和文件。如果连你自己都不该看到内容，那就需要另一套设计。
- **在线状态是单进程内存**。要横向扩到多台机器得换成 Redis。
- **没有 WebRTC 音视频通话**。

---

## 许可

代码随便用。图标来自 [Phosphor Icons](https://phosphoricons.com/)（MIT），字体是 [Geist](https://vercel.com/font)（OFL）。
