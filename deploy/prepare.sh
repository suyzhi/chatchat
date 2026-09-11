#!/usr/bin/env bash
# ==========================================================================
# Vellum 一键部署准备。
#
# 做四件事：
#   1. 生成 .env（含一个随机的 SESSION_SECRET）
#   2. 问你要域名，写进 .env
#   3. 建 data 目录，并把属主改成容器里那个 node 用户（uid 1000）
#   4. 检查 Docker 在不在
#
# 用法：  bash deploy/prepare.sh
# ==========================================================================
set -euo pipefail

cd "$(dirname "$0")/.."

say()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- Docker
if ! command -v docker >/dev/null 2>&1; then
  die "没找到 docker。先装 Docker：
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker"
fi
if ! docker compose version >/dev/null 2>&1; then
  die "Docker 装好了，但缺少 compose 插件。试试： apt install docker-compose-plugin"
fi
say "Docker 环境正常"

# ---------------------------------------------------------------- .env
if [ -f .env ]; then
  warn ".env 已经存在，跳过生成。要重新生成就先把它删掉或改名。"
else
  read -rp "你的域名（例如 chat.example.com）: " DOMAIN
  [ -n "$DOMAIN" ] || die "域名不能为空。没有域名就没法自动签发 HTTPS 证书。"

  SECRET="$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"

  # 从模板出发，只替换这两行，其余保持注释状态
  sed -e "s|^SESSION_SECRET=.*|SESSION_SECRET=${SECRET}|" \
      -e "s|^SITE_DOMAIN=.*|SITE_DOMAIN=${DOMAIN}|" \
      .env.example > .env

  chmod 600 .env
  say "已生成 .env（SESSION_SECRET 是随机的，SITE_DOMAIN=${DOMAIN}）"
fi

# ---------------------------------------------------------------- 数据目录
# 容器以 uid 1000 运行。宿主机上这个目录必须先归它，否则启动后会写不进数据库。
mkdir -p data/uploads data/tmp
if [ "$(id -u)" = "0" ]; then
  chown -R 1000:1000 data
  say "已创建 data/ 并设置属主为 1000:1000"
else
  if chown -R 1000:1000 data 2>/dev/null; then
    say "已创建 data/ 并设置属主为 1000:1000"
  else
    warn "没能修改 data/ 的属主。如果启动后报数据库只读，执行：
       sudo chown -R 1000:1000 \"$(pwd)/data\""
  fi
fi

# ---------------------------------------------------------------- 收尾
cat <<'EOF'

准备完成。接下来：

  1. 确认域名已经解析到这台服务器的公网 IP
  2. 确认腾讯云安全组放通了 80 和 443 端口
  3. 启动：  docker compose up -d
  4. 看日志拿邀请码：  docker compose logs vellum | head -40

启动后打开你的域名，注册的第一个账号自动成为管理员。
EOF
