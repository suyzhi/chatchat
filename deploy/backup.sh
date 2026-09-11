#!/usr/bin/env bash
# ==========================================================================
# Vellum 备份。
#
# 备份两样东西：
#   1. 数据库（用 SQLite 自己的 .backup，运行中也安全，不会拷到写了一半的状态）
#   2. 上传的文件目录
#
# 用法：
#   bash deploy/backup.sh                  # 数据库 + 文件，存到 ./backups
#   bash deploy/backup.sh --db-only        # 只备份数据库（很小，适合放进 crontab）
#   bash deploy/backup.sh /mnt/backup      # 换个存放位置
#
# 关于保留份数，这里有个容易踩的坑：
#   数据库很小（几 MB），留 14 份毫无压力；
#   但上传的文件可能涨到几十 GB，留 14 份会把磁盘撑爆。
#   所以文件包默认只留 3 份，而且超过可用磁盘 20% 时会拒绝打包并给出提示。
#
# 放在同一块盘上的备份只能防误删，防不了机器挂掉。
# 真正重要的东西请用对象存储或 rclone 同步到别处（见 deploy/README.md）。
# ==========================================================================
set -euo pipefail

cd "$(dirname "$0")/.."

DEST="./backups"
DB_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --db-only) DB_ONLY=1 ;;
    *) DEST="$arg" ;;
  esac
done

DB_KEEP=14
FILES_KEEP=3

STAMP="$(date +%Y%m%d-%H%M%S)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$DEST"
say()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }

[ -f data/vellum.db ] || { echo "找不到 data/vellum.db，没什么可备份的。"; exit 0; }

# ---------------------------------------------------------------- 数据库
say "备份数据库（在线安全备份）"
if docker compose ps --status running --services 2>/dev/null | grep -qx vellum; then
  # 容器里没有 sqlite3 命令行，用 node + better-sqlite3 的在线备份 API。
  # 直接 cp 数据库文件在写入过程中会拷到损坏的状态，所以必须走 .backup()。
  # 用 process.exit 明确结束，不依赖事件循环自然退出。
  docker compose exec -T vellum node -e "const D=require('better-sqlite3');const db=new D('/app/data/vellum.db',{readonly:true});db.backup('/app/data/.backup-tmp.db').then(()=>{db.close();process.exit(0)}).catch(e=>{console.error(e);process.exit(1)})"
  # 用 exec + 重定向而不是 compose cp，老版本 compose 没有 cp 子命令
  docker compose exec -T vellum cat /app/data/.backup-tmp.db > "$WORK/vellum.db"
  docker compose exec -T vellum rm -f /app/data/.backup-tmp.db
else
  # 服务没在跑，文件是静止的，直接拷
  cp data/vellum.db "$WORK/vellum.db"
fi
say "  数据库已导出： $(du -h "$WORK/vellum.db" | cut -f1)"

DBGZ="$DEST/vellum-db-$STAMP.db.gz"
gzip -c "$WORK/vellum.db" > "$DBGZ"
say "  已归档： $(basename "$DBGZ")  $(du -h "$DBGZ" | cut -f1)"

# ---------------------------------------------------------------- 文件
if [ "$DB_ONLY" = "1" ]; then
  say "跳过文件打包（--db-only）"
elif [ -d data/uploads ] && [ -n "$(ls -A data/uploads 2>/dev/null)" ]; then
  UPLOAD_SIZE=$(du -sb data/uploads | cut -f1)
  FREE_KB=$(df -Pk . | awk 'NR==2 {print $4}')
  FREE=$((FREE_KB * 1024))
  # 备份最多占可用空间的 20%，留足余量给正常上传
  BUDGET=$((FREE / 5))
  if [ "$UPLOAD_SIZE" -gt "$BUDGET" ]; then
    warn "上传目录有 $(numfmt --to=iec "$UPLOAD_SIZE" 2>/dev/null || echo "${UPLOAD_SIZE}B")，"
    warn "超过可用磁盘的 20%，跳过文件打包以免撑爆磁盘。"
    warn "请改用对象存储同步（见 deploy/README.md），或手工执行并指定别的位置。"
  else
    say "打包上传的文件（约 $(numfmt --to=iec "$UPLOAD_SIZE" 2>/dev/null || echo "${UPLOAD_SIZE}B")）"
    TAR="$DEST/vellum-files-$STAMP.tar.gz"
    tar -czf "$TAR" -C data uploads
    say "  已归档： $(basename "$TAR")  $(du -h "$TAR" | cut -f1)"
  fi
else
  say "还没有上传过文件，跳过"
fi

# ---------------------------------------------------------------- 清理
# 数据库多留几份，文件包少留几份，原因见文件开头的说明
for pair in "vellum-db-:$DB_KEEP" "vellum-files-:$FILES_KEEP"; do
  prefix="${pair%%:*}"
  keep="${pair##*:}"
  ls -1t "$DEST/${prefix}"* 2>/dev/null | tail -n +$((keep + 1)) | while read -r old; do
    rm -f "$old"
    say "  清理旧备份： $(basename "$old")"
  done
done

# ---------------------------------------------------------------- 汇总
TOTAL=$(du -sh "$DEST" 2>/dev/null | cut -f1)
echo
say "完成。备份在 $DEST，当前共 $TOTAL"
echo "  恢复方法：停掉服务，把 .db.gz 解压回 data/vellum.db，"
echo "            把 files 包解压回 data/，再启动。"
echo
echo "  提醒：同机备份只能防误删。请把 $DEST 同步到别的地方。"

