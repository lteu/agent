// LLM 上下文追踪：同一事件同时写两份 JSONL。
//   history-trace-full.jsonl     完整消息快照，适合复盘模型实际看到了什么
//   history-trace-summary.jsonl  消息摘要，适合检索、统计和定位上下文漂移
//
// 默认关闭；设置 TRACE=1 后启用。完整日志可能包含文件内容、工具结果等敏感信息。

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import type { ChatMessage } from '../llm.js'
import type { LlmRequestSnapshot } from '../llm.js'

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
  const content = event?.content ?? ''
  const detail = event?.detail ?? ''
  const payload = {
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
  try {
    mkdirSync(logDir, { recursive: true })
    appendFileSync(join(logDir, 'agent-events.jsonl'), JSON.stringify(payload) + '\n')
  } catch {
    /* Diagnostics must never interrupt the agent. */
  }
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
    appendFileSync(
      join(logDir, 'history-trace-full.jsonl'),
      JSON.stringify({ ...base, messages: history }) + '\n',
    )
    appendFileSync(
      join(logDir, 'history-trace-summary.jsonl'),
      JSON.stringify({
        ...base,
        estimatedCharacters: history.reduce((sum, message) => {
          const toolCharacters = (message.tool_calls ?? []).reduce(
            (n, call) => n + call.function.name.length + call.function.arguments.length,
            0,
          )
          return sum + (message.content?.length ?? 0) + toolCharacters
        }, 0),
        messages: history.map(summarizeMessage),
      }) + '\n',
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
    appendFileSync(
      join(logDir, 'history-trace-full.jsonl'),
      JSON.stringify({ ...base, request, parsedBody }) + '\n',
    )
    appendFileSync(
      join(logDir, 'history-trace-summary.jsonl'),
      JSON.stringify({
        ...base,
        model: parsedBody.model,
        stream: parsedBody.stream,
        messageCount: messages.length,
        toolCount: tools.length,
        messageRoles: messages.map((message: any) => message?.role ?? 'unknown'),
      }) + '\n',
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
