import { writeFileSync, mkdirSync } from "node:fs"
import { ExitCode } from "@hxflow/shared/types"
import type { RunResult, HxPhase } from "@hxflow/shared/types"
import type { Budget } from "./budget.ts"

export interface PhaseRecord {
  phase: HxPhase
  startedAt: string
  endedAt?: string
  durationMs: number
  outcome: "ok" | "fail" | "skip"
}

export function writeResult(
  outputDir: string,
  runId: string,
  startedAt: string,
  exitCode: number,
  phases: PhaseRecord[],
  budget: Budget,
  errorSummary?: string,
  mrUrl?: string,
) {
  mkdirSync(outputDir, { recursive: true })
  const endedAt = new Date().toISOString()
  const durationSec = (Date.now() - new Date(startedAt).getTime()) / 1000

  const statusMap: Record<number, RunResult["status"]> = {
    [ExitCode.Success]: "succeeded",
    [ExitCode.BusinessFailure]: "failed",
    [ExitCode.BudgetExceeded]: "budget_exceeded",
    [ExitCode.Timeout]: "timeout",
    [ExitCode.Cancelled]: "cancelled",
    [ExitCode.SystemError]: "system_error",
  }

  const result: RunResult = {
    runId,
    status: statusMap[exitCode] ?? "system_error",
    exitCode,
    startedAt,
    endedAt,
    durationSec,
    phases,
    usage: budget.totals(),
    ...(mrUrl ? { mrUrl } : {}),
    ...(errorSummary ? { errorSummary } : {}),
  }

  writeFileSync(`${outputDir}/result.json`, JSON.stringify(result, null, 2))
  return result
}
