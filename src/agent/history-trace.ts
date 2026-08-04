// LLM 上下文追踪：同一事件同时写两份 JSONL。
//   history-trace-full.jsonl     完整消息快照，适合复盘模型实际看到了什么
//   history-trace-summary.jsonl  消息摘要，适合检索、统计和定位上下文漂移
//
// 默认关闭；设置 TRACE=1 后启用。完整日志可能包含文件内容、工具结果等敏感信息。

import { appendFileSync, chmodSync, mkdirSync } from 'node:fs'
import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import type { ChatMessage } from '../llm.js'
import type { LlmRequestSnapshot, RemoteCommunicationTrace } from '../llm.js'

export type HistoryTraceContext = {
  runId: string
  channel: 'terminal' | 'ask' | 'qq' | 'wechat' | 'wx' | 'subagent' | 'unknown'
  sessionId: string
}

export type HistoryTraceDetails = {
  step?: number
  toolName?: string
  toolCallId?: string
  note?: string
}

type AgentEventForLog = {
  type?: string
  content?: string
  name?: string
  summary?: string
  detail?: string
  callId?: string
  batchId?: string
  phase?: string
  at?: number
  steps?: number
}

type AgentEventPayload = Record<string, unknown>
type StreamEventBatch = {
  logPath: string
  payload: AgentEventPayload
  chunks: string[]
  eventCount: number
  contentLength: number
}

const AGENT_EVENT_FLUSH_MS = 100
const DEFAULT_AGENT_EVENT_LOG_MAX_BYTES = 16 * 1024 * 1024
const streamEventBatches = new Map<string, StreamEventBatch>()
let queuedAgentEventLines = new Map<string, string[]>()
let agentEventFlushTimer: ReturnType<typeof setTimeout> | null = null
let agentEventWriteChain: Promise<void> = Promise.resolve()

function agentEventLogMaxBytes(): number {
  const configured = Number(process.env.AI_AGENT_EVENT_LOG_MAX_BYTES)
  return Number.isFinite(configured) && configured >= 1_024
    ? Math.floor(configured)
    : DEFAULT_AGENT_EVENT_LOG_MAX_BYTES
}

function queueAgentEventLine(logPath: string, payload: AgentEventPayload): void {
  const lines = queuedAgentEventLines.get(logPath) ?? []
  lines.push(JSON.stringify(payload) + '\n')
  queuedAgentEventLines.set(logPath, lines)
}

function materializeStreamBatch(key: string): void {
  const batch = streamEventBatches.get(key)
  if (!batch) return
  streamEventBatches.delete(key)
  const preview = batch.chunks.join('').slice(0, 1_000)
  queueAgentEventLine(batch.logPath, {
    ...batch.payload,
    eventCount: batch.eventCount,
    contentLength: batch.contentLength || undefined,
    contentPreview: preview || undefined,
  })
}

async function appendAgentEventLines(logPath: string, lines: string[]): Promise<void> {
  const maxBytes = agentEventLogMaxBytes()
  const data = lines.join('')
  await mkdir(dirname(logPath), { recursive: true })
  let currentBytes = 0
  try {
    currentBytes = (await stat(logPath)).size
  } catch {
    // A missing log starts at zero bytes.
  }
  if (currentBytes > 0 && currentBytes + Buffer.byteLength(data) > maxBytes) {
    await rm(`${logPath}.1`, { force: true })
    try {
      await rename(logPath, `${logPath}.1`)
    } catch {
      // Another flush/process may already have moved the file.
    }
  }
  await appendFile(logPath, data)
}

function drainAgentEventQueue(): void {
  if (!queuedAgentEventLines.size) return
  const queued = queuedAgentEventLines
  queuedAgentEventLines = new Map()
  agentEventWriteChain = agentEventWriteChain.then(async () => {
    for (const [logPath, lines] of queued) {
      try {
        await appendAgentEventLines(logPath, lines)
      } catch {
        /* Diagnostics must never interrupt the agent. */
      }
    }
  })
}

function scheduleAgentEventFlush(): void {
  if (agentEventFlushTimer) return
  agentEventFlushTimer = setTimeout(() => {
    agentEventFlushTimer = null
    for (const key of [...streamEventBatches.keys()]) materializeStreamBatch(key)
    drainAgentEventQueue()
  }, AGENT_EVENT_FLUSH_MS)
  agentEventFlushTimer.unref?.()
}

/** Wait until all buffered lifecycle diagnostics have reached disk (primarily for tests). */
export async function flushAgentEventLog(): Promise<void> {
  if (agentEventFlushTimer) clearTimeout(agentEventFlushTimer)
  agentEventFlushTimer = null
  for (const key of [...streamEventBatches.keys()]) materializeStreamBatch(key)
  drainAgentEventQueue()
  await agentEventWriteChain
}

function getLogDir(): string {
  const configured = process.env.AI_LOG_DIR?.trim()
  if (configured) return resolve(configured)

  const selfPath = fileURLToPath(import.meta.url)
  const selfDir = dirname(selfPath)
  const projectRoot =
    selfDir.endsWith('/dist') || selfDir.endsWith('/dist/')
      ? dirname(selfDir)
      : join(selfDir, '..', '..')
  return join(projectRoot, 'log')
}

export function createHistoryTraceContext(
  channel: HistoryTraceContext['channel'],
  sessionId: string,
): HistoryTraceContext {
  return { runId: randomUUID(), channel, sessionId }
}

/**
 * 始终记录轻量级 Agent 生命周期，供卡住、断流和“远端完成但本地无结果”排障。
 * 不记录完整工具输出；需要完整上下文时再显式设置 TRACE=1。
 */
export function traceAgentEvent(
  context: HistoryTraceContext,
  event: AgentEventForLog | null,
  error?: unknown,
): void {
  const logDir = getLogDir()
  const logPath = join(logDir, 'agent-events.jsonl')
  const content = event?.content ?? ''
  const detail = event?.detail ?? ''
  const payload: AgentEventPayload = {
    schemaVersion: 1,
    time: new Date().toISOString(),
    pid: process.pid,
    ...context,
    stage: error ? 'agent-error' : 'agent-event',
    eventType: event?.type,
    phase: event?.phase,
    name: event?.name,
    callId: event?.callId,
    batchId: event?.batchId,
    at: event?.at,
    steps: event?.steps,
    summary: event?.summary?.slice(0, 1_000),
    contentLength: content.length || undefined,
    contentPreview: content ? content.slice(0, 1_000) : undefined,
    detailLength: detail.length || undefined,
    error:
      error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack?.slice(0, 4_000) }
        : error
          ? { message: String(error) }
          : undefined,
  }
  const streamKey = `${logPath}\0${context.runId}`
  if (!error && (event?.type === 'thinking' || event?.type === 'delta')) {
    const existing = streamEventBatches.get(streamKey)
    if (existing && existing.payload.eventType !== event.type) materializeStreamBatch(streamKey)
    const batch = streamEventBatches.get(streamKey) ?? {
      logPath,
      payload: { ...payload, contentLength: undefined, contentPreview: undefined },
      chunks: [],
      eventCount: 0,
      contentLength: 0,
    }
    batch.chunks.push(content)
    batch.eventCount += 1
    batch.contentLength += content.length
    streamEventBatches.set(streamKey, batch)
  } else {
    materializeStreamBatch(streamKey)
    queueAgentEventLine(logPath, payload)
  }
  scheduleAgentEventFlush()
}

function summarizeMessage(message: ChatMessage, index: number) {
  const content = message.content ?? ''
  return {
    index,
    role: message.role,
    contentLength: content.length,
    contentPreview: content.slice(0, 500),
    toolCallId: message.tool_call_id,
    toolCalls: message.tool_calls?.map(call => ({
      id: call.id,
      name: call.function.name,
      argumentsLength: call.function.arguments.length,
      argumentsPreview: call.function.arguments.slice(0, 300),
    })),
  }
}

function messageForHistoryTrace(message: ChatMessage): Record<string, unknown> {
  if (!message.ai_local_tool_content?.length) return message
  return {
    ...message,
    ai_local_tool_content: message.ai_local_tool_content.map(block => ({
      type: block.type,
      mediaType: block.mediaType,
      base64Characters: block.data.length,
      data: '[omitted from repeated history snapshot; see llm-http-request/remote communication trace]',
    })),
  }
}

function appendSecureJsonl(path: string, value: unknown): void {
  appendFileSync(path, JSON.stringify(value) + '\n', { encoding: 'utf8', mode: 0o600 })
  chmodSync(path, 0o600)
}

/** 写入失败不能影响主对话；错误尽力另记到 history-trace-errors.log。 */
export function traceHistory(
  context: HistoryTraceContext,
  stage: string,
  history: ChatMessage[],
  details: HistoryTraceDetails = {},
): void {
  if (process.env.TRACE !== '1') return

  const logDir = getLogDir()
  const base = {
    schemaVersion: 1,
    time: new Date().toISOString(),
    pid: process.pid,
    ...context,
    stage,
    ...details,
    historyLength: history.length,
  }

  try {
    mkdirSync(logDir, { recursive: true })
    appendSecureJsonl(
      join(logDir, 'history-trace-full.jsonl'),
      { ...base, messages: history.map(messageForHistoryTrace) },
    )
    appendSecureJsonl(
      join(logDir, 'history-trace-summary.jsonl'),
      {
        ...base,
        estimatedCharacters: history.reduce((sum, message) => {
          const toolCharacters = (message.tool_calls ?? []).reduce(
            (n, call) => n + call.function.name.length + call.function.arguments.length,
            0,
          )
          return sum + (message.content?.length ?? 0) + toolCharacters
        }, 0),
        messages: history.map(summarizeMessage),
      },
    )
  } catch (error) {
    try {
      mkdirSync(logDir, { recursive: true })
      appendFileSync(
        join(logDir, 'history-trace-errors.log'),
        `[${new Date().toISOString()}] ${String(error)}\n`,
      )
    } catch {
      // trace 永远不能打断用户任务
    }
  }
}

/** 记录 fetch 前的完整实际请求；按工程诊断要求包含认证请求头/API Key。 */
export function traceLlmRequest(
  context: HistoryTraceContext,
  request: LlmRequestSnapshot,
  requestKind: 'agent' | 'compact' | 'verify' | 'other' = 'other',
): void {
  if (process.env.TRACE !== '1') return

  const logDir = getLogDir()
  let parsedBody: Record<string, any> = {}
  try {
    parsedBody = JSON.parse(request.body)
  } catch {
    // body 仍会原样进入完整日志；摘要缺失不影响完整性
  }
  const messages = Array.isArray(parsedBody.messages) ? parsedBody.messages : []
  const tools = Array.isArray(parsedBody.tools) ? parsedBody.tools : []
  const base = {
    schemaVersion: 1,
    time: new Date().toISOString(),
    pid: process.pid,
    ...context,
    stage: 'llm-http-request',
    requestKind,
    protocol: request.protocol,
    url: request.url,
    method: request.method,
  }

  try {
    mkdirSync(logDir, { recursive: true })
    appendSecureJsonl(
      join(logDir, 'history-trace-full.jsonl'),
      { ...base, request, parsedBody },
    )
    appendSecureJsonl(
      join(logDir, 'history-trace-summary.jsonl'),
      {
        ...base,
        model: parsedBody.model,
        stream: parsedBody.stream,
        messageCount: messages.length,
        toolCount: tools.length,
        messageRoles: messages.map((message: any) => message?.role ?? 'unknown'),
      },
    )
  } catch (error) {
    try {
      mkdirSync(logDir, { recursive: true })
      appendFileSync(
        join(logDir, 'history-trace-errors.log'),
        `[${new Date().toISOString()}] ${String(error)}\n`,
      )
    } catch {
      // trace 永远不能打断用户任务
    }
  }
}

/**
 * TRACE=1 专用：记录远端 gateway 与 Claude Code 之间的原始双向通信。
 * 该文件可能包含完整 prompt、工具参数/结果和模型输出，禁止默认开启。
 */
export function traceRemoteCommunication(
  context: HistoryTraceContext,
  event: RemoteCommunicationTrace,
): void {
  if (process.env.TRACE !== '1') return
  const logDir = getLogDir()
  const logPath = join(logDir, 'remote-communication.jsonl')
  try {
    mkdirSync(logDir, { recursive: true })
    appendFileSync(
      logPath,
      JSON.stringify({
        schemaVersion: 1,
        time: new Date().toISOString(),
        pid: process.pid,
        ...context,
        stage: 'remote-communication',
        ...event,
      }) + '\n',
      { encoding: 'utf8', mode: 0o600 },
    )
    chmodSync(logPath, 0o600)
  } catch (error) {
    try {
      mkdirSync(logDir, { recursive: true })
      appendFileSync(
        join(logDir, 'history-trace-errors.log'),
        `[${new Date().toISOString()}] remote communication: ${String(error)}\n`,
      )
    } catch {
      // trace 永远不能打断用户任务
    }
  }
}
