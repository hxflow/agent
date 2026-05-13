import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  loadSkillsFromDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent"
import { existsSync } from "node:fs"
import { join } from "node:path"
import type { TokenUsage } from "@hxflow/shared/types"
import { ExitCode } from "@hxflow/shared/types"
import { uuidv7 } from "@hxflow/shared/uuid"
import { installSystemSkills } from "./installSkills.ts"
import { TraceWriter } from "./trace.ts"
import { writeScaffold, finalizeResult } from "./result.ts"
import { RESULT_REPORTING_SYSTEM_PROMPT } from "./system-prompt.ts"

// ── Output dir / TraceWriter first, so even early errors get captured ────────

const OUTPUT_DIR = process.env.HX_OUTPUT_DIR ?? "/output"
const trace = new TraceWriter(OUTPUT_DIR)

// ── Env ──────────────────────────────────────────────────────────────────────

const REQUIREMENT = process.env.REQUIREMENT ?? ""
const HX_RUN_ID = process.env.HX_RUN_ID ?? uuidv7()
const HX_TIMEOUT_SEC = parseInt(process.env.HX_TIMEOUT_SEC ?? "1800", 10)
const WORKSPACE_DIR = process.env.HX_WORKSPACE_DIR ?? "/workspace"
const ENV_NAME = process.env.HX_ENVIRONMENT_NAME ?? ""
const ENV_IMAGE = process.env.HX_IMAGE ?? ""
const SCOPE = process.env.HX_SCOPE ?? "personal"
const SOURCE = process.env.HX_SOURCE ?? "hxflow-cli"
const EXECUTION_LOCATION = process.env.HX_EXECUTION_LOCATION ?? "local"

// 额外的项目级 skill 扫描目录（pi 原生只看 .pi/skills 与 .agents/skills；用 CSV 覆盖）
// 相对 WORKSPACE_DIR
const EXTRA_PROJECT_SKILL_DIRS = (
  process.env.HX_EXTRA_PROJECT_SKILL_DIRS ?? ".claude/skills,.codex/skills"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)

// 必须装载成功的 skill 名清单 —— 缺任何一个直接 fail-fast。默认含 hxflow（容器内部流程入口）。
const CRITICAL_SKILLS = (process.env.HX_CRITICAL_SKILLS ?? "hxflow")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)

if (!REQUIREMENT) {
  trace.writeHx("error", { msg: "REQUIREMENT env is required" })
  console.error("[hx-agent] REQUIREMENT env is required")
  process.exit(ExitCode.SystemError)
}

// ── Bookkeeping ──────────────────────────────────────────────────────────────

const startedAt = new Date().toISOString()
let captureUsage: () => TokenUsage | undefined = () => undefined

// ── Timeout / signal handlers ────────────────────────────────────────────────

const timeoutHandle = setTimeout(() => {
  trace.writeHx("warn", { msg: "timeout reached", timeoutSec: HX_TIMEOUT_SEC })
  shutdown(ExitCode.Timeout, `timeout after ${HX_TIMEOUT_SEC}s`)
}, HX_TIMEOUT_SEC * 1000)
timeoutHandle.unref()

process.on("SIGTERM", () => {
  trace.writeHx("warn", { msg: "SIGTERM received" })
  shutdown(ExitCode.Cancelled, "cancelled by SIGTERM")
})

process.on("uncaughtException", (err) => {
  trace.writeHx("error", { msg: "uncaughtException", error: String(err) })
  shutdown(ExitCode.SystemError, String(err))
})

process.on("unhandledRejection", (reason) => {
  trace.writeHx("error", { msg: "unhandledRejection", reason: String(reason) })
  shutdown(ExitCode.SystemError, String(reason))
})

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  trace.writeHx("info", { msg: "agent start", runId: HX_RUN_ID, cwd: WORKSPACE_DIR })

  // 运行期通过 `pi install npm:...` 按 HX_SKILLS 全局装系统 skill 到 ~/.pi/agent/。
  // 装完由 DefaultResourceLoader 自行发现（全局包 + cwd 下 .pi/skills、.agents/skills 等）。
  const installResult = installSystemSkills()
  trace.writeHx("info", {
    msg: "skills installed",
    installed: installResult.installed,
    failedCount: installResult.failed.length,
  })
  for (const w of installResult.warnings) {
    trace.writeHx("warn", { msg: "skill install warning", detail: w })
  }
  for (const f of installResult.failed) {
    trace.writeHx("error", { msg: "skill install failed", spec: f.spec, error: f.error })
  }

  // 让 pi 原生 ResourceLoader 装载所有 skill —— 全局包 + cwd 下项目 skill；
  // 再通过 skillsOverride 把 .claude/skills、.codex/skills 等额外项目级目录扫进来，
  // 走 pi 自己的 loadSkillsFromDir，避免再写一套扫描代码。
  const settingsManager = SettingsManager.create(WORKSPACE_DIR, getAgentDir())
  const resourceLoader = new DefaultResourceLoader({
    cwd: WORKSPACE_DIR,
    agentDir: getAgentDir(),
    settingsManager,
    skillsOverride: (base) => {
      const extraSkills: typeof base.skills = []
      const extraDiags: typeof base.diagnostics = []
      const visit = (dir: string, source: string) => {
        if (!existsSync(dir)) return
        const r = loadSkillsFromDir({ dir, source })
        extraSkills.push(...r.skills)
        extraDiags.push(...r.diagnostics)
      }
      for (const rel of EXTRA_PROJECT_SKILL_DIRS) {
        visit(join(WORKSPACE_DIR, rel), `project:${rel}`)
      }
      return {
        skills: [...base.skills, ...extraSkills],
        diagnostics: [...base.diagnostics, ...extraDiags],
      }
    },
    appendSystemPromptOverride: (base) => [
      ...base,
      RESULT_REPORTING_SYSTEM_PROMPT,
    ],
  })
  await resourceLoader.reload()

  // 按 baseDir 是否落在 WORKSPACE_DIR 内分类，填到 result.json 的 skills 字段。
  const loadedSkills = resourceLoader.getSkills().skills
  const systemNames: string[] = []
  const projectNames: string[] = []
  for (const s of loadedSkills) {
    if (s.baseDir.startsWith(WORKSPACE_DIR)) projectNames.push(s.name)
    else systemNames.push(s.name)
  }
  trace.writeHx("info", {
    msg: "skills loaded",
    system: systemNames,
    project: projectNames,
  })

  // 关键 skill 校验：缺失就 fail-fast，避免后面跑 `/skill:hxflow` 给一个莫名其妙的错误。
  const allNames = new Set([...systemNames, ...projectNames])
  const missingCritical = CRITICAL_SKILLS.filter((n) => !allNames.has(n))
  if (missingCritical.length > 0) {
    trace.writeHx("error", { msg: "critical skills missing", missing: missingCritical })
    shutdown(ExitCode.SystemError, `critical skills missing: ${missingCritical.join(", ")}`)
    return
  }

  // Write scaffold result.json with all agent-owned fields
  writeScaffold(OUTPUT_DIR, {
    runId: HX_RUN_ID,
    startedAt,
    environment: { name: ENV_NAME, image: ENV_IMAGE },
    model: process.env.HX_MODEL ?? null,
    provider: process.env.HX_PROVIDER ?? null,
    scope: SCOPE,
    source: SOURCE,
    executionLocation: EXECUTION_LOCATION,
    skills: {
      system: systemNames,
      project: projectNames,
      overridden: [],
    },
  })

  // Auth flow is fully delegated to pi:
  //   - env vars like ANTHROPIC_API_KEY / OPENAI_API_KEY are auto-detected
  //   - OAuth credentials (incl. openai-codex) are read from /root/.pi/agent/auth.json,
  //     bind-mounted rw by the CLI when environment.auth.authJsonPath is set;
  //     pi handles token refresh and persists back through the mount.
  // createAgentSession() with no overrides uses AuthStorage.create() at the default path.
  const { session } = await createAgentSession({
    cwd: WORKSPACE_DIR,
    sessionManager: SessionManager.inMemory(),
    settingsManager,
    resourceLoader,
  })

  captureUsage = () => {
    try {
      const stats = session.getSessionStats()
      const t = stats.tokens
      return {
        inputTokens: t.input,
        outputTokens: t.output,
        cacheReadTokens: t.cacheRead,
        cacheWriteTokens: t.cacheWrite,
        totalTokens: t.total,
      }
    } catch {
      return undefined
    }
  }

  // 跟踪最后一条 assistant 消息的 stopReason。pi 的 session.prompt() 即使所有 turn
  // 都因为认证/网络错误返回 401/5xx 也会正常 resolve，所以光靠 await 完成无法判失败。
  // 这里订阅 message_end，记下最后一条 assistant 消息的状态；自动重试成功会被后续
  // 的 message_end 覆盖，所以只有"最后一条 assistant 仍是 error"才算业务失败。
  let lastAssistantError: string | null = null
  session.subscribe((event) => {
    trace.write(event)
    if (event.type === "message_end") {
      const msg = (event as { message?: { role?: string; stopReason?: string; errorMessage?: string } }).message
      if (msg?.role === "assistant") {
        lastAssistantError = msg.stopReason === "error" ? (msg.errorMessage ?? "assistant turn ended with error") : null
      }
    }
  })

  const prompt = `/skill:hxflow ${REQUIREMENT}`
  trace.writeHx("info", { msg: "prompt", text: prompt })

  await session.prompt(prompt)

  if (lastAssistantError) {
    trace.writeHx("error", { msg: "session ended with assistant error", detail: lastAssistantError })
    await shutdown(ExitCode.BusinessFailure, lastAssistantError)
    return
  }

  trace.writeHx("info", { msg: "agent done" })
  await shutdown(ExitCode.Success)
}

// ── Shutdown ────────────────────────────────────────────────────────────────

let shutdownCalled = false

async function shutdown(code: number, fallbackMsg?: string) {
  if (shutdownCalled) return
  shutdownCalled = true
  clearTimeout(timeoutHandle)

  trace.writeHx("info", { msg: "shutdown", code, fallbackMsg })

  finalizeResult(OUTPUT_DIR, {
    startedAt,
    exitCode: code,
    fallbackMsg,
    usage: captureUsage(),
  })

  process.exit(code)
}

main().catch((err) => {
  trace.writeHx("error", { msg: "main rejected", error: String(err) })
  shutdown(ExitCode.SystemError, String(err))
})
