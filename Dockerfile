# ==========================================================================
# Vellum 运行镜像
#
# 两段式：builder 装依赖（含编译工具，防止 better-sqlite3 没有现成二进制时
# 编译失败），runtime 只带走 node_modules 和源码，镜像更小。
# APT_MIRROR：Debian 软件源。默认留空 = 用官方源 deb.debian.org。
#
# 这里原来是 mirrors.tencentyun.com（腾讯云**内网**源）。它只在腾讯云的机器上
# 能解析，一旦换到别家（甲骨文、搬瓦工、自建机房……）就是
# "Something wicked happened resolving ... No address associated with hostname"，
# 构建会在 apt 那一步直接失败 —— 而这一步失败的原因跟代码毫无关系，很容易
# 被误判成代码有问题。所以默认改成谁都能用的官方源。
#
# 机器确实在腾讯云内网、想省那点下载时间的话，显式传回去：
#   docker compose build --build-arg APT_MIRROR=mirrors.tencentyun.com
# ==========================================================================

# --------------------------------------------------------------------------
# 第一段：装依赖
# --------------------------------------------------------------------------
FROM node:22-bookworm-slim AS builder

ARG APT_MIRROR=
ARG DEBIAN_MIRROR=deb.debian.org

WORKDIR /app

# better-sqlite3 是原生模块。有预编译包时这几步用不上，没有时它们保证能编译出来。
# 放在 builder 里，最终镜像不会背上编译器。
#
# 源不通时自动退回官方源：换源这件事本身不该成为构建失败的理由。
RUN set -eux; \
    apt_ok=0; \
    if [ -n "$APT_MIRROR" ]; then \
      echo "使用指定软件源: ${APT_MIRROR}"; \
      if apt-get -o Acquire::Retries=2 update >/dev/null 2>&1 \
         && apt-get install -y --no-install-recommends python3 make g++ >/dev/null 2>&1; then \
        apt_ok=1; \
      else \
        echo "指定软件源不可用，退回 ${DEBIAN_MIRROR}" >&2; \
      fi; \
    fi; \
    if [ "$apt_ok" = "0" ]; then \
      if [ -f /etc/apt/sources.list.d/debian.sources ]; then \
        sed -i "s|deb.debian.org|${DEBIAN_MIRROR}|g; s|security.debian.org|${DEBIAN_MIRROR}|g" /etc/apt/sources.list.d/debian.sources; \
      fi; \
      if [ -f /etc/apt/sources.list ]; then \
        sed -i "s|deb.debian.org|${DEBIAN_MIRROR}|g; s|security.debian.org|${DEBIAN_MIRROR}|g" /etc/apt/sources.list; \
      fi; \
      apt-get -o Acquire::Retries=3 update; \
      apt-get install -y --no-install-recommends python3 make g++; \
    fi; \
    rm -rf /var/lib/apt/lists/*

# 只复制清单文件，改源码不会让依赖层失效
COPY package.json package-lock.json ./

# 字体包（@fontsource-variable/*）在 dependencies 里，必须装，否则页面没有字体。
# 图标是预先生成好的，随源码一起进镜像，不需要 @phosphor-icons/core。
RUN npm ci --omit=dev --no-audit --no-fund

# --------------------------------------------------------------------------
# 第二段：运行
#
# 这一层不装任何软件包，所以没有第二次 apt，构建快很多。
# 信号转发交给 compose 里的 init: true（Docker 会注入它自带的 init）。
# 就算没有 init 也没关系：应用自己注册了 SIGTERM 处理，docker stop 照样能优雅退出。
# --------------------------------------------------------------------------
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    DATA_DIR=/app/data \
    PORT=8787 \
    HOST=0.0.0.0

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public

# 数据目录以 root 建好再交给运行用户，避免挂载卷时权限不对
RUN mkdir -p /app/data/uploads /app/data/tmp \
    && chown -R node:node /app/data

USER node

VOLUME ["/app/data"]
EXPOSE 8787

# 健康检查用应用自己的接口，不需要额外的工具
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
