# @hxflow/agent

hxflow 容器化 agent 镜像。封装了 pi SDK 的完整工具循环，以 hxflow skill 驱动 `doc → plan → run → review → mr` 五段工作流，写入结构化产物后退出。

## 快速使用

```bash
podman run --rm \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -e REQUIREMENT="实现 /api/health 端点并加单测" \
  -v $(pwd):/workspace \
  -v /tmp/hx-out:/output \
  ghcr.io/hxflow/agent:latest
```

运行结束后查看产物：

```bash
cat /tmp/hx-out/result.json   # 状态、耗时、token 用量
cat /tmp/hx-out/diff.patch    # 代码变更
cat /tmp/hx-out/trace.jsonl   # 完整事件流（逐行 JSON）
```

## 容器契约

agent 只认环境变量 + 卷挂载 + 退出码，与调度方（Docker / Podman / k8s）解耦。

### 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `REQUIREMENT` | ✓ | 需求文本 |
| `ANTHROPIC_API_KEY` | 二选一 | Anthropic API key（env-only 模式）|
| `HX_RUN_ID` | | Run ID（调度方分配，默认自动生成）|
| `HX_BUDGET_USD` | | USD 预算上限（默认 `5.00`）|
| `HX_TIMEOUT_SEC` | | 墙钟超时秒数（默认 `1800`）|
| `HX_OUTPUT_DIR` | | 产物目录（默认 `/output`）|
| `HX_WORKSPACE_DIR` | | 代码目录（默认 `/workspace`）|
| `HX_MODEL` | | 模型 override（如 `claude-opus-4-7`）|

### 卷挂载

| 容器路径 | 说明 |
|----------|------|
| `/workspace` | 目标代码仓库（读写）|
| `/output` | 产物落点（读写）|
| `/root/.pi/agent/auth.json` | host-pi OAuth token（可选）|

### 退出码

| 退出码 | 含义 |
|--------|------|
| `0` | 成功 |
| `1` | 业务失败（review 不过、测试失败等）|
| `2` | 预算超限 |
| `3` | 超时 |
| `4` | 取消（SIGTERM 后正常收尾）|
| `10+` | 系统错误（SDK 异常）|
| `137` | OOM（128+9，容器运行时产生）|

### 产物

| 文件 | 说明 |
|------|------|
| `result.json` | 状态、exitCode、token 用量、耗时、各 phase 时长、MR URL |
| `trace.jsonl` | 逐行 JSON 事件流（pi SDK 事件 + hx 内部标记）|
| `diff.patch` | 代码变更（`git diff HEAD`）|

## Auth 模式

**host-pi（本地开发推荐）**：挂载 `~/.pi/agent/auth.json`，自动读取 Anthropic 或 OpenAI Codex OAuth 凭证。

```bash
podman run --rm \
  -v ~/.pi/agent/auth.json:/root/.pi/agent/auth.json:rw \
  -v $(pwd):/workspace \
  -v /tmp/hx-out:/output \
  -e REQUIREMENT="..." \
  ghcr.io/hxflow/agent:latest
```

**env-only（CI 推荐）**：通过 `ANTHROPIC_API_KEY` 直接注入。

## CI 接入

```yaml
- name: hxflow agent
  run: |
    podman run --rm \
      -e ANTHROPIC_API_KEY=${{ secrets.ANTHROPIC_API_KEY }} \
      -e REQUIREMENT="${{ inputs.requirement }}" \
      -e HX_BUDGET_USD=2.00 \
      -e HX_TIMEOUT_SEC=1200 \
      -v ${{ github.workspace }}:/workspace \
      -v ${{ runner.temp }}/hx-out:/output \
      ghcr.io/hxflow/agent:latest

- name: Show result
  run: cat ${{ runner.temp }}/hx-out/result.json
```

## 本地构建

```bash
# 从 workspace 根目录构建（Dockerfile 需要 workflow/ 和 agent/ 两个目录的上下文）
cd ~/hxflow-workspace
podman build -f agent/Dockerfile -t hxflow-agent:dev .
```

## 技术栈

- **Runtime**：[Bun](https://bun.sh)
- **Agent SDK**：`@earendil-works/pi-coding-agent`
- **LLM provider**：Anthropic Claude（默认）/ OpenAI Codex（via pi auth.json）
- **Skill**：`@hxflow/workflow`（hxflow pi skill）
- **基础镜像**：`oven/bun:1-debian`
