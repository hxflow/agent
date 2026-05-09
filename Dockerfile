FROM oven/bun:1-debian AS base

# apt 切换国内镜像（海外部署可注释掉）
RUN sed -i 's|deb.debian.org|mirrors.tuna.tsinghua.edu.cn|g; s|security.debian.org|mirrors.tuna.tsinghua.edu.cn|g' \
    /etc/apt/sources.list.d/debian.sources 2>/dev/null || \
    sed -i 's|deb.debian.org|mirrors.tuna.tsinghua.edu.cn|g; s|security.debian.org|mirrors.tuna.tsinghua.edu.cn|g' \
    /etc/apt/sources.list 2>/dev/null || true

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    openssh-client \
    ca-certificates \
    curl \
    jq \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/hxflow-agent
ENV PATH="/opt/hxflow-agent/node_modules/.bin:${PATH}"

# 构建上下文 = ~/hxflow-workspace/（运行 `podman build -f agent/Dockerfile .` from workspace root）
# workflow 包：file 依赖，直接 COPY 进来
COPY workflow/ /opt/workflow/

# agent 依赖安装
COPY agent/package.json agent/bunfig.toml ./
# 发版时用 GitHub Packages；本地 build 时 workflow 走 /opt/workflow 本地路径
RUN bun install --production --frozen-lockfile

# agent 源码
COPY agent/src ./src

# 挂载点（文档性）：
# /workspace — 目标代码仓库（rw bind mount）
# /output    — 产物：result.json / trace.jsonl / diff.patch

ENTRYPOINT ["bun", "/opt/hxflow-agent/src/entrypoint.ts"]
