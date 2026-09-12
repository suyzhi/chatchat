# 部署到腾讯云

从一台空服务器到可以用手机和电脑聊天，大约 15 分钟。全程只需要改一个域名。

下面以 **腾讯云轻量应用服务器** 为例（CVM 云服务器步骤完全一样）。

---

## 0. 买服务器

| 项目 | 建议 |
| --- | --- |
| 机型 | 轻量应用服务器，**2 核 2G** 起步 |
| 系统 | Ubuntu 22.04 或 24.04 |
| 硬盘 | 按你要存多少图片和文件来定。系统盘 50G 起步，聊天文件多就 100G |
| 带宽 | 3 Mbps 够几个人用。要传大文件建议 5 Mbps 以上 |
| 地域 | 选离你和朋友都近的，比如上海、广州 |

> 内存 1G 也能跑，但构建镜像时容易因为内存不足失败。真只有 1G，就在本地构建好镜像再推上去。

**关于备案**：用大陆地域的服务器绑域名，域名必须完成 ICP 备案才能通过 80/443 访问。不想备案就选**香港**或**新加坡**地域，代价是延迟高一些。

---

## 1. 放通端口

到轻量应用服务器的**防火墙**页面（CVM 是**安全组**），放通这两个：

| 端口 | 协议 | 用途 |
| --- | --- | --- |
| 80 | TCP | 申请 HTTPS 证书、http 跳转 |
| 443 | TCP | 正式访问 |

这一步漏了的话，后面证书一定签不下来，表现是浏览器一直转圈或者报连接超时。

---

## 2. 解析域名

在域名管理里加一条 A 记录：

```
主机记录   chat
记录类型   A
记录值     你的服务器公网 IP
```

等一两分钟，用 `ping chat.你的域名` 确认已经指向你的服务器。

---

## 3. 装 Docker

SSH 登录服务器，然后：

```bash
curl -fsSL https://get.docker.com | sh
systemctl enable --now docker
```

验证：

```bash
docker compose version
```

国内服务器拉 Docker Hub 镜像可能很慢。如果卡住，配一下加速器：

```bash
sudo mkdir -p /etc/docker
sudo tee /etc/docker/daemon.json <<'EOF'
{
  "registry-mirrors": [
    "https://mirror.ccs.tencentyun.com",
    "https://docker.m.daocloud.io"
  ]
}
EOF
sudo systemctl restart docker
```

> `mirror.ccs.tencentyun.com` 只在腾讯云内网可用。如果加速器失效导致拉不动，去掉这段再试。

---

## 4. 上传代码

**方式一：直接在服务器上建（推荐，最省事）**

如果代码在你本地电脑上，用 `scp` 传上去：

```bash
# 在本地电脑执行，把当前目录传到服务器的 /opt/vellum
# 必须是 `.`（整个目录），不能写 `./*` —— 通配符不带隐藏文件，
# .env.example / .dockerignore 传不过去，下一步 prepare.sh 会直接失败，
# 而且失败时已经生成了一个空的 .env，重试还会被「.env 已存在」挡住。
scp -r . root@你的服务器IP:/opt/vellum/
```

传输前记得删掉本地的 `node_modules/` 和 `data/`（前者又大又没用，
后者的数据库不该覆盖服务器上的）；`scp` 不会自动跳过它们。

**方式二：走 Git**

把代码推到你的私有仓库，然后在服务器上：

```bash
git clone 你的仓库地址 /opt/vellum
```

传完之后：

```bash
cd /opt/vellum
ls
# 应该能看到 Dockerfile、docker-compose.yml、src、public、deploy
```

---

## 5. 一键准备

```bash
bash deploy/prepare.sh
```

脚本会问你域名，然后自动生成 `.env`（包含一个随机的会话密钥）、建好 `data` 目录、设好权限。

如果你想手动来，等价的操作是：

```bash
cp .env.example .env
# 生成一个密钥填进 SESSION_SECRET
openssl rand -hex 32
# 编辑 .env，至少填 SESSION_SECRET 和 SITE_DOMAIN
nano .env
# 建数据目录并把属主改成容器里的 node 用户（uid 1000）
mkdir -p data/uploads data/tmp
sudo chown -R 1000:1000 data
```

> **`chown` 这一步不能省。** 容器里的应用以 uid 1000 运行，如果 `data` 目录归 root，启动后会报数据库只读。

---

## 6. 启动

```bash
docker compose up -d
```

第一次会构建镜像，大概两三分钟。然后看日志：

```bash
docker compose logs -f vellum
```

看到这样的输出就成功了：

```
  Vellum 已启动

  站点名称      Vellum
  监听          0.0.0.0:8787
  数据目录      /app/data
  注册开关      开启（需要邀请码）
  ...

  还没有任何账号：打开下面的地址注册，第一个账号自动成为管理员，不需要邀请码。
```

同时 Caddy 会自动去申请 HTTPS 证书。看它的日志：

```bash
docker compose logs -f caddy
```

出现 `certificate obtained successfully` 就说明证书拿到了。

---

## 7. 注册你自己

浏览器打开 `https://chat.你的域名`。

**第一个注册的账号自动成为管理员，不需要邀请码。** 用户名只能用字母、数字、下划线、连字符，3 到 24 位。

注册完如果看到「你是这台服务器上的第一个账号，已获得管理员身份」，就对了。

---

## 8. 把朋友加进来

注册完之后，服务器日志里会多出一行邀请码：

```bash
docker compose logs vellum | grep 邀请码
```

```
  邀请码        K7M2XQ9P4R   (自动生成，可在设置里更换)
                把地址和这串邀请码一起发给朋友，他们就能注册。
```

也可以直接在网页上拿：点左下角**设置**，最上面就是邀请码，能复制，也能一键换一个新的。

把 **网址 + 邀请码** 发给朋友，他们就能注册了。

---

## 日常运维

### 备份

```bash
bash deploy/backup.sh              # 数据库 + 上传的文件
bash deploy/backup.sh --db-only    # 只备数据库（很小）
```

数据库和文件包会打包到 `./backups`。数据库是 WAL 模式，所以归档出来的是
`vellum-db-*.tar.gz`（里面是 `vellum.db`，必要时还有 `-wal`/`-shm`）；
恢复时整个解压进 `data/` 覆盖即可，不要只挑 `vellum.db` 一个文件。

**保留份数是按数据特性分的，别改错**：数据库只有几 MB，留 14 份；但上传的文件可能涨到几十 GB，留 14 份会把磁盘撑爆，所以文件包只留 3 份，而且超过可用磁盘 20% 时会直接跳过并警告。

每日数据库备份建议挂上（数据量小，完全安全）：

```bash
crontab -e
# 加一行
0 3 * * * cd /opt/vellum && bash deploy/backup.sh --db-only >> /var/log/vellum-backup.log 2>&1
```

> **同机备份只能防误删，防不了机器挂掉。** 上传的图片和文件才是真正不可再生的东西，请定期同步到别处。腾讯云的话用 COS 最省事：
>
> ```bash
> # 装 rclone 后配置好 COS，然后每周同步一次
> rclone sync /opt/vellum/data/uploads cos:vellum-backup/uploads
> ```
>
> 也可以直接把 `data/` 整个目录 rsync 到你的电脑或 NAS 上。

### 升级

```bash
cd /opt/vellum
bash deploy/backup.sh        # 先备份
git pull                     # 或者重新 scp 覆盖
docker compose up -d --build
```

数据库结构是自动迁移的，不需要手动执行 SQL。

### 改配置

改 `.env` 之后重启：

```bash
docker compose up -d
```

### 看状态 / 排错

```bash
docker compose ps                 # 两个容器都应该是 healthy / running
docker compose logs --tail=100 vellum
docker compose logs --tail=100 caddy
docker compose exec vellum sh     # 进容器里看看
```

### 停掉

```bash
docker compose down          # 停止，数据保留在 ./data
docker compose down -v       # 连 Caddy 的证书卷一起删（数据目录不受影响）
```

---

## 常见问题

**证书签不下来，Caddy 一直报错**

按顺序检查：

1. `ping 你的域名` 是不是指向这台服务器的公网 IP
2. 腾讯云防火墙 / 安全组有没有放通 80 和 443
3. 服务器上有没有别的程序占了 80 端口：`sudo ss -lntp | grep :80`
4. 大陆服务器域名有没有备案

Let's Encrypt 有频率限制（同一个域名一周最多 5 次失败重试）。反复失败就先停下来查清楚原因，不要一直重启。

**上传大文件失败**

- 用 Caddy 部署不会有限制。用自己 Nginx 的话，检查 `client_max_body_size` 是否大于 `CHUNK_MB`（见 `deploy/nginx.conf`）。
- 磁盘满了会返回 507 并提示「服务器磁盘空间不足」。`df -h` 看一下。
- 想限制每个人每天的用量，在 `.env` 里设 `DAILY_UPLOAD_MB`。

**启动后报数据库只读 / 无法写入**

`data` 目录属主不对：

```bash
sudo chown -R 1000:1000 ./data
docker compose restart vellum
```

**改了 `.env` 但不生效**

`docker compose up -d` 会重建容器。如果只改了端口映射，用 `docker compose up -d --force-recreate`。

**所有人突然都要重新登录**

`SESSION_SECRET` 没设置。检查 `.env` 里这一行是不是空的。设好之后重启，以后就不会了。

**想让注册彻底关闭**

`.env` 里设 `ALLOW_REGISTER=false`，然后 `docker compose up -d`。已注册的人不受影响。

**换服务器 / 迁移**

把整个 `data` 目录和 `.env` 拷过去，`docker compose up -d` 就完事了。数据库和文件都在 `data` 里，没有别的地方藏东西。

---

## 服务器上已经有别的服务占了 80/443？

很常见：一台机器上跑着好几个应用，谁先起来谁抢到端口，重启之后听天由命。

正确的做法是**让 Caddy 独占 80/443，按域名分流转发**，而不是让每个应用各自抢端口。

### 判断现有服务的情况

```bash
# 谁占着 80/443
sudo ss -lntp | grep -E ':(80|443)\b'

# 如果是个 systemd 服务
systemctl status <服务名>
```

关键要看它的**主服务端口**是哪个。很多应用会把 80/443 当成"顺便绑一下方便访问"的附带功能，主服务其实在别的端口上，这种最好处理。

### 接管步骤

假设现有服务叫 `legacy-app`，主服务在 3000 端口，80/443 只是它附带的便利绑定：

**1. 给那个服务加一个开关，让它别抢端口**

最干净的做法是加 systemd drop-in，**不要改它原始的 unit 文件**（升级时不会被覆盖，回退只需删掉这个文件）：

```bash
sudo mkdir -p /etc/systemd/system/legacy-app.service.d
sudo tee /etc/systemd/system/legacy-app.service.d/override.conf <<'EOF'
[Service]
Environment=BIND_EXTRA_PORTS=0
EOF
sudo systemctl daemon-reload
```

这要求那个应用自己支持这个环境变量。如果没有，就得改它的代码加一个判断，或者在 Caddy 起来之后重启它（前提是它绑定失败时能优雅降级而不是崩溃）。

> ⚠️ **一个容易忽略的坑**：Node 里 `server.listen()` 的失败是**异步通过 `'error'` 事件**抛出的，外层 `try/catch` 拦不住。如果代码里没有 `server.on('error', ...)`，端口被占用时会直接抛未捕获异常，进程退出。配合 systemd 的 `Restart=always`，结果就是**无限崩溃重启**。改之前先确认一下那个应用有没有这个监听器。

**2. 在 Caddyfile 里给它加一个站点**

```caddyfile
legacy.example.com {
    # 如果这个域名后面还挂着 Cloudflare（橙色云朵，Full 模式回源），
    # 用内部证书就够了，因为 Full 模式不校验源站证书
    tls internal
    reverse_proxy host.docker.internal:3000
}
```

宿主机上的服务要在 compose 里给 caddy 加上 `extra_hosts: ["host.docker.internal:host-gateway"]`。

**3. 交接端口**

顺序很重要：

```bash
sudo systemctl stop legacy-app         # 释放 80/443
docker compose up -d caddy             # Caddy 接管，顺便申请证书
sudo systemctl start legacy-app        # 它这次只监听 3000
```

这三步之间那个服务会短暂不可用（几十秒）。写自动化脚本的话，记得在每一步之后做校验，任何一步失败就自动回滚成原来的样子。

### 怎么判断 Cloudflare 回源走的是 80 还是 443

这决定了 Caddy 该怎么配，猜错会把现有站点弄挂。实测方法：

```bash
# 服务器上开一个采样器
for i in $(seq 1 60); do
  ss -tn state established | awk '{print $3}' | sed 's/.*://' | grep -E '^(80|443)$'
  sleep 0.3
done | sort | uniq -c
```

同时从外网访问那个域名几次。结果里哪个端口有计数，Cloudflare 用的就是哪个：

- **只有 443** → SSL 模式是 Full 或 Full (strict)。源站必须提供 HTTPS，用 `tls internal` 即可（Full 不校验证书；Full strict 需要真证书）。
- **只有 80** → SSL 模式是 Flexible。源站在 80 端口必须返回明文内容，**不能强制跳转 HTTPS**，否则会死循环。这种情况下给那个站点关掉自动跳转：`auto_https disable_redirects`。

---

## 不用 Caddy，继续用你自己的 Nginx

`docker compose up -d vellum` 只启动应用，它绑定在 `127.0.0.1:8787`。

然后参考 `deploy/nginx.conf`，里面有完整的 server 块，包含两个容易漏的地方：

- `client_max_body_size` 必须大于 `CHUNK_MB`，否则分块上传会被 413 拦掉；
- WebSocket 的 `Upgrade` / `Connection` 头必须转发，否则消息不会实时推送。

证书可以用 certbot：

```bash
sudo apt install certbot
sudo certbot certonly --webroot -w /var/www/certbot -d chat.你的域名
```
