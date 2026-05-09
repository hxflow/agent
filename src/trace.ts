import { appendFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent"

export class TraceWriter {
  private path: string

  constructor(outputDir: string) {
    this.path = `${outputDir}/trace.jsonl`
    mkdirSync(dirname(this.path), { recursive: true })
  }

  write(event: AgentSessionEvent) {
    const line = JSON.stringify({
      kind: "pi",
      ts: new Date().toISOString(),
      piType: event.type,
      payload: event,
    })
    appendFileSync(this.path, line + "\n")
  }

  writeHx(hxType: string, payload: unknown) {
    const line = JSON.stringify({
      kind: "hx",
      ts: new Date().toISOString(),
      hxType,
      payload,
    })
    appendFileSync(this.path, line + "\n")
  }
}
