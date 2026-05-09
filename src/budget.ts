export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

// Anthropic pricing (USD per 1M tokens) for claude-opus-4-7
const PRICE = {
  input: 15,
  output: 75,
  cacheRead: 1.5,
  cacheWrite: 18.75,
}

export class Budget {
  private usage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  readonly limitUsd: number

  constructor(limitUsd: number) {
    this.limitUsd = limitUsd
  }

  add(delta: Partial<TokenUsage>) {
    this.usage.inputTokens += delta.inputTokens ?? 0
    this.usage.outputTokens += delta.outputTokens ?? 0
    this.usage.cacheReadTokens += delta.cacheReadTokens ?? 0
    this.usage.cacheWriteTokens += delta.cacheWriteTokens ?? 0
  }

  get costUsd(): number {
    const m = 1_000_000
    return (
      (this.usage.inputTokens * PRICE.input +
        this.usage.outputTokens * PRICE.output +
        this.usage.cacheReadTokens * PRICE.cacheRead +
        this.usage.cacheWriteTokens * PRICE.cacheWrite) /
      m
    )
  }

  get exceeded(): boolean {
    return this.costUsd >= this.limitUsd
  }

  totals() {
    return {
      ...this.usage,
      totalTokens: this.usage.inputTokens + this.usage.outputTokens,
      costUsd: this.costUsd,
    }
  }
}
