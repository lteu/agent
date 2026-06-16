// DeepSeek 客户端：OpenAI 兼容的 /chat/completions 流式接口。
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
  signal?: AbortSignal
}

const DEFAULT_BASE_URL = 'https://api.deepseek.com'

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
    throw new Error(`DeepSeek 请求失败 (HTTP ${res.status}): ${detail.slice(0, 300)}`)
  }

  const json = await res.json()
  const msg = json?.choices?.[0]?.message ?? {}
  return {
    content: typeof msg.content === 'string' ? msg.content : '',
    toolCalls: Array.isArray(msg.tool_calls) ? msg.tool_calls : [],
  }
}

/**
 * 向 DeepSeek 发送一轮对话，逐段产出助手回复文本（增量）。
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
    throw new Error(`DeepSeek 请求失败 (HTTP ${res.status}): ${detail.slice(0, 300)}`)
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
