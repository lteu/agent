// DeepSeek 客户端：OpenAI 兼容的 /chat/completions 流式接口。
// 仅依赖 Node 内置的全局 fetch（Node 18+）。

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export type StreamOptions = {
  apiKey: string
  model: string
  baseURL?: string
  signal?: AbortSignal
}

const DEFAULT_BASE_URL = 'https://api.deepseek.com'

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
