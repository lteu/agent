/**
 * ai-remote 的独立 Agent 入口。
 *
 * 设备认证头只在这个进程内、且只对 AI_BASE_URL 指向的托管服务注入。
 * 原来的 src/cli.tsx / src/llm.ts / dist/cli.js 不需要知道托管模式，也不会改变行为。
 */
const deviceId = process.env.AI_REMOTE_DEVICE_ID
const remoteBaseUrl = process.env.AI_BASE_URL?.replace(/\/$/, '')
const nativeFetch = globalThis.fetch.bind(globalThis)

if (!deviceId || !remoteBaseUrl) {
  console.error('ai-remote 启动参数不完整，请通过 ai-remote 命令启动。')
  process.exit(1)
}

globalThis.fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url
  if (!url.startsWith(`${remoteBaseUrl}/`)) return nativeFetch(input, init)

  const inherited = input instanceof Request ? input.headers : undefined
  const headers = new Headers(init?.headers ?? inherited)
  headers.set('X-AI-Device-ID', deviceId)
  return nativeFetch(input, { ...init, headers })
}

await import('./cli.js')
