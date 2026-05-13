# @hxflow/agent

hxflow 定制的容器化 agent，基于 `@earendil-works/pi-coding-agent` SDK。在容器内：
- 5 个默认 skill（`hxflow` + `git-commit-convention` + `gitlab` + `wushuang-devops` + `wushuang-task-updater`）已在构建期 vendor 进镜像，保证零网络也能跑完整流水线
- `HX_SKILLS` env 可在运行期追加额外 skill，或显式重装某个 vendor skill 覆盖版本
- 启动 pi session，按 `/skill:hxflow go <需求>` 驱动 hxflow 五段工作流
- 把 pi 事件流落到 `/output/trace.jsonl`
- 由 LLM 把 `{err, msg, data}` envelope 写入 `/output/result.json`，agent 只补元数据并兜底

## 快速使用

```bash
podman run --rm \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -e HX_NPM_TOKEN=glpat-... \
  -e REQUIREMENT="实现 /api/health 端点并加单测" \
  -v $(pwd):/workspace \
  -v /tmp/hx-out:/output \
  ghcr.io/hxflow/agent:latest

cat /tmp/hx-out/result.json   # {err, msg, data:{...}}
tail -F /tmp/hx-out/trace.jsonl | jq .   # 实时事件流
```

通常你不直接 `podman run`——`hx agent run` CLI 会负责 environment 加载、env 注入、容器启停、follow 渲染。

## 容器契约

### 输入

| 项 | 必填 | 说明 |
|----|------|------|
| `REQUIREMENT` env | ✓ | 需求文本 |
| 任一 LLM 凭证 env（如 `ANTHROPIC_API_KEY`） | ✓ | pi SDK 默认从 env 读，agent 不感知具体名称 |
| `HX_NPM_TOKEN` env | (装私有 skill 时) ✓ | 公司私有 GitLab npm registry 的 token；entrypoint 写到 `~/.npmrc`。缺失时 trace 会 warn，scoped 包安装会失败 |
| `HX_RUN_ID` env | | 默认自动生成 UUID v7 |
| `HX_TIMEOUT_SEC` env | | 墙钟超时（默认 1800） |
| `HX_OUTPUT_DIR` env | | 产物目录（默认 `/output`） |
| `HX_WORKSPACE_DIR` env | | 代码目录（默认 `/workspace`） |
| `HX_MODEL` env | | 模型 override |
| `HX_ENVIRONMENT_NAME` / `HX_IMAGE` env | | 元数据回填 |
| `HX_PROVIDER` / `HX_SCOPE` / `HX_SOURCE` / `HX_EXECUTION_LOCATION` env | | 元数据回填 |
| `HX_SKILLS` env | | CSV 形式的 pi spec 清单（默认空——5 个默认 skill 已 vendor）；entrypoint 启动时 `pi install`，用于追加额外 skill 或覆盖某个 vendor 版本 |
| `HX_NPM_REGISTRY` / `HX_NPM_SCOPE` env | | 私有 registry URL / scope（默认指向公司 GitLab） |
| `HX_CRITICAL_SKILLS` env | | 必须装载成功的 skill 名 CSV（默认 `hxflow`）；缺失则 fail-fast |
| `HX_EXTRA_PROJECT_SKILL_DIRS` env | | 在 pi 原生发现之外补扫的项目级目录（默认 `.claude/skills,.codex/skills`） |
| `/workspace` 挂载 | ✓ | 目标仓库 rw |
| `/output` 挂载 | ✓ | 产物目录 rw |

任何业务 skill 需要的 env（GitHub/GitLab/wushuang 等 token）由调用方按 environment 配置注入；agent 不感知。

### 输出

| 文件 | 写入方 | 说明 |
|------|--------|------|
| `/output/result.json` | LLM 写业务字段；agent 写元数据并兜底 | **唯一契约产物**，统一信封 `{err, msg, data}` |
| `/output/trace.jsonl` | agent（pi 事件 + hx marker） | 调试产物，**非契约**；行级即写即刷 |

容器 stdout/stderr **不再**作为消费通路——CLI / UI 单一订阅源 = `trace.jsonl`。

### result.json 字段切分

| 字段 | 写入方 |
|------|--------|
| `err` / `msg` | LLM 正常路径填；agent 在 LLM 漏写时兜底（值 = ExitCode） |
| `data.runId` / `createdAt` / `startedAt` / `endedAt` / `durationSec` | agent |
| `data.environment` / `model` / `provider` / `scope` / `source` / `executionLocation` | agent（来自 env） |
| `data.skills` (`system` / `project` / `overridden`) | agent；`system` / `project` 由 pi 装载后按 baseDir 是否在 `/workspace` 内分类，`overridden` 现固定为空数组（去重交给 pi） |
| `data.usage` (4 类 token + total) | agent（shutdown 时 `session.getSessionStats()`） |
| `data.status` / `summary` / `artifacts` | LLM（通过 agent system prompt 约束在收尾阶段 Edit 该文件） |

详见 shared/README.md 的 `AgentResponse` / `AgentResultData` 定义。

### 退出码

| 退出码 | 含义 |
|--------|------|
| `0` | 成功 |
| `1` | 业务失败 |
| `3` | 超时 |
| `4` | 取消（SIGTERM）|
| `10+` | 系统错误（含关键 skill 缺失） |
| `137` | OOM（128+9，容器运行时产生）|

## Skill 装配

容器启动时分两步（外加构建期 vendor）：

0. **构建期 vendor**（Dockerfile）：对 `workflow/`、`skills/skills/{git-commit-convention,gitlab,wushuang-devops,wushuang-task-updater}` 依次 `pi install <localpath>`，把 5 个默认 skill 装到镜像里的 `~/.pi/agent/`。运行期默认 `HX_SKILLS` 为空，故不会重复装；显式设 `npm:@hxflow/skill-<name>@<ver>` 可在运行期覆盖 vendor 版本。

1. **系统 skill 安装**（`installSkills.ts`）：
   - 若 `HX_NPM_TOKEN` + `HX_NPM_REGISTRY` + `HX_NPM_SCOPE` 齐备且 `~/.npmrc` 不存在，写入 npmrc 启用私有 registry 认证
   - 按 `HX_SKILLS` 清单逐个 `pi install <spec>`（全局安装到 `~/.pi/agent/`）；默认 `HX_SKILLS` 为空，仅在追加/覆盖时才会跑
   - 失败的 spec 写入 trace 但不致命；后续关键 skill 校验会兜底（hxflow 已 vendor，覆盖失败时旧版本仍可用）

2. **skill 发现**（`DefaultResourceLoader`，pi 原生）：
   - 全局：`~/.pi/agent/` 内已安装的包（含上一步装的 skill）
   - 项目：`/workspace/.pi/skills/`、`/workspace/.agents/skills/`（pi 默认约定，向上走到 git 根）
   - 额外项目目录：通过 `skillsOverride` 钩子调 `loadSkillsFromDir` 扫 `HX_EXTRA_PROJECT_SKILL_DIRS` 列出的相对路径（默认 `.claude/skills` / `.codex/skills`）
   - 去重 / 优先级：交给 pi 原生逻辑

3. **关键 skill 校验**：装载完成后检查 `HX_CRITICAL_SKILLS`（默认 `hxflow`），缺失任一则 `shutdown(SystemError)`，避免 `/skill:hxflow go ...` 跑出莫名错误。

装配结果写进 `result.json` 的 `data.skills`。

## 异常兜底

- 超时：trace 写 warn 后 `exit 3`；result.json 已有 scaffold，agent 补 `err:3, msg:"timeout after Ns"`
- SIGTERM：同上但 `exit 4`
- 关键 skill 缺失：`exit 10+`，msg 含具体缺失的 skill 名
- LLM 没改 envelope（`err` 仍是 null）：agent 在 finalize 时按 exit 写 `err`，业务字段保留 null/空数组
- result.json 损坏或缺失：agent 重写最小 envelope，所有 data.* 字段默认值

## Secrets / Redaction

agent **不做**任何 redaction——LLM 和 skill 都通过 `$ENV` 引用 secret，不会把明文 token 写进 trace 或 summary。如果未来发现复述漏洞再以独立 middleware 补，不污染 agent 核心。

## 本地构建

```bash
cd ~/hxflow-workspace
podman build -f agent/Dockerfile -t hxflow-agent:dev .
```

构建上下文是 workspace 根，Dockerfile COPY `shared/` + `agent/` + `workflow/` + `skills/skills/*`（后三者用于构建期 vendor 5 个默认 skill）。

skill 本地联调：
- 改任一 vendor skill 源码后需重新 `podman build` 才能进镜像；
- 或把 `HX_SKILLS` 加上 `/abs/path/to/skill-dir` 在运行期覆盖 vendor 版本（pi 走本地路径安装），免去重建。

## 技术栈

- **Runtime**：[Bun](https://bun.sh)
- **Agent SDK**：`@earendil-works/pi-coding-agent`
- **Skills**：5 个默认 skill（`hxflow` + `git-commit-convention` + `gitlab` + `wushuang-devops`）构建期 vendor 进镜像；运行期可通过 `HX_SKILLS` 追加/覆盖；项目自带 skill 由 pi 原生扫描 + `HX_EXTRA_PROJECT_SKILL_DIRS`
- **基础镜像**：`oven/bun:1-debian`
