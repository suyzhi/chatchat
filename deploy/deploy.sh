#!/usr/bin/env bash
# ==========================================================================
#  Vellum 服务器端部署脚本（在 VPS 上跑，别在本地跑）
#
#  前提：新代码已经解包到 /opt/vellum（由 deploy/update-vps.cmd 完成）。
#  这个脚本负责：备份 → 重建镜像 → 重启 → 自检。
#
#  之所以要「重建镜像」而不是重启容器：前端（public/）是 COPY 进镜像的，
#  不是挂载卷。只 restart 的话容器里还是旧的那份 public/，改了等于没改。
#
#  用法：
#      bash /opt/vellum/deploy/deploy.sh
#  回滚：
#      tar -xzf /root/vellum-backup-<时间戳>.tar.gz -C /opt/vellum
#      cd /opt/vellum && docker compose -f docker-compose.yml -f deploy/docker-compose.ip8443.yml up -d --build
# ==========================================================================
set -euo pipefail

APP_DIR=/opt/vellum

cd "$APP_DIR"

# --------------------------------------------------------------------------
# 0. 用哪份 compose 覆盖文件
#
# 服务器上的 Caddy 配置是「就地改过」的：从 IP + 自签证书换成了域名 + 自动
# HTTPS，文件名叫 docker-compose.ip8443.yml 但内容指向 Caddyfile.ip8443-domain。
# 所以这里按「域名版优先、自签版兜底」选，而不是写死一个 —— 写死的话，
# 一旦有人把仓库里那份旧的自签版同步上来，HTTPS 会当场退回自签证书。
# --------------------------------------------------------------------------
if [ -f deploy/docker-compose.ip8443.yml ] && grep -q 'Caddyfile.ip8443-domain' deploy/docker-compose.ip8443.yml; then
  OVERRIDE=deploy/docker-compose.ip8443.yml
elif [ -f deploy/docker-compose.ip8443-domain.yml ]; then
  OVERRIDE=deploy/docker-compose.ip8443-domain.yml
else
  OVERRIDE=deploy/docker-compose.ip8443.yml
fi
COMPOSE="docker compose -f docker-compose.yml -f $OVERRIDE"

# --------------------------------------------------------------------------
# 0b. 关键文件自检：解包解漏了要在这里就停下，别把线上搞成半截状态
# --------------------------------------------------------------------------
for f in docker-compose.yml Dockerfile .env package.json src/server.js public/index.html \
         public/css/fx.css public/js/fx.js "$OVERRIDE"; do
  if [ ! -f "$f" ]; then
    echo "缺少 $f —— 解包不完整，先别继续。" >&2
    exit 1
  fi
done
CADDY=$(grep -oE '\./deploy/Caddyfile[^:]*' "$OVERRIDE" | head -1 | sed 's|^\./||')
if [ -n "$CADDY" ] && [ ! -f "$CADDY" ]; then
  echo "compose 里挂的 $CADDY 不存在 —— Caddy 起不来，先别继续。" >&2
  exit 1
fi
echo "compose 覆盖文件：$OVERRIDE（Caddyfile: ${CADDY:-未指定}）"
echo "关键文件齐全，data/ 大小：$(du -sh data 2>/dev/null | cut -f1)"

# --------------------------------------------------------------------------
# 1. 备份改动前的代码（不含 data/，那是数据库和上传的文件，另行备份）
# --------------------------------------------------------------------------
STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP="/root/vellum-backup-$STAMP.tar.gz"
tar --exclude='./data' --exclude='./node_modules' --exclude='./.git' \
  -czf "$BACKUP" -C "$APP_DIR" .
echo "已备份到 $BACKUP（$(du -h "$BACKUP" | cut -f1)）"

# --------------------------------------------------------------------------
# 2. 重建并重启
# --------------------------------------------------------------------------
echo
echo ">>> 重建镜像并重启（首次重建要装原生模块，可能几分钟）"
$COMPOSE up -d --build

# --------------------------------------------------------------------------
# 3. 自检
# --------------------------------------------------------------------------
echo
echo ">>> 等待健康检查通过"
HEALTH=no
for i in $(seq 1 40); do
  if curl -fsS -m 3 http://127.0.0.1:8787/healthz >/dev/null 2>&1; then
    HEALTH=yes
    break
  fi
  sleep 1
done
echo "本机 healthz: $HEALTH"

echo
echo ">>> 经 Caddy 访问（从服务器自己发起）"
for path in /healthz / /css/fx.css /js/fx.js; do
  code=$(curl -k -s -o /dev/null -w '%{http_code}' -m 8 "https://127.0.0.1:8443$path" \
         -H 'Host: chat.suyzhi.icu' || echo 000)
  echo "  $code  $path"
done

echo
echo ">>> 从公网域名访问"
for path in /healthz /css/fx.css /js/fx.js; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 10 "https://chat.suyzhi.icu:8443$path" || echo 000)
  echo "  $code  $path"
done

echo
echo ">>> 容器状态"
docker ps --filter name=vellum --format '  {{.Names}}  {{.Status}}'

echo
echo ">>> 最近日志"
$COMPOSE logs --tail=15 vellum

echo
echo "======================================================================"
if [ "$HEALTH" = "yes" ]; then
  echo "部署完成。回滚：tar -xzf $BACKUP -C $APP_DIR && cd $APP_DIR && $COMPOSE up -d --build"
else
  echo "容器没通过健康检查，先看上面的日志。备份在 $BACKUP"
  exit 1
fi
echo "======================================================================"
