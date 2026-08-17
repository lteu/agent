import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { ChatMessage } from './llm.js'
import type { TokenUsage } from './token-usage.js'

export type CodexExecEvent =
  | { type: 'text'; content: string }
  | { type: 'thinking'; content: string }
  | {
      type: 'progress'
      phase: 'start' | 'success' | 'failure' | 'info'
      name: string
      summary: string
      detail?: string
      callId?: string
    }
  | { type: 'usage'; usage: TokenUsage }

export type CodexExecOptions = {
  model: string
  signal?: AbortSignal
  cwd?: string
  /** Test/deployment override; defaults to AI_CODEX_BIN and then `codex`. */
  executable?: string
}

function renderMessage(message: ChatMessage): string {
  const calls = message.tool_calls?.length
    ? `\nTool calls: ${JSON.stringify(message.tool_calls)}`
    : ''
  const toolId = message.tool_call_id ? ` (${message.tool_call_id})` : ''
  return `<${message.role}${toolId}>\n${message.content ?? ''}${calls}\n</${message.role}>`
}

/**
 * Codex owns the agent/tool loop for this backend. We pass the existing ai
 * transcript as tagged text so switching providers does not discard context.
 */
export function renderCodexPrompt(messages: ChatMessage[]): string {
  return [
    'Continue the following conversation. Treat <system> blocks as the harness instructions and preserve the user\'s intent. Return only the assistant response for the latest user request.',
    ...messages.map(renderMessage),
  ].join('\n\n')
}

function itemLabel(item: any): { name: string; summary: string; detail?: string } {
  const type = typeof item?.type === 'string' ? item.type : 'codex'
  if (type === 'command_execution') {
    const command = String(item?.command ?? 'command')
    return { name: 'run_bash', summary: command, detail: item?.aggregated_output }
  }
  if (type === 'file_change') {
    return { name: 'file_change', summary: String(item?.path ?? item?.changes?.[0]?.path ?? 'Updated files') }
  }
  if (type === 'mcp_tool_call') {
    return { name: String(item?.tool ?? item?.name ?? 'mcp'), summary: String(item?.server ?? 'MCP tool') }
  }
  if (type === 'web_search') {
    return { name: 'web_search', summary: String(item?.query ?? 'Searching the web') }
  }
  if (type === 'plan') {
    return { name: 'plan', summary: 'Updated plan' }
  }
  return { name: type, summary: type.replaceAll('_', ' ') }
}

function usageFromEvent(value: any): TokenUsage {
  const inputTokens = Number(value?.input_tokens ?? 0)
  const outputTokens = Number(value?.output_tokens ?? 0)
  return {
    inputTokens,
    outputTokens,
    cacheReadInputTokens: Number(value?.cached_input_tokens ?? 0),
    cacheCreationInputTokens: Number(value?.cache_write_input_tokens ?? 0),
    totalTokens: inputTokens + outputTokens,
  }
}

/** Stream a single subscription-authenticated Codex turn as harness events. */
export async function* runCodexExec(
  messages: ChatMessage[],
  options: CodexExecOptions,
): AsyncGenerator<CodexExecEvent, void, unknown> {
  if (options.signal?.aborted) throw new DOMException('已中断', 'AbortError')

  const executable = options.executable || process.env.AI_CODEX_BIN || 'codex'
  const child = spawn(
    executable,
    [
      'exec',
      '--json',
      '--ephemeral',
      '--model',
      options.model,
      '--sandbox',
      'workspace-write',
      '--skip-git-repo-check',
      '-',
    ],
    {
      cwd: options.cwd ?? process.cwd(),
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  )

  let stderr = ''
  let spawnError: Error | undefined
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => {
    stderr = (stderr + String(chunk)).slice(-12_000)
  })
  child.on('error', error => {
    spawnError = error
  })

  const abort = () => child.kill('SIGTERM')
  options.signal?.addEventListener('abort', abort, { once: true })
  child.stdin.on('error', () => {})
  child.stdin.end(renderCodexPrompt(messages))

  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      if (!line.trim()) continue
      let event: any
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }

      if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
        const content = String(event.item.text ?? '')
        if (content) yield { type: 'text', content }
        continue
      }
      if (event.type === 'item.completed' && event.item?.type === 'reasoning') {
        const content = String(event.item.text ?? '')
        if (content) yield { type: 'thinking', content }
        continue
      }
      if (event.type === 'item.started') {
        const item = itemLabel(event.item)
        yield { type: 'progress', phase: 'start', ...item, callId: event.item?.id }
        continue
      }
      if (event.type === 'item.completed' && event.item?.type !== 'agent_message') {
        const item = itemLabel(event.item)
        const failed = event.item?.status === 'failed'
        yield {
          type: 'progress',
          phase: failed ? 'failure' : 'success',
          ...item,
          callId: event.item?.id,
        }
        continue
      }
      if (event.type === 'turn.completed') {
        yield { type: 'usage', usage: usageFromEvent(event.usage) }
        continue
      }
      if (event.type === 'turn.failed' || event.type === 'error') {
        const message = event.error?.message ?? event.message ?? 'Codex turn failed'
        throw new Error(String(message))
      }
    }

    const exitCode = await new Promise<number | null>(resolve => {
      if (child.exitCode !== null) resolve(child.exitCode)
      else child.once('close', resolve)
    })
    if (options.signal?.aborted) throw new DOMException('已中断', 'AbortError')
    if (spawnError) throw spawnError
    if (exitCode !== 0) {
      throw new Error(`Codex exec failed (exit ${exitCode ?? 'unknown'}): ${stderr.trim() || 'no error output'}`)
    }
  } finally {
    options.signal?.removeEventListener('abort', abort)
    lines.close()
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  }
}
