// 通用大模型客户端：优先支持任意 OpenAI 兼容的 /chat/completions 接口
// （DeepSeek、OpenAI、通义千问、Moonshot、OpenRouter、本地 Ollama 等），
// 另外原生支持 Anthropic（Claude）的 /v1/messages 协议——它和 OpenAI 格式不兼容，
// 认证头、请求体、流式事件都不同，因此单独实现一套转换逻辑，对上层（engine.ts /
// compact.ts）完全透明：一样的 ChatMessage[] 入参，一样的 Completion/StreamPart 出参。
// 仅依赖 Node 内置的全局 fetch（Node 18+）。

import {
  tokenUsageFromAnthropic,
  tokenUsageFromOpenAI,
  type TokenUsage,
} from './token-usage.js'

export type RawToolCall = {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  // assistant 想调用工具时带上；tool 角色回结果时带 tool_call_id
  tool_calls?: RawToolCall[]
  tool_call_id?: string
}

/**
 * Some OpenAI-compatible providers reject an assistant message whose content is empty.
 * An empty assistant with tool_calls is valid and must be kept for tool-result pairing.
 */
export function messagesForRequest(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter(message => {
    if (message.role !== 'assistant') return true
    if (message.tool_calls?.length) return true
    return Boolean(message.content?.trim())
  })
}

export type StreamOptions = {
  apiKey: string
  model: string
  baseURL?: string
  /** 服务商显示名，仅用于报错信息（如 "OpenAI"、"通义千问"）；也用于判断是否走 Anthropic 协议。 */
  provider?: string
  signal?: AbortSignal
  /** 在真正 fetch 前暴露实际 URL 和请求体；调用方负责脱敏与落盘。 */
  onRequest?: (request: LlmRequestSnapshot) => void
  /** 每次成功模型请求只调用一次；用于按 Claude Code 口径累计 token。 */
  onUsage?: (usage: TokenUsage) => void
}

export type LlmRequestSnapshot = {
  protocol: 'openai-compatible' | 'anthropic'
  url: string
  method: 'POST'
  headers: Record<string, string>
  /** 与 fetch 实际使用的字符串完全一致。 */
  body: string
}

const DEFAULT_BASE_URL = 'https://api.deepseek.com'

/** Anthropic 协议专用参数与默认值。 */
const ANTHROPIC_VERSION = '2023-06-01'
const ANTHROPIC_DEFAULT_MAX_TOKENS = 8192

/** 报错前缀，带上服务商名方便定位是哪家的问题。 */
function errLabel(opts: StreamOptions): string {
  return opts.provider ? `${opts.provider} 请求失败` : '模型请求失败'
}

/** 判断该请求应走 Anthropic 原生协议（/v1/messages）而非 OpenAI 兼容协议（/chat/completions）。 */
function isAnthropic(opts: StreamOptions): boolean {
  return /anthropic/i.test(opts.provider ?? '') || /anthropic\.com/i.test(opts.baseURL ?? '')
}

// 一轮补全的结果：要么是给用户的文字，要么是想调用的工具。
// finishReason 是服务商给出的本轮停止原因（'stop' | 'length' | 'tool_calls' | 'content_filter' …），
// 上层据此做「被截断就续写」等恢复（仅流式补全会填充它）。
export type Completion = {
  content: string
  toolCalls: RawToolCall[]
  finishReason?: string
  usage?: TokenUsage
  /** Remote 内置 Web 工具的结果，只进入后续模型历史，不作为正文显示。 */
  remoteContext?: string
}

// ———————————————————————————————————————————————
// Anthropic ↔ 通用格式 转换
// ———————————————————————————————————————————————

/** Anthropic 的停止原因映射成本项目通用的 OpenAI 风格取值，engine.ts 只关心 'length'。 */
function mapAnthropicStop(reason?: string | null): string | undefined {
  if (!reason) return undefined
  if (reason === 'max_tokens') return 'length'
  if (reason === 'tool_use') return 'tool_calls'
  if (reason === 'end_turn') return 'stop'
  return reason
}

/**
 * 把内部 ChatMessage[]（OpenAI 风格：system 单独一条、tool 结果各占一条）
 * 转成 Anthropic 要求的 { system, messages }：
 * - system 角色的内容合并成顶层 system 字符串；
 * - assistant 的 tool_calls 转成 content 里的 tool_use 块；
 * - 连续的 tool 结果必须合并进同一条 user 消息的多个 tool_result 块（Anthropic 硬性要求）。
 */
function toAnthropicPayload(messages: ChatMessage[]): { system?: string; messages: any[] } {
  const systemParts: string[] = []
  const out: any[] = []

  for (const m of messagesForRequest(messages)) {
    if (m.role === 'system') {
      if (m.content) systemParts.push(m.content)
      continue
    }

    if (m.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content ?? '' }
      const last = out[out.length - 1]
      if (last && last.role === 'user' && Array.isArray(last.content) && last.content[0]?.type === 'tool_result') {
        last.content.push(block)
      } else {
        out.push({ role: 'user', content: [block] })
      }
      continue
    }

    if (m.role === 'assistant') {
      if (!m.tool_calls || !m.tool_calls.length) {
        out.push({ role: 'assistant', content: m.content || '' })
        continue
      }
      const content: any[] = []
      if (m.content) content.push({ type: 'text', text: m.content })
      for (const tc of m.tool_calls) {
        let input: any = {}
        try {
          input = JSON.parse(tc.function.arguments || '{}')
        } catch {
          /* 参数解析失败时按空对象处理 */
        }
        content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input })
      }
      out.push({ role: 'assistant', content })
      continue
    }

    // user
    out.push({ role: 'user', content: m.content ?? '' })
  }

  return { system: systemParts.length ? systemParts.join('\n\n') : undefined, messages: out }
}

/** 把 OpenAI function-calling 格式的工具定义（TOOL_SCHEMAS 里那种）转成 Anthropic 的 tool 定义。 */
function toAnthropicTools(tools: readonly any[]): any[] {
  return tools.map(t => {
    const fn = t.function ?? t
    return {
      name: fn.name,
      description: fn.description,
      input_schema: fn.parameters ?? { type: 'object', properties: {} },
    }
  })
}

function anthropicHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
  }
}

function anthropicURL(baseURL: string): string {
  return `${baseURL}/v1/messages`
}

function emitRequest(
  opts: StreamOptions,
  protocol: LlmRequestSnapshot['protocol'],
  url: string,
  headers: Record<string, string>,
  body: string,
): void {
  opts.onRequest?.({ protocol, url, method: 'POST', headers, body })
}

/** 把 Anthropic 非流式 /v1/messages 响应体的 content 块解析成 Completion。 */
function parseAnthropicMessage(json: any): Completion {
  let content = ''
  const toolCalls: RawToolCall[] = []
  for (const block of json?.content ?? []) {
    if (block.type === 'text') {
      content += block.text
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
      })
    }
  }
  return {
    content,
    toolCalls,
    finishReason: mapAnthropicStop(json?.stop_reason),
    usage: tokenUsageFromAnthropic(json?.usage),
  }
}

async function anthropicChatComplete(
  messages: ChatMessage[],
  opts: StreamOptions & { tools?: readonly unknown[] },
): Promise<Completion> {
  const baseURL = (opts.baseURL ?? DEFAULT_BASE_URL).replace(/\/$/, '')
  const { system, messages: anthropicMessages } = toAnthropicPayload(messages)
  const url = anthropicURL(baseURL)
  const body = {
    model: opts.model,
    max_tokens: ANTHROPIC_DEFAULT_MAX_TOKENS,
    stream: false,
    ...(system ? { system } : {}),
    messages: anthropicMessages,
    ...(opts.tools && opts.tools.length ? { tools: toAnthropicTools(opts.tools) } : {}),
  }
  const headers = anthropicHeaders(opts.apiKey)
  const serializedBody = JSON.stringify(body)
  emitRequest(opts, 'anthropic', url, headers, serializedBody)
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: serializedBody,
    signal: opts.signal,
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`${errLabel(opts)} (HTTP ${res.status}): ${detail.slice(0, 300)}`)
  }

  const completion = parseAnthropicMessage(await res.json())
  if (completion.usage) opts.onUsage?.(completion.usage)
  return completion
}

async function* anthropicStreamCompletion(
  messages: ChatMessage[],
  opts: StreamOptions & { tools?: readonly unknown[] },
): AsyncGenerator<StreamPart, Completion, unknown> {
  const baseURL = (opts.baseURL ?? DEFAULT_BASE_URL).replace(/\/$/, '')
  const { system, messages: anthropicMessages } = toAnthropicPayload(messages)
  const url = anthropicURL(baseURL)
  const body = {
    model: opts.model,
    max_tokens: ANTHROPIC_DEFAULT_MAX_TOKENS,
    stream: true,
    ...(system ? { system } : {}),
    messages: anthropicMessages,
    ...(opts.tools && opts.tools.length ? { tools: toAnthropicTools(opts.tools) } : {}),
  }
  const headers = anthropicHeaders(opts.apiKey)
  const serializedBody = JSON.stringify(body)
  emitRequest(opts, 'anthropic', url, headers, serializedBody)
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: serializedBody,
    signal: opts.signal,
  })

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '')
    throw new Error(`${errLabel(opts)} (HTTP ${res.status}): ${detail.slice(0, 300)}`)
  }

  // 按 content block index 累积：text 块边到边吐 delta，tool_use 块攒够 input_json_delta
  // 后在 content_block_stop 时一次性产出（Anthropic 明确告诉我们块何时结束，不必像
  // OpenAI 那样靠「下一个 index 出现」去猜）。
  const blocks = new Map<number, { type: 'text' | 'tool_use'; id?: string; name?: string; args: string }>()
  let content = ''
  let stopReason: string | undefined
  let usage = tokenUsageFromAnthropic(undefined)

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let nl: number
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload) continue
      let evt: any
      try {
        evt = JSON.parse(payload)
      } catch {
        continue // 不完整片段，忽略
      }

      switch (evt.type) {
        case 'message_start': {
          usage = tokenUsageFromAnthropic(evt.message?.usage)
          break
        }
        case 'content_block_start': {
          const cb = evt.content_block
          if (cb?.type === 'text') blocks.set(evt.index, { type: 'text', args: '' })
          else if (cb?.type === 'tool_use') blocks.set(evt.index, { type: 'tool_use', id: cb.id, name: cb.name, args: '' })
          break
        }
        case 'content_block_delta': {
          const b = blocks.get(evt.index)
          if (!b) break
          if (evt.delta?.type === 'text_delta' && typeof evt.delta.text === 'string') {
            content += evt.delta.text
            yield { type: 'text', delta: evt.delta.text }
          } else if (evt.delta?.type === 'input_json_delta' && typeof evt.delta.partial_json === 'string') {
            b.args += evt.delta.partial_json
          }
          break
        }
        case 'content_block_stop': {
          const b = blocks.get(evt.index)
          if (b?.type === 'tool_use') {
            yield {
              type: 'tool',
              call: {
                id: b.id || `call_${evt.index}`,
                type: 'function',
                function: { name: b.name || '', arguments: b.args || '{}' },
              },
            }
          }
          break
        }
        case 'message_delta': {
          if (evt.delta?.stop_reason) stopReason = evt.delta.stop_reason
          const deltaUsage = tokenUsageFromAnthropic(evt.usage)
          usage = {
            inputTokens: usage.inputTokens || deltaUsage.inputTokens,
            outputTokens: deltaUsage.outputTokens || usage.outputTokens,
            cacheReadInputTokens:
              usage.cacheReadInputTokens || deltaUsage.cacheReadInputTokens,
            cacheCreationInputTokens:
              usage.cacheCreationInputTokens || deltaUsage.cacheCreationInputTokens,
            totalTokens: 0,
          }
          usage.totalTokens =
            usage.inputTokens +
            usage.outputTokens +
            usage.cacheReadInputTokens +
            usage.cacheCreationInputTokens
          break
        }
        case 'error':
          throw new Error(`${errLabel(opts)}: ${evt.error?.message ?? JSON.stringify(evt)}`)
        default:
          break
      }
    }
  }

  const toolCalls: RawToolCall[] = [...blocks.entries()]
    .filter(([, b]) => b.type === 'tool_use')
    .map(([idx, b]) => ({
      id: b.id || `call_${idx}`,
      type: 'function',
      function: { name: b.name || '', arguments: b.args || '{}' },
    }))

  opts.onUsage?.(usage)
  return { content, toolCalls, finishReason: mapAnthropicStop(stopReason), usage }
}

async function* anthropicStreamChat(
  messages: ChatMessage[],
  opts: StreamOptions,
): AsyncGenerator<string, void, unknown> {
  const stream = anthropicStreamCompletion(messages, opts)
  let res = await stream.next()
  while (!res.done) {
    if (res.value.type === 'text') yield res.value.delta
    res = await stream.next()
  }
}

// ———————————————————————————————————————————————
// 公共入口：按 provider/baseURL 分流到 Anthropic 或 OpenAI 兼容实现
// ———————————————————————————————————————————————

/**
 * 非流式补全，支持 function calling。
 * 传入 tools 后，模型可能返回 tool_calls 而不是直接回话。
 */
export async function chatComplete(
  messages: ChatMessage[],
  opts: StreamOptions & { tools?: readonly unknown[] },
): Promise<Completion> {
  if (isAnthropic(opts)) return anthropicChatComplete(messages, opts)

  const baseURL = (opts.baseURL ?? DEFAULT_BASE_URL).replace(/\/$/, '')
  const url = `${baseURL}/chat/completions`
  const body = {
    model: opts.model,
    messages: messagesForRequest(messages),
    stream: false,
    ...(opts.tools && opts.tools.length ? { tools: opts.tools } : {}),
  }
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${opts.apiKey}`,
  }
  const serializedBody = JSON.stringify(body)
  emitRequest(opts, 'openai-compatible', url, headers, serializedBody)
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: serializedBody,
    signal: opts.signal,
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`${errLabel(opts)} (HTTP ${res.status}): ${detail.slice(0, 300)}`)
  }

  const json = await res.json()
  const msg = json?.choices?.[0]?.message ?? {}
  const usage = tokenUsageFromOpenAI(json?.usage)
  opts.onUsage?.(usage)
  return {
    content: typeof msg.content === 'string' ? msg.content : '',
    toolCalls: Array.isArray(msg.tool_calls) ? msg.tool_calls : [],
    usage,
  }
}

// 流式补全产出的事件：文本增量，或「已组装完整」的一次工具调用。
// tool 事件在该工具的参数刚拼完整时立刻产出（不必等整段流结束）——
// 这正是上层 StreamingToolExecutor「模型还在输出就开跑」的前提。
export type StreamPart =
  | { type: 'text'; delta: string }
  | { type: 'tool'; call: RawToolCall }
  | {
      type: 'progress'
      progress: {
        phase: 'start' | 'success' | 'failure' | 'info'
        name: string
        summary: string
        detail?: string
        callId?: string
      }
    }

/**
 * 流式补全，支持 function calling。
 * 边收 SSE 边产出：content 片段实时吐出；每个 tool_call 的参数一旦拼完整，
 * 立即作为 { type:'tool' } 产出（OpenAI 依据「出现更大的 tool index」判定完整；
 * Anthropic 依据显式的 content_block_stop 判定完整）。
 * 生成器的「返回值」是组装好的整轮结果 { content, toolCalls }，供上层落历史。
 */
export async function* streamCompletion(
  messages: ChatMessage[],
  opts: StreamOptions & { tools?: readonly unknown[] },
): AsyncGenerator<StreamPart, Completion, unknown> {
  if (isAnthropic(opts)) return yield* anthropicStreamCompletion(messages, opts)

  const baseURL = (opts.baseURL ?? DEFAULT_BASE_URL).replace(/\/$/, '')
  const url = `${baseURL}/chat/completions`
  const body = {
    model: opts.model,
    messages: messagesForRequest(messages),
    stream: true,
    stream_options: { include_usage: true },
    ...(opts.tools && opts.tools.length ? { tools: opts.tools } : {}),
  }
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${opts.apiKey}`,
  }
  const serializedBody = JSON.stringify(body)
  emitRequest(opts, 'openai-compatible', url, headers, serializedBody)
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: serializedBody,
    signal: opts.signal,
  })

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '')
    throw new Error(`${errLabel(opts)} (HTTP ${res.status}): ${detail.slice(0, 300)}`)
  }

  // 按 index 累积各工具调用的 id/name/arguments 片段。
  const acc = new Map<number, { id: string; name: string; args: string }>()
  const emitted = new Set<number>()
  let maxIndex = -1
  let content = ''
  let finishReason: string | undefined
  let usage = tokenUsageFromOpenAI(undefined)
  let remoteContext = ''

  // 产出所有 index < upto（'all' 表示全部）且尚未产出的、已完整的工具调用。
  function* flush(upto: number | 'all'): Generator<StreamPart> {
    for (const idx of [...acc.keys()].sort((a, b) => a - b)) {
      if (emitted.has(idx)) continue
      if (upto !== 'all' && idx >= upto) continue
      const t = acc.get(idx)!
      emitted.add(idx)
      yield {
        type: 'tool',
        call: { id: t.id || `call_${idx}`, type: 'function', function: { name: t.name, arguments: t.args } },
      }
    }
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let nl: number
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload === '[DONE]') break
      let json: any
      try {
        json = JSON.parse(payload)
      } catch {
        continue // 不完整片段，忽略
      }
      if (json?.ai_remote_error?.message) {
        const requestId = json.ai_remote_error.requestId
        throw new Error(
          `Remote Claude 网关错误${requestId ? `（${requestId}）` : ''}: ${
            json.ai_remote_error.message
          }`,
        )
      }
      if (typeof json?.ai_remote_context?.content === 'string') {
        remoteContext = json.ai_remote_context.content
        continue
      }
      const progress = json?.ai_remote_progress
      if (
        progress &&
        ['start', 'success', 'failure', 'info'].includes(progress.phase) &&
        typeof progress.name === 'string' &&
        typeof progress.summary === 'string'
      ) {
        yield {
          type: 'progress',
          progress: {
            phase: progress.phase,
            name: progress.name,
            summary: progress.summary,
            ...(typeof progress.detail === 'string' ? { detail: progress.detail } : {}),
            ...(typeof progress.callId === 'string' ? { callId: progress.callId } : {}),
          },
        }
        continue
      }
      if (json?.usage) usage = tokenUsageFromOpenAI(json.usage)
      const choice = json?.choices?.[0]
      if (choice?.finish_reason) finishReason = choice.finish_reason
      const delta = choice?.delta
      if (!delta) continue
      if (typeof delta.content === 'string' && delta.content) {
        content += delta.content
        yield { type: 'text', delta: delta.content }
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx: number = tc.index ?? 0
          let cur = acc.get(idx)
          if (!cur) {
            cur = { id: '', name: '', args: '' }
            acc.set(idx, cur)
          }
          if (tc.id) cur.id = tc.id
          if (tc.function?.name) cur.name += tc.function.name
          if (typeof tc.function?.arguments === 'string') cur.args += tc.function.arguments
          if (idx > maxIndex) {
            maxIndex = idx
            yield* flush(idx) // 更大的 index 出现 → 之前的都已完整，立刻放行
          }
        }
      }
    }
  }

  yield* flush('all') // 流结束 → 放行剩余工具调用

  const toolCalls: RawToolCall[] = [...acc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([idx, t]) => ({
      id: t.id || `call_${idx}`,
      type: 'function',
      function: { name: t.name, arguments: t.args },
    }))
  opts.onUsage?.(usage)
  return { content, toolCalls, finishReason, usage, remoteContext: remoteContext || undefined }
}

/**
 * 向模型发送一轮对话，逐段产出助手回复文本（增量）。
 * 用法：for await (const delta of streamChat(messages, opts)) { ... }
 */
export async function* streamChat(
  messages: ChatMessage[],
  opts: StreamOptions,
): AsyncGenerator<string, void, unknown> {
  if (isAnthropic(opts)) return yield* anthropicStreamChat(messages, opts)

  const baseURL = (opts.baseURL ?? DEFAULT_BASE_URL).replace(/\/$/, '')
  const url = `${baseURL}/chat/completions`
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${opts.apiKey}`,
  }
  const body = JSON.stringify({
    model: opts.model,
    messages: messagesForRequest(messages),
    stream: true,
  })
  emitRequest(opts, 'openai-compatible', url, headers, body)
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body,
    signal: opts.signal,
  })

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '')
    throw new Error(`${errLabel(opts)} (HTTP ${res.status}): ${detail.slice(0, 300)}`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    // SSE 以空行分隔事件，事件内每行以 "data: " 开头
    let nl: number
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload === '[DONE]') return
      try {
        const json = JSON.parse(payload)
        const delta: string | undefined = json?.choices?.[0]?.delta?.content
        if (delta) yield delta
      } catch {
        // 不完整的 JSON 片段，忽略，等待下一块拼接
      }
    }
  }
}
