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

ENV PATH="/opt/hxflow-agent/node_modules/.bin:${PATH}"

# 构建上下文 = workspace 根（运行 `podman build -f agent/Dockerfile .` from workspace root）。
# 在容器内构造一个临时 workspace 根，让 bun 能解析 agent 里的 workspace:* 依赖。
WORKDIR /opt
COPY shared/ ./shared/
COPY agent/package.json agent/bunfig.toml agent/bun.lock ./hxflow-agent/
RUN printf '{"name":"hx-build-root","private":true,"workspaces":["shared","hxflow-agent"]}\n' > package.json

WORKDIR /opt/hxflow-agent
RUN bun install --production --frozen-lockfile

# agent 源码
COPY agent/src ./src

# 全部 5 个默认 skill 构建期 vendor 进镜像 —— 保证零网络也能起完整流水线。
# hxflow 是容器内部流程 skill（来自 workflow/），另外四个是工具 skill（来自 skills/）。
# 运行期可通过 HX_SKILLS env 追加额外 skill 或覆盖某个版本。
#
# 注意：`pi install <localpath>` 只在 ~/.pi/agent/settings.json 登记路径引用，
# 不复制文件。所以 skill 必须放在永久位置（这里用 /opt/skills/），不能装完就删。
COPY workflow/package.json /opt/skills/hxflow/package.json
COPY workflow/hxflow/ /opt/skills/hxflow/hxflow/
COPY skills/skills/git-commit-convention/ /opt/skills/git-commit-convention/
COPY skills/skills/gitlab/ /opt/skills/gitlab/
COPY skills/skills/wushuang-devops/ /opt/skills/wushuang-devops/
COPY skills/skills/wushuang-task-updater/ /opt/skills/wushuang-task-updater/
RUN pi install /opt/skills/hxflow \
 && pi install /opt/skills/git-commit-convention \
 && pi install /opt/skills/gitlab \
 && pi install /opt/skills/wushuang-devops \
 && pi install /opt/skills/wushuang-task-updater

# 挂载点（文档性）：
# /workspace — 目标代码仓库（rw bind mount）
# /output    — 产物：result.json / trace.jsonl

# 默认 HX_SKILLS 为空：4 个默认 skill 已 vendor。调度方可设此 env 为 CSV 形式的 pi spec
# 清单追加额外 skill，或显式重装某个 vendor skill 覆盖版本（如 `npm:@hxflow/skill-gitlab@1.2.3`）。
# 私有 GitLab npm registry 的 token 由 HX_NPM_TOKEN env 注入，entrypoint 写到 ~/.npmrc。
ENV HX_SKILLS="" \
    HX_NPM_REGISTRY="https://gitlab.cdfsunrise.com/api/v4/packages/npm/" \
    HX_NPM_SCOPE="@hxflow"

ENTRYPOINT ["bun", "/opt/hxflow-agent/src/entrypoint.ts"]
