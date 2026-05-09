import { spawnSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
} from "@earendil-works/pi-coding-agent"
import { ExitCode } from "@hxflow/shared/types"
import { Budget } from "./budget.ts"
import { TraceWriter } from "./trace.ts"
import { writeResult, type PhaseRecord } from "./result.ts"

// ── 环境变量 ──────────────────────────────────────────────────────────────────

const REQUIREMENT = process.env.REQUIREMENT ?? ""
const HX_RUN_ID = process.env.HX_RUN_ID ?? `r-local-${Date.now()}`
const HX_BUDGET_USD = parseFloat(process.env.HX_BUDGET_USD ?? "5.00")
const HX_TIMEOUT_SEC = parseInt(process.env.HX_TIMEOUT_SEC ?? "1800", 10)
const OUTPUT_DIR = process.env.HX_OUTPUT_DIR ?? "/output"
const WORKSPACE_DIR = process.env.HX_WORKSPACE_DIR ?? "/workspace"

if (!REQUIREMENT) {
  console.error("[hx-agent] REQUIREMENT env is required")
  process.exit(ExitCode.SystemError)
}

// ── 状态 ──────────────────────────────────────────────────────────────────────

const startedAt = new Date().toISOString()
const budget = new Budget(HX_BUDGET_USD)
const trace = new TraceWriter(OUTPUT_DIR)
const phases: PhaseRecord[] = []
let cancelled = false

// ── 超时 ──────────────────────────────────────────────────────────────────────

const timeoutHandle = setTimeout(() => {
  trace.writeHx("warn", { msg: "timeout reached", timeoutSec: HX_TIMEOUT_SEC })
  shutdown(ExitCode.Timeout, "timeout")
}, HX_TIMEOUT_SEC * 1000)
timeoutHandle.unref()

// ── SIGTERM（取消）────────────────────────────────────────────────────────────

process.on("SIGTERM", () => {
  cancelled = true
  trace.writeHx("warn", { msg: "SIGTERM received" })
  shutdown(ExitCode.Cancelled, "cancelled by SIGTERM")
})

// ── 主流程 ────────────────────────────────────────────────────────────────────

async function main() {
  trace.writeHx("info", { msg: "agent start", runId: HX_RUN_ID, cwd: WORKSPACE_DIR })

  // auth：优先 env 里的 API key，其次从挂载的 ~/.pi/agent/auth.json 读取
  // codex 模式下 auth.json 里有 openai-codex OAuth，SDK 自动用 openai-codex-responses WebSocket provider
  const authStorage = (() => {
    const s = AuthStorage.create()
    if (process.env.ANTHROPIC_API_KEY) {
      s.setRuntimeApiKey("anthropic", process.env.ANTHROPIC_API_KEY)
    }
    return s
  })()

  const modelRegistry = ModelRegistry.inMemory(authStorage)

  const { session } = await createAgentSession({
    cwd: WORKSPACE_DIR,
    sessionManager: SessionManager.inMemory(),
    authStorage,
    modelRegistry,
  })

  // 事件订阅：写 trace + 追踪预算
  let lastError: string | undefined
  session.subscribe((event) => {
    trace.write(event)

    // 从 message_end 累计 token 用量（pi 在 message_end 时 message 含 usage）
    if (event.type === "message_end") {
      const msg = event.message as any
      if (msg?.usage) {
        budget.add({
          inputTokens: msg.usage.input_tokens ?? 0,
          outputTokens: msg.usage.output_tokens ?? 0,
          cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: msg.usage.cache_creation_input_tokens ?? 0,
        })
      }
      if (budget.exceeded) {
        trace.writeHx("warn", { msg: "budget exceeded", costUsd: budget.costUsd, limitUsd: budget.limitUsd })
        shutdown(ExitCode.BudgetExceeded, `budget exceeded: $${budget.costUsd.toFixed(4)} >= $${budget.limitUsd}`)
      }
    }

    // LLM 错误检测
    if (event.type === "message_end") {
      const msg = event.message as any
      if (msg?.stopReason === "error" && msg?.errorMessage) {
        lastError = msg.errorMessage
      }
    }

    // stdout 透传：把 LLM 文本输出打到 stdout 供 CLI follow
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      process.stdout.write(event.assistantMessageEvent.delta)
    }
  })

  // 发出需求 prompt
  const prompt = `/skill:hxflow go ${REQUIREMENT}`
  trace.writeHx("info", { msg: "prompt", text: prompt })

  await session.prompt(prompt)

  trace.writeHx("info", { msg: "agent done", lastError })

  if (lastError) {
    writeDiff()
    await shutdown(ExitCode.SystemError, lastError)
    return
  }

  // 生成 diff.patch
  writeDiff()

  await shutdown(ExitCode.Success)
}

// ── 收尾 ──────────────────────────────────────────────────────────────────────

let shutdownCalled = false

async function shutdown(code: number, errorSummary?: string) {
  if (shutdownCalled) return
  shutdownCalled = true
  clearTimeout(timeoutHandle)

  trace.writeHx("info", { msg: "shutdown", code, errorSummary })

  writeResult(OUTPUT_DIR, HX_RUN_ID, startedAt, code, phases, budget, errorSummary)

  process.exit(code)
}

function writeDiff() {
  try {
    const r = spawnSync("git", ["diff", "HEAD"], { cwd: WORKSPACE_DIR, encoding: "utf8" })
    if (r.stdout) {
      writeFileSync(`${OUTPUT_DIR}/diff.patch`, r.stdout)
    }
  } catch {
    // git diff 失败不阻断退出
  }
}

// ── 未捕获异常 ────────────────────────────────────────────────────────────────

process.on("uncaughtException", (err) => {
  trace.writeHx("error", { msg: "uncaughtException", error: String(err) })
  shutdown(ExitCode.SystemError, String(err))
})

process.on("unhandledRejection", (reason) => {
  trace.writeHx("error", { msg: "unhandledRejection", reason: String(reason) })
  shutdown(ExitCode.SystemError, String(reason))
})

main().catch((err) => {
  shutdown(ExitCode.SystemError, String(err))
})
