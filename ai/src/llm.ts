// 通用大模型客户端：任何 OpenAI 兼容的 /chat/completions 接口都能用。
// 只要在配置里给出 baseURL / model / apiKey，即可对接 DeepSeek、OpenAI、
// 通义千问、Moonshot、OpenRouter、本地 Ollama 等任意服务商。
// 仅依赖 Node 内置的全局 fetch（Node 18+）。

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

export type StreamOptions = {
  apiKey: string
  model: string
  baseURL?: string
  /** 服务商显示名，仅用于报错信息（如 "OpenAI"、"通义千问"）。 */
  provider?: string
  signal?: AbortSignal
}

const DEFAULT_BASE_URL = 'https://api.deepseek.com'

/** 报错前缀，带上服务商名方便定位是哪家的问题。 */
function errLabel(opts: StreamOptions): string {
  return opts.provider ? `${opts.provider} 请求失败` : '模型请求失败'
}

// 一轮（非流式）补全的结果：要么是给用户的文字，要么是想调用的工具。
export type Completion = {
  content: string
  toolCalls: RawToolCall[]
}

/**
 * 非流式补全，支持 function calling。
 * 传入 tools 后，模型可能返回 tool_calls 而不是直接回话。
 */
export async function chatComplete(
  messages: ChatMessage[],
  opts: StreamOptions & { tools?: readonly unknown[] },
): Promise<Completion> {
  const baseURL = (opts.baseURL ?? DEFAULT_BASE_URL).replace(/\/$/, '')
  const res = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify({
      model: opts.model,
      messages,
      stream: false,
      ...(opts.tools && opts.tools.length ? { tools: opts.tools } : {}),
    }),
    signal: opts.signal,
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`${errLabel(opts)} (HTTP ${res.status}): ${detail.slice(0, 300)}`)
  }

  const json = await res.json()
  const msg = json?.choices?.[0]?.message ?? {}
  return {
    content: typeof msg.content === 'string' ? msg.content : '',
    toolCalls: Array.isArray(msg.tool_calls) ? msg.tool_calls : [],
  }
}

// 流式补全产出的事件：文本增量，或「已组装完整」的一次工具调用。
// tool 事件在该工具的参数刚拼完整时立刻产出（不必等整段流结束）——
// 这正是上层 StreamingToolExecutor「模型还在输出就开跑」的前提。
export type StreamPart =
  | { type: 'text'; delta: string }
  | { type: 'tool'; call: RawToolCall }

/**
 * 流式补全，支持 function calling。
 * 边收 SSE 边产出：content 片段实时吐出；每个 tool_call 的参数一旦拼完整，
 * 立即作为 { type:'tool' } 产出（依据「出现更大的 tool index」或「流结束」判定完整）。
 * 生成器的「返回值」是组装好的整轮结果 { content, toolCalls }，供上层落历史。
 */
export async function* streamCompletion(
  messages: ChatMessage[],
  opts: StreamOptions & { tools?: readonly unknown[] },
): AsyncGenerator<StreamPart, Completion, unknown> {
  const baseURL = (opts.baseURL ?? DEFAULT_BASE_URL).replace(/\/$/, '')
  const res = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify({
      model: opts.model,
      messages,
      stream: true,
      ...(opts.tools && opts.tools.length ? { tools: opts.tools } : {}),
    }),
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
      const delta = json?.choices?.[0]?.delta
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
  return { content, toolCalls }
}

/**
 * 向模型发送一轮对话，逐段产出助手回复文本（增量）。
 * 用法：for await (const delta of streamChat(messages, opts)) { ... }
 */
export async function* streamChat(
  messages: ChatMessage[],
  opts: StreamOptions,
): AsyncGenerator<string, void, unknown> {
  const baseURL = (opts.baseURL ?? DEFAULT_BASE_URL).replace(/\/$/, '')
  const res = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify({
      model: opts.model,
      messages,
      stream: true,
    }),
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
