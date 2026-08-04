// Agent 引擎：与 UI 无关的「模型↔工具反复调用」循环。
// 终端界面和 QQ/微信 channel 共用它——谁来消费这个事件流都行。
//
// 用法：
//   for await (const ev of runAgent(history, deps)) {
//     if (ev.type === 'delta') ...  // 流式文本增量（终端实时打字机；channel 可忽略）
//     if (ev.type === 'text')  ...  // 一整段助手文本（channel/日志按段消费）
//     if (ev.type === 'tool')  ...  // 工具 start/success/failure/info 生命周期事件
//   }
// history 会被原地追加（assistant / tool 消息），方便跨轮累积上下文。
//
// 本轮相较最初的「非流式 for 循环」升级了三处（对标 Claude Code）：
//   1. 模型调用改为流式 streamCompletion，文本边出边产出 delta；
//   2. 工具调用在流式阶段收集，待完整响应落入历史后再执行，避免流失败重试造成副作用重复；
//   3. 每轮开头按需做上下文压缩 compactInPlace。

import {
  createRemoteClaudeSession,
  disableRemoteClaudeSession,
  isRemoteClaudeProvider,
  resetRemoteClaudeSession,
  streamCompletion,
  type ChatMessage,
  type RawToolCall,
  type Completion,
} from '../llm.js'
import { writeToolDebugEvent } from '../crashlog.js'
import {
  TOOL_SCHEMAS,
  runTool,
  describeToolCall,
  describeToolSuccess,
  describeToolFailure,
  formatToolResult,
  summarizeToolFailure,
  type ToolContext,
  type ToolResult,
} from '../tools.js'
import { compactInPlace, type CompactDeps } from './compact.js'
import {
  createHistoryTraceContext,
  traceAgentEvent,
  traceHistory,
  traceLlmRequest,
  type HistoryTraceContext,
} from './history-trace.js'
import { verifyFinalResult, type VerifyResult } from './verify.js'
import {
  evaluateVerificationEvidence,
  verificationNudge,
  verificationRequirementForFiles,
  type VerificationCheckKind,
} from './verification-policy.js'

export type AgentEvent =
  | {
      type: 'model'
      phase: 'connecting' | 'waiting' | 'receiving'
      at: number
    }
  // 流式文本增量：给终端做实时显示；channel（QQ/微信）按段发送，忽略它。
  | { type: 'delta'; content: string }
  // 后端明确提供的 thinking/reasoning 增量；只用于 UI 转录，不写入普通聊天正文。
  | { type: 'thinking'; content: string }
  // 一整段助手文本（一轮里 content 的最终态）：channel/日志按段消费。
  | { type: 'text'; content: string }
  | {
      type: 'tool'
      name: string
      summary: string
      /** verbose transcript 使用；默认视图不渲染，避免工具输出淹没对话。 */
      detail?: string
      /** 普通工具有稳定 callId，供 UI 把运行态原地更新为最终态。系统状态没有 callId。 */
      callId?: string
      /** 同一轮并行工具共享 batchId；batchSize 让默认 UI 在整批结束后折叠为一行。 */
      batchId?: string
      batchSize?: number
      phase: 'start' | 'success' | 'failure' | 'info'
    }
  // 撞到最大步数：不直接结束，而是问一句「要不要继续」，由消费方提示用户回复「继续」接着跑。
  | { type: 'limit'; steps: number }

export type AgentTerminationErrorCode =
  | 'empty_response'
  | 'content_filtered'
  | 'output_recovery_exhausted'
  | 'unexpected_finish_reason'

/** 模型没有以可接受的终止状态结束时抛出，供 CLI/channel 区分协议错误与普通网络错误。 */
export class AgentTerminationError extends Error {
  constructor(
    public readonly code: AgentTerminationErrorCode,
    message: string,
    public readonly finishReason?: string,
  ) {
    super(message)
    this.name = 'AgentTerminationError'
  }
}

/** 由具体 channel 注入的额外工具（如 QQ 的 send_image），与内置工具合并提供给模型。 */
export type ExtraTools = {
  schemas: readonly { function: { name: string } }[]
  run: (name: string, args: Record<string, any>, signal?: AbortSignal) => Promise<string> | string
}

export type EngineDeps = CompactDeps & {
  /** 防止工具循环失控的最大步数，默认 25。 */
  maxSteps?: number
  /** channel 专属工具：与内置 TOOL_SCHEMAS 合并，执行时优先用它。 */
  extraTools?: ExtraTools
  /** 子 agent 递归深度，由 run_agent 工具派生时自增，用于限制嵌套层数。 */
  depth?: number
  /** 关掉上下文压缩（默认开启）。 */
  noCompact?: boolean
  /**
   * 验证级别：
   *   0 = 仅启用始终开启的本地确定性校验，不调用额外模型
   *   1 = 本地校验 + LLM 最终核验
   *   2 = 兼容旧配置，当前等同 1
   * 默认 0；工具参数、执行状态、文件快照和验证证据检查不受此开关影响。
   */
  verifyLevel?: 0 | 1 | 2
  /** 最终核验最多重试次数，默认 2。 */
  maxVerifyRetries?: number
  /** 关联 full/summary history trace；未提供时由引擎创建 unknown 上下文。 */
  historyTrace?: HistoryTraceContext
  /**
   * Drain prompts entered while this agent is working. Called only at a protocol-safe
   * loop boundary, never between an assistant tool call and its tool results.
   */
  drainQueuedPrompts?: () => string[]
}

export function queuedPromptMessage(prompts: string[]): string {
  const cleaned = prompts.map(prompt => prompt.trim()).filter(Boolean)
  return [
    '用户在你执行当前任务期间追加了以下指令。立即把它们纳入当前任务，并据此调整后续行动；不要等原任务结束后再处理。',
    ...cleaned.map((prompt, index) => `\n[追加指令 ${index + 1}]\n${prompt}`),
  ].join('\n')
}

/**
 * 工具执行器：流式阶段只收集调用，不执行；完整 assistant 响应成功写入历史后，
 * 由 start() 统一启动。这样如果流在中途断开并触发重试，失败尝试里已经出现的
 * write_file / run_bash / send_email 等调用不会留下未记录的副作用，更不会在重试时重复执行。
 */
class DeferredToolExecutor {
  private queued: RawToolCall[] = []
  private running: { call: RawToolCall; promise: Promise<ToolResult> }[] | null = null
  private readonly abortController = new AbortController()
  private detachParentAbort?: () => void

  constructor(
    private exec: (call: RawToolCall, signal: AbortSignal) => Promise<ToolResult>,
    private readonly parentSignal?: AbortSignal,
  ) {}

  /** 收到一个已组装完整的工具调用：只排队，暂不产生副作用。 */
  add(call: RawToolCall): void {
    if (this.running) throw new Error('工具执行已开始，不能继续添加调用')
    this.queued.push(call)
  }

  get size(): number {
    return this.queued.length
  }

  get calls(): readonly RawToolCall[] {
    return this.queued
  }

  /** assistant 响应已成功提交后，统一启动本批工具。 */
  start(): void {
    if (this.running) return
    if (this.parentSignal?.aborted) {
      this.abortController.abort(this.parentSignal.reason)
    } else if (this.parentSignal) {
      const onAbort = () => this.abortController.abort(this.parentSignal!.reason)
      this.parentSignal.addEventListener('abort', onAbort, { once: true })
      this.detachParentAbort = () => this.parentSignal!.removeEventListener('abort', onAbort)
    }
    this.running = this.queued.map(call => ({
      call,
      promise: this.exec(call, this.abortController.signal),
    }))
  }

  /** 按提交顺序逐个等待并产出结果（此时它们多半早已并发跑完）。 */
  async *drain(): AsyncGenerator<{ call: RawToolCall; result: ToolResult }> {
    if (!this.running) throw new Error('工具执行尚未启动')
    for (const r of this.running) {
      yield { call: r.call, result: await r.promise }
    }
  }

  /**
   * 中止仍在运行的工具并等待全部 Promise 收口，防止生成器被关闭或某个步骤抛错后
   * 留下后台 shell / 子 agent 等孤儿任务。可重复调用。
   */
  async cancel(reason: unknown = new DOMException('工具批次已结束', 'AbortError')): Promise<void> {
    this.detachParentAbort?.()
    this.detachParentAbort = undefined
    if (!this.abortController.signal.aborted) this.abortController.abort(reason)
    if (this.running) await Promise.allSettled(this.running.map(r => r.promise))
  }
}

export async function* runAgent(
  history: ChatMessage[],
  deps: EngineDeps,
): AsyncGenerator<AgentEvent, void, unknown> {
  const historyTrace = deps.historyTrace ?? createHistoryTraceContext('unknown', 'unknown')
  try {
    for await (const event of runAgentCore(history, { ...deps, historyTrace })) {
      traceAgentEvent(historyTrace, event)
      yield event
    }
  } catch (error) {
    traceAgentEvent(historyTrace, null, error)
    throw error
  }
}

async function* runAgentCore(
  history: ChatMessage[],
  deps: EngineDeps,
): AsyncGenerator<AgentEvent, void, unknown> {
  const maxSteps = deps.maxSteps ?? 200
  const historyTrace = deps.historyTrace ?? createHistoryTraceContext('unknown', 'unknown')
  const requestTracer = (requestKind: 'agent' | 'compact' | 'verify') =>
    (request: Parameters<typeof traceLlmRequest>[1]) =>
      traceLlmRequest(historyTrace, request, requestKind)
  traceHistory(historyTrace, 'run-agent-start', history)
  const extraNames = new Set((deps.extraTools?.schemas ?? []).map(s => s.function.name))
  const tools = [...TOOL_SCHEMAS, ...(deps.extraTools?.schemas ?? [])]

  const toolCtx: ToolContext = {
    apiKey: deps.apiKey,
    model: deps.model,
    baseURL: deps.baseURL,
    provider: deps.provider,
    signal: deps.signal,
    depth: deps.depth ?? 0,
    onUsage: deps.onUsage,
    readSnapshots: new Map(),
    fileMutationLocks: new Map(),
  }

  // 执行单个工具调用 → 结构化结果。异常转成失败结果回灌，绝不中断循环。
  const execTool = async (call: RawToolCall, signal: AbortSignal): Promise<ToolResult> => {
    const startedAt = Date.now()
    let args: Record<string, any> = {}
    try {
      args = JSON.parse(call.function.arguments || '{}')
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('参数必须是 JSON 对象')
    } catch (error: any) {
      const message = `工具参数不是有效 JSON：${error?.message ?? String(error)}`
      writeToolDebugEvent('tool_input_json_parse_failed', {
        toolName: call.function.name,
        argumentsLength: call.function.arguments?.length ?? 0,
        error: error?.message ?? String(error),
      })
      return {
        ok: false,
        output: `错误: ${message}`,
        error: { code: 'invalid_json', message, userMessage: '工具参数无效' },
        durationMs: Date.now() - startedAt,
      }
    }
    try {
      if (!extraNames.has(call.function.name)) {
        return await runTool(call.function.name, args, { ...toolCtx, signal })
      }
      const output = await deps.extraTools!.run(call.function.name, args, signal)
      const failure = summarizeToolFailure(call.function.name, output)
      return {
        ok: failure === null,
        output,
        error: failure ? { code: 'extra_tool_failed', message: failure } : undefined,
        evidence: { kind: 'legacy' },
        durationMs: Date.now() - startedAt,
      }
    } catch (e: any) {
      const message = e?.message ?? String(e)
      return {
        ok: false,
        output: `错误: ${message}`,
        error: { code: 'exception', message },
        durationMs: Date.now() - startedAt,
      }
    }
  }

  // 恢复闸的状态：输出截断续写次数、本轮是否已做过被动压缩、网络中断已重试次数。
  const MAX_OUTPUT_RECOVERY = 3
  const MAX_NETWORK_RETRY = 3
  const MAX_EMPTY_RESPONSE_RECOVERY = 1
  let outputRecovery = 0
  let emptyResponseRecovery = 0
  let reactiveCompactAttempted = false
  let networkRetry = 0
  const remoteClaudeSession = isRemoteClaudeProvider(deps.provider)
    ? createRemoteClaudeSession()
    : undefined

  // 验证闸：级别 & 最终核验重试次数
  const verifyLevel = deps.verifyLevel ?? 0
  const maxVerifyRetries = deps.maxVerifyRetries ?? 2
  let verifyRetries = 0
  const verifyDeps = {
    apiKey: deps.apiKey,
    model: deps.model,
    baseURL: deps.baseURL,
    provider: deps.provider,
    signal: deps.signal,
    onRequest: requestTracer('verify'),
  }

  // 确定性验证证据：按工具批次排序。同一批工具并发执行，因此同批测试不能证明同批编辑后的状态。
  let toolBatch = 0
  let lastMutationBatch = -1
  let verificationNudged = false
  const changedFiles = new Set<string>()
  const verificationChecks: Array<{
    batch: number
    order: number
    kind: VerificationCheckKind
    ok: boolean
  }> = []
  let evidenceOrder = 0

  for (let step = 0; step < maxSteps; step++) {
    // ⓪ 用户已中断（Esc/Ctrl+C）：立刻收手，别再压缩历史或发起下一次模型调用。
    if (deps.signal?.aborted) throw new DOMException('已中断', 'AbortError')

    // Claude Code drains queued prompts between loop iterations: at this point the
    // previous assistant tool calls (if any) already have all matching tool results.
    // Injecting here steers the very next model request without corrupting function-
    // calling message order or waiting for the whole agent run to finish.
    const queuedPrompts = deps.drainQueuedPrompts?.().map(prompt => prompt.trim()).filter(Boolean) ?? []
    if (queuedPrompts.length) {
      history.push({ role: 'user', content: queuedPromptMessage(queuedPrompts) })
      traceHistory(historyTrace, 'after-queued-prompts', history, {
        step,
        note: `count=${queuedPrompts.length}`,
      })
    }

    // ① 每轮开头按需压缩历史（就地 splice，保持调用方持有的引用有效）。
    if (!deps.noCompact) {
      const historyLengthBeforeCompact = history.length
      try {
        const compacted = await compactInPlace(history, { ...deps, onRequest: requestTracer('compact') })
        if (compacted) {
          if (remoteClaudeSession) resetRemoteClaudeSession(remoteClaudeSession)
          traceHistory(historyTrace, 'after-compact', history, {
            step,
            note: `historyLengthBefore=${historyLengthBeforeCompact}`,
          })
        }
      } catch {
        /* 压缩失败不影响主流程 */
      }
    }

    // ② 流式调用模型。工具调用在此阶段只排队，不能提前产生副作用。
    traceHistory(historyTrace, 'before-llm-request', history, { step })
    const executor = new DeferredToolExecutor(execTool, deps.signal)
    const stream = streamCompletion(history, {
      apiKey: deps.apiKey,
      model: deps.model,
      baseURL: deps.baseURL,
      provider: deps.provider,
      signal: deps.signal,
      tools,
      onRequest: requestTracer('agent'),
      onUsage: deps.onUsage,
      remoteClaudeSession,
    })

    // channel 不消费 delta，只消费 text，所以这里按「工具调用分隔出的文本段」缓存。
    // 每次 flush 后必须清空，才能正确处理 text → tool → text → tool → text 这类交错输出。
    let textSegment = ''
    const flushText = function* (): Generator<AgentEvent> {
      if (!textSegment) return
      const content = textSegment
      textSegment = ''
      yield { type: 'text', content } as AgentEvent
    }

    let completion: Completion
    try {
      let res = await stream.next()
      while (!res.done) {
        const part = res.value
        if (part.type === 'text') {
          textSegment += part.delta
          yield { type: 'delta', content: part.delta }
        } else if (part.type === 'thinking') {
          yield { type: 'thinking', content: part.delta }
        } else if (part.type === 'model') {
          yield { type: 'model', phase: part.phase, at: Date.now() }
        } else if (part.type === 'tool') {
          // 工具调用先于其后内容到达时，先把已说的文本作为一段 text 收口（保证 channel 端顺序正确）。
          yield* flushText()
          executor.add(part.call)
        } else {
          // Remote Claude Code 内部执行的 WebSearch/WebFetch 不进入本地工具队列，
          // 但其结构化生命周期仍实时透传给 UI，避免复杂任务长期只显示“思考中”。
          yield* flushText()
          yield {
            type: 'tool',
            name: part.progress.name,
            phase: part.progress.phase,
            summary: part.progress.summary,
            detail: part.progress.detail,
            callId: part.progress.callId,
            ...(part.progress.callId
              ? { batchId: part.progress.callId, batchSize: 1 }
              : {}),
          }
        }
        res = await stream.next()
      }
      completion = res.value
    } catch (e: any) {
      // 被动恢复（reactive compact）：API 报「上下文超长」→ 强制压缩一次后重试本轮。
      // 只试一次（reactiveCompactAttempted 守门），压完还超就放行报错，避免死循环。
      if (!deps.noCompact && !reactiveCompactAttempted && isContextOverflow(e)) {
        reactiveCompactAttempted = true
        const did = await compactInPlace(
          history,
          { ...deps, onRequest: requestTracer('compact') },
          { force: true },
        ).catch(() => false)
        if (did) {
          if (remoteClaudeSession) resetRemoteClaudeSession(remoteClaudeSession)
          traceHistory(historyTrace, 'after-reactive-compact', history, { step })
          yield { type: 'tool', name: 'system', phase: 'info', summary: '⚠ 上下文超长，已自动压缩后重试' }
          continue
        }
      }
      if (remoteClaudeSession && e?.code === 'REMOTE_SESSION_UNSUPPORTED') {
        disableRemoteClaudeSession(remoteClaudeSession)
        yield {
          type: 'tool',
          name: 'system',
          phase: 'info',
          summary: '⚠ Remote gateway 尚不支持 session resume，已回退兼容模式',
        }
        continue
      }
      if (
        remoteClaudeSession &&
        networkRetry < MAX_NETWORK_RETRY &&
        /^(REMOTE_SESSION_BUSY|REMOTE_SESSION_STALE|REMOTE_SESSION_INVALID|REMOTE_SESSION_UNAVAILABLE)$/.test(
          String(e?.code ?? ''),
        )
      ) {
        networkRetry++
        resetRemoteClaudeSession(remoteClaudeSession)
        yield {
          type: 'tool',
          name: 'system',
          phase: 'info',
          summary: `⚠ Remote session 状态失效，重建后重试（${networkRetry}/${MAX_NETWORK_RETRY}）…`,
        }
        await sleep(500 * networkRetry)
        continue
      }
      // 网络类瞬时错误（长连接被服务端/代理中途掐断，Node fetch 典型报 "terminated"，
      // 也可能是 socket hang up / ECONNRESET 等）：退避后原样重试本轮请求，
      // 不把这类对用户毫无意义的英文底层错误直接甩出去。
      if (!deps.signal?.aborted && networkRetry < MAX_NETWORK_RETRY && isTransientNetworkError(e)) {
        networkRetry++
        if (remoteClaudeSession) resetRemoteClaudeSession(remoteClaudeSession)
        yield {
          type: 'tool',
          name: 'system',
          phase: 'info',
          summary: `⚠ 网络连接中断，重试中（${networkRetry}/${MAX_NETWORK_RETRY}）…`,
        }
        await sleep(500 * networkRetry)
        continue
      }
      throw e // 不可恢复（含用户 abort）→ 抛给上层显示/反馈
    }

    const { content, toolCalls, finishReason, remoteContext } = completion
    reactiveCompactAttempted = false // 本轮模型成功应答 → 重置被动压缩闸
    networkRetry = 0 // 本轮模型成功应答 → 重置网络重试闸

    // 收口最后一个文本段；前面遇到工具时已产出的段不会重复。
    yield* flushText()

    const assistantContent = remoteContext
      ? `${content || ''}\n\n<remote_web_research>\n${remoteContext}\n</remote_web_research>`.trim()
      : content || ''
    // 纯空响应不能进入历史。否则恢复请求会携带 role=assistant/content=""
    // 的非法消息，GLM 等严格兼容接口会直接返回 HTTP 400，导致自动重试反而必然失败。
    // 带 tool_calls 的空正文则是 OpenAI function-calling 的合法格式，必须保留。
    if (assistantContent.trim() || toolCalls.length) {
      history.push({
        role: 'assistant',
        content: assistantContent,
        tool_calls: toolCalls.length ? toolCalls : undefined,
      })
      traceHistory(historyTrace, 'after-assistant-push', history, { step })
    } else {
      traceHistory(historyTrace, 'skip-empty-assistant', history, { step })
    }

    if (executor.size) {
      // assistant 响应已经完整收到并提交进历史，此时才允许工具产生副作用。
      // 若上面的流式请求中途失败，代码不会到达这里，队列会随本轮 executor 一起丢弃。
      executor.start()
      const currentToolBatch = ++toolBatch
      const batchId = `tool-batch-${currentToolBatch}`
      for (const call of executor.calls) {
        yield {
          type: 'tool',
          name: call.function.name,
          callId: call.id,
          batchId,
          batchSize: executor.size,
          phase: 'start',
          summary: describeToolCall(call.function.name, safeArgs(call.function.arguments)),
          detail: describeToolDetail(call.function.name, safeArgs(call.function.arguments)),
        }
      }
      try {
        // ③ 回收并发执行的工具结果（按调用顺序回灌，满足 OpenAI 的配对要求）。
        for await (const { call, result } of executor.drain()) {
          const modelResult = formatToolResult(result)
          history.push({ role: 'tool', tool_call_id: call.id, content: modelResult })
          traceHistory(historyTrace, 'after-tool-result-push', history, {
            step,
            toolName: call.function.name,
            toolCallId: call.id,
          })
          // 工具结果只回灌给模型，用户看不到；把成功和失败都冒泡，形成完整的开始→结果闭环。
          if (result.ok) {
            yield {
              type: 'tool',
              name: call.function.name,
              callId: call.id,
              batchId,
              batchSize: executor.size,
              phase: 'success',
              summary: describeToolSuccess(call.function.name, safeArgs(call.function.arguments), result),
              detail: result.output,
            }
          } else {
            yield {
              type: 'tool',
              name: call.function.name,
              callId: call.id,
              batchId,
              batchSize: executor.size,
              phase: 'failure',
              summary: describeToolFailure(call.function.name, safeArgs(call.function.arguments), result),
              detail: result.output,
            }
          }

          const evidence = result.evidence
          if (result.ok && evidence?.path && (evidence.kind === 'file_write' || evidence.kind === 'file_edit')) {
            changedFiles.add(evidence.path)
            lastMutationBatch = currentToolBatch
          }
          if (evidence?.checkKind) {
            verificationChecks.push({
              batch: currentToolBatch,
              order: ++evidenceOrder,
              kind: evidence.checkKind,
              ok: result.ok,
            })
          }
        }
      } finally {
        // for-await 消费方提前 return、用户中断、验证抛错等所有出口都会走这里。
        await executor.cancel()
      }
      continue
    }

    // 无工具调用：本应结束；但若回复是被「输出长度上限」截断的（finish_reason==='length'），
    // 注入续写提示再来一轮，把没说完的话接着说完。
    if (finishReason === 'length') {
      if (outputRecovery < MAX_OUTPUT_RECOVERY) {
        outputRecovery++
        history.push({
          role: 'user',
          content:
            '（系统提示）你上一条回复因达到输出长度上限被截断。请直接从断点继续，' +
            '不要重复已经输出的内容，也不要道歉或重述；剩余内容较多时可分小段输出。',
        })
        yield { type: 'tool', name: 'system', phase: 'info', summary: `↻ 输出被截断，自动续写（第 ${outputRecovery} 次）` }
        continue
      }
      throw new AgentTerminationError(
        'output_recovery_exhausted',
        `模型连续 ${MAX_OUTPUT_RECOVERY} 次达到输出长度上限，无法确认回答完整`,
        finishReason,
      )
    }

    if (finishReason === 'content_filter') {
      throw new AgentTerminationError(
        'content_filtered',
        '模型响应被内容过滤器截断，无法确认结果完整',
        finishReason,
      )
    }

    if (!isNormalFinishReason(finishReason)) {
      throw new AgentTerminationError(
        'unexpected_finish_reason',
        `模型以未支持的状态结束：${finishReason}`,
        finishReason,
      )
    }

    // 没有工具调用时，只有明确的正常停止（或部分兼容服务商缺失 finish_reason 但确有正文）才能结束。
    // 空响应先做一次有界恢复；仍为空则报错，绝不能静默当成成功。
    if (!content.trim()) {
      if (emptyResponseRecovery < MAX_EMPTY_RESPONSE_RECOVERY) {
        emptyResponseRecovery++
        history.push({
          role: 'user',
          content:
            '（系统提示）你上一条响应没有正文也没有工具调用。请重新完成当前任务；' +
            '如果无法完成，请明确说明原因，不要返回空响应。',
        })
        yield { type: 'tool', name: 'system', phase: 'info', summary: '↻ 模型返回空响应，自动重试（1/1）' }
        continue
      }
      throw new AgentTerminationError(
        'empty_response',
        '模型连续返回空响应，未产生可交付结果',
        finishReason,
      )
    }

    // 本地证据闸：只对代码/高风险修改生效。没有证据时提醒主 Agent 自己选择相关测试，
    // 不追加一次“裁判模型”请求；最多提醒一次，避免没有测试设施的项目陷入循环。
    const requirement = verificationRequirementForFiles(changedFiles)
    if (!verificationNudged && (requirement === 'standard' || requirement === 'strict')) {
      const { hasSuccessfulEvidence, unresolvedFailures } = evaluateVerificationEvidence(
        verificationChecks,
        lastMutationBatch,
      )
      if (!hasSuccessfulEvidence || unresolvedFailures > 0) {
        verificationNudged = true
        const prompt = verificationNudge(requirement, unresolvedFailures)
        history.push({ role: 'system', content: prompt })
        yield {
          type: 'tool',
          name: 'verify',
          phase: 'info',
          summary: requirement === 'strict' ? '↻ 高风险修改缺少验证证据，继续核验' : '↻ 代码修改缺少验证证据，继续核验',
        }
        continue
      }
    }

    // #1 级验证：最终核验 — 对比原始需求与最终交付，不通过则打回修正
    if (verifyLevel >= 1 && verifyRetries < maxVerifyRetries) {
      yield { type: 'tool', name: 'verify', phase: 'info', summary: '🔍 正在核验最终结果…' }
      const v: VerifyResult = await verifyFinalResult(history, verifyDeps)
      if (!v.pass) {
        verifyRetries++
        const issueList = v.issues.length ? v.issues.map((s, i) => `${i + 1}. ${s}`).join('\n') : v.suggestion
        history.push({
          role: 'user',
          content:
            `【核验反馈】你的回答可能未完全满足原始需求（得分 ${v.score}/100）。\n` +
            `问题：\n${issueList}\n\n` +
            `建议：${v.suggestion}\n\n` +
            `请针对上述问题修正后重新给出最终结果。如果认为自己的答案是对的，也可以说明理由。`,
        })
        yield {
          type: 'tool',
          name: 'verify',
          phase: 'info',
          summary: `↻ 核验不通过（${v.score}/100），第 ${verifyRetries} 次修正`,
        }
        continue
      }
      yield { type: 'tool', name: 'verify', phase: 'info', summary: `✓ 核验通过（${v.score}/100）` }
    }

    traceHistory(historyTrace, 'run-agent-complete', history, { step })
    return // 正常完成
  }

  // 没有 return 而是走到这里 = 连跑 maxSteps 步仍未收尾。不硬停，问一句让用户决定。
  // 历史此刻停在「工具结果已回灌」的干净状态，用户回复「继续」即作为新一轮自然接着跑。
  traceHistory(historyTrace, 'run-agent-limit', history, { note: `maxSteps=${maxSteps}` })
  yield { type: 'limit', steps: maxSteps }
}

function describeToolDetail(name: string, args: Record<string, any>): string {
  if (name === 'run_bash') return String(args.command ?? '')
  try {
    return JSON.stringify(args, null, 2)
  } catch {
    return String(args)
  }
}

/**
 * 判断一个错误是不是「上下文/提示超长」类（用于触发被动压缩重试）。
 * 各家服务商措辞五花八门（比如某些渠道报 "total tokens of image and text exceed
 * max message tokens"，不含 "context"/"too long" 等词），只认固定几个短语会漏判，
 * 漏判的后果是直接把错误抛给用户、白白中断本轮——所以额外用「xxx token(s) 附近出现
 * exceed/too many」这种更宽的模式兜底。
 */
function isContextOverflow(e: any): boolean {
  const msg = String(e?.message ?? e).toLowerCase()
  if (
    /maximum context length|context[_ ]length|context window|prompt is too long|too long|reduce the length|exceeds? the maximum|http 413|payload too large|request entity too large|too many tokens/.test(
      msg,
    )
  ) {
    return true
  }
  // token 与 exceed/超出 类词汇彼此邻近出现，视为「token 超限」的兜底判定。
  return /token[a-z]*[^.]{0,40}(exceed|too many|超出|超限)|(exceed|超出|超限)[^.]{0,40}token/.test(msg)
}

/**
 * 判断一个错误是不是「网络/连接类瞬时故障」（可安全重试）：
 * 长连接被服务端/代理中途掐断时，Node 内置 fetch（undici）典型报 TypeError('terminated')，
 * 其 cause 常是 SocketError('other side closed')；此外 socket hang up / ECONNRESET /
 * ETIMEDOUT 等也归为同类——都不是模型或参数的问题，重试大概率能恢复。
 */
function isTransientNetworkError(e: any): boolean {
  const code = String(e?.cause?.code ?? e?.code ?? '')
  if (/^(ECONNRESET|ETIMEDOUT|EPIPE|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT)$/.test(
      code,
    )
  ) {
    return true
  }
  const msg = String(e?.message ?? e).toLowerCase() + ' ' + String(e?.cause?.message ?? '').toLowerCase()
  return /terminated|fetch failed|socket hang up|other side closed|premature close|network error|econnreset|etimedout|timeout|timed out|gateway timeout|http 50[24]/.test(
    msg,
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function safeArgs(raw: string): Record<string, any> {
  try {
    return JSON.parse(raw || '{}')
  } catch {
    return {}
  }
}

/**
 * OpenAI 通常返回 stop；Anthropic 的 end_turn 已在 llm.ts 映射成 stop，
 * stop_sequence 则同样表示正常结束。部分 OpenAI 兼容服务不返回 finish_reason，
 * 只要已有非空正文也允许结束，以免破坏兼容性。
 */
function isNormalFinishReason(reason?: string): boolean {
  return reason == null || reason === 'stop' || reason === 'stop_sequence'
}
