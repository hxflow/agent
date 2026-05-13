import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { ExitCode } from "@hxflow/shared/types"
import type {
  AgentResponse,
  AgentResultData,
  SkillAssembly,
  TokenUsage,
} from "@hxflow/shared/types"

const ZERO_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
}

export interface ScaffoldInput {
  runId: string
  startedAt: string
  environment: { name: string; image: string }
  model: string | null
  provider: string | null
  scope: string
  source: string
  executionLocation: string
  skills: SkillAssembly
}

/**
 * Write the initial envelope. err/msg/status/summary are null; agent-owned fields
 * are populated. LLM (via agent system prompt) will fill the rest by Edit-ing this file.
 */
export function writeScaffold(outputDir: string, input: ScaffoldInput): void {
  mkdirSync(outputDir, { recursive: true })
  const envelope: AgentResponse = {
    err: null,
    msg: null,
    data: {
      runId: input.runId,
      createdAt: input.startedAt,
      startedAt: input.startedAt,
      endedAt: null,
      durationSec: null,
      environment: input.environment,
      model: input.model,
      provider: input.provider,
      scope: input.scope,
      source: input.source,
      executionLocation: input.executionLocation,
      skills: input.skills,
      usage: { ...ZERO_USAGE },
      status: null,
      summary: null,
      artifacts: [],
    } satisfies AgentResultData,
  }
  writeFileSync(resultPath(outputDir), JSON.stringify(envelope, null, 2))
}

export interface FinalizeInput {
  startedAt: string
  exitCode: number
  /** Reason for non-zero exit when LLM didn't finalize. */
  fallbackMsg?: string
  /** Final usage, if pi session is available. Merged into data.usage. */
  usage?: TokenUsage
}

/**
 * Read the envelope, patch agent-owned tail fields (endedAt/durationSec/usage), and
 * — if LLM never set err — write a fallback envelope reflecting the agent's exit reason.
 */
export function finalizeResult(outputDir: string, input: FinalizeInput): void {
  const path = resultPath(outputDir)
  const endedAt = new Date().toISOString()
  const durationSec = (Date.now() - new Date(input.startedAt).getTime()) / 1000

  let envelope: AgentResponse<AgentResultData> | undefined
  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, "utf8")
      const parsed = JSON.parse(raw) as AgentResponse<AgentResultData>
      if (parsed && typeof parsed === "object" && "data" in parsed) {
        envelope = parsed
      }
    } catch {
      // fall through to fallback rebuild
    }
  }

  if (!envelope) {
    // result.json missing or unparsable → rebuild minimal envelope; data fields nulled.
    envelope = {
      err: input.exitCode === ExitCode.Success ? ExitCode.SystemError : input.exitCode,
      msg: input.fallbackMsg ?? "result.json missing or invalid",
      data: {
        runId: "",
        createdAt: input.startedAt,
        startedAt: input.startedAt,
        endedAt,
        durationSec,
        environment: { name: "", image: "" },
        model: null,
        provider: null,
        scope: "",
        source: "",
        executionLocation: "",
        skills: { system: [], project: [], overridden: [] },
        usage: input.usage ?? { ...ZERO_USAGE },
        status: null,
        summary: null,
        artifacts: [],
      },
    }
    writeFileSync(path, JSON.stringify(envelope, null, 2))
    return
  }

  // Patch tail fields agent owns regardless of LLM state
  envelope.data.endedAt = endedAt
  envelope.data.durationSec = durationSec
  if (input.usage) envelope.data.usage = input.usage

  // Fallback path: LLM never wrote err → agent fills it
  if (envelope.err === null) {
    envelope.err = input.exitCode
    envelope.msg = input.fallbackMsg ?? (input.exitCode === ExitCode.Success ? "ok" : "agent exited without LLM finalization")
  }

  writeFileSync(path, JSON.stringify(envelope, null, 2))
}

function resultPath(outputDir: string): string {
  return join(outputDir, "result.json")
}
