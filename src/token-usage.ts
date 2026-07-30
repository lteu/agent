export type TokenUsage = {
  /** 非缓存输入；对不区分缓存的 OpenAI 兼容服务，等于 prompt_tokens。 */
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  /** 服务商报告的总量；缺失时按各独立类别计算。 */
  totalTokens: number
}

export const EMPTY_TOKEN_USAGE: Readonly<TokenUsage> = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  totalTokens: 0,
}

function finiteNonNegative(value: unknown): number | undefined {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : undefined
}

/** Anthropic usage 的四类 token 彼此独立，可以直接相加。 */
export function tokenUsageFromAnthropic(raw: any): TokenUsage {
  const inputTokens = finiteNonNegative(raw?.input_tokens) ?? 0
  const outputTokens = finiteNonNegative(raw?.output_tokens) ?? 0
  const cacheReadInputTokens = finiteNonNegative(raw?.cache_read_input_tokens) ?? 0
  const cacheCreationInputTokens = finiteNonNegative(raw?.cache_creation_input_tokens) ?? 0
  return {
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    totalTokens:
      finiteNonNegative(raw?.total_tokens) ??
      inputTokens + outputTokens + cacheReadInputTokens + cacheCreationInputTokens,
  }
}

/**
 * OpenAI prompt_tokens 通常已包含 cached_tokens，所以只有服务商同时返回 Anthropic
 * 明细字段时才把缓存从 inputTokens 中独立出来；否则缓存数仅作为 prompt 的子集展示，
 * totalTokens 始终优先采用服务商原值，避免重复计数。
 */
export function tokenUsageFromOpenAI(raw: any): TokenUsage {
  const promptTokens = finiteNonNegative(raw?.prompt_tokens) ?? 0
  const explicitInput = finiteNonNegative(raw?.input_tokens)
  const outputTokens =
    finiteNonNegative(raw?.output_tokens) ??
    finiteNonNegative(raw?.completion_tokens) ??
    0
  const cacheReadInputTokens =
    finiteNonNegative(raw?.cache_read_input_tokens) ??
    finiteNonNegative(raw?.prompt_tokens_details?.cached_tokens) ??
    finiteNonNegative(raw?.input_tokens_details?.cached_tokens) ??
    0
  const cacheCreationInputTokens =
    finiteNonNegative(raw?.cache_creation_input_tokens) ?? 0
  const inputTokens = explicitInput ?? promptTokens
  const computedTotal =
    explicitInput === undefined
      ? promptTokens + outputTokens
      : inputTokens + outputTokens + cacheReadInputTokens + cacheCreationInputTokens
  return {
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    totalTokens: finiteNonNegative(raw?.total_tokens) ?? computedTotal,
  }
}

export function addTokenUsage(total: TokenUsage, next: TokenUsage): TokenUsage {
  return {
    inputTokens: total.inputTokens + next.inputTokens,
    outputTokens: total.outputTokens + next.outputTokens,
    cacheReadInputTokens: total.cacheReadInputTokens + next.cacheReadInputTokens,
    cacheCreationInputTokens:
      total.cacheCreationInputTokens + next.cacheCreationInputTokens,
    totalTokens: total.totalTokens + next.totalTokens,
  }
}

export function formatTokenCount(value: number): string {
  if (value < 1_000) return String(value)
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`
  return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 2 : 1)}m`
}

export function formatTokenUsage(usage: TokenUsage): string {
  return (
    `${formatTokenCount(usage.inputTokens)} input · ` +
    `${formatTokenCount(usage.outputTokens)} output · ` +
    `${formatTokenCount(usage.cacheReadInputTokens)} cache read · ` +
    `${formatTokenCount(usage.cacheCreationInputTokens)} cache write · ` +
    `${formatTokenCount(usage.totalTokens)} total`
  )
}
