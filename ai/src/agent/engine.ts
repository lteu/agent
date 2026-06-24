// Agent 引擎：与 UI 无关的「模型↔工具反复调用」循环。
// 终端界面和 QQ/微信 channel 共用它——谁来消费这个事件流都行。
//
// 用法：
//   for await (const ev of runAgent(history, deps)) {
//     if (ev.type === 'delta') ...  // 流式文本增量（终端实时打字机；channel 可忽略）
//     if (ev.type === 'text')  ...  // 一整段助手文本（channel/日志按段消费）
//     if (ev.type === 'tool')  ...  // 正在调用某个本地工具（用于显示进度）
//   }
// history 会被原地追加（assistant / tool 消息），方便跨轮累积上下文。
//
// 本轮相较最初的「非流式 for 循环」升级了三处（对标 Claude Code）：
//   1. 模型调用改为流式 streamCompletion，文本边出边产出 delta；
//   2. StreamingToolExecutor —— 工具在「模型还在输出」时就并发开跑；
//   3. 每轮开头按需做上下文压缩 compactInPlace。

import { streamCompletion, type ChatMessage, type RawToolCall, type Completion } from '../llm.js'
import { TOOL_SCHEMAS, runTool, describeToolCall, type ToolContext } from '../tools.js'
import { compactInPlace, type CompactDeps } from './compact.js'

export type AgentEvent =
  // 流式文本增量：给终端做实时显示；channel（QQ/微信）按段发送，忽略它。
  | { type: 'delta'; content: string }
  // 一整段助手文本（一轮里 content 的最终态）：channel/日志按段消费。
  | { type: 'text'; content: string }
  | { type: 'tool'; name: string; summary: string }

/** 由具体 channel 注入的额外工具（如 QQ 的 send_image），与内置工具合并提供给模型。 */
export type ExtraTools = {
  schemas: readonly { function: { name: string } }[]
  run: (name: string, args: Record<string, any>) => Promise<string> | string
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
}

/**
 * 流式工具执行器：拿到一个工具调用就「立刻开跑」（不 await），把进行中的 Promise 记下来；
 * 等本轮模型流结束后再 drain()，按提交顺序回收结果。
 * 效果 = 模型还在吐后续 token / 后续工具调用时，先到的工具已经在并发执行了。
 */
class StreamingToolExecutor {
  private running: { call: RawToolCall; promise: Promise<string> }[] = []
  constructor(private exec: (call: RawToolCall) => Promise<string>) {}

  /** 收到一个已组装完整的工具调用：立即启动执行。 */
  add(call: RawToolCall): void {
    this.running.push({ call, promise: this.exec(call) })
  }

  get size(): number {
    return this.running.length
  }

  /** 按提交顺序逐个等待并产出结果（此时它们多半早已并发跑完）。 */
  async *drain(): AsyncGenerator<{ call: RawToolCall; result: string }> {
    for (const r of this.running) {
      yield { call: r.call, result: await r.promise }
    }
  }
}

export async function* runAgent(
  history: ChatMessage[],
  deps: EngineDeps,
): AsyncGenerator<AgentEvent, void, unknown> {
  const maxSteps = deps.maxSteps ?? 25
  const extraNames = new Set((deps.extraTools?.schemas ?? []).map(s => s.function.name))
  const tools = [...TOOL_SCHEMAS, ...(deps.extraTools?.schemas ?? [])]

  const toolCtx: ToolContext = {
    apiKey: deps.apiKey,
    model: deps.model,
    baseURL: deps.baseURL,
    provider: deps.provider,
    signal: deps.signal,
    depth: deps.depth ?? 0,
  }

  // 执行单个工具调用 → 纯文本结果（异常转成字符串回灌，绝不中断循环）。
  const execTool = async (call: RawToolCall): Promise<string> => {
    let args: Record<string, any> = {}
    try {
      args = JSON.parse(call.function.arguments || '{}')
    } catch {
      /* 参数解析失败时按空对象处理 */
    }
    try {
      return extraNames.has(call.function.name)
        ? await deps.extraTools!.run(call.function.name, args)
        : await runTool(call.function.name, args, toolCtx)
    } catch (e: any) {
      return '错误: ' + (e?.message ?? String(e))
    }
  }

  // 恢复闸的状态：输出截断续写次数、本轮是否已做过被动压缩。
  const MAX_OUTPUT_RECOVERY = 3
  let outputRecovery = 0
  let reactiveCompactAttempted = false

  for (let step = 0; step < maxSteps; step++) {
    // ① 每轮开头按需压缩历史（就地 splice，保持调用方持有的引用有效）。
    if (!deps.noCompact) {
      try {
        await compactInPlace(history, deps)
      } catch {
        /* 压缩失败不影响主流程 */
      }
    }

    // ② 流式调用模型，同时用 StreamingToolExecutor 让工具「边流边跑」。
    const executor = new StreamingToolExecutor(execTool)
    const stream = streamCompletion(history, {
      apiKey: deps.apiKey,
      model: deps.model,
      baseURL: deps.baseURL,
      provider: deps.provider,
      signal: deps.signal,
      tools,
    })

    let textBuf = '' // 累积本轮文本
    let textFlushed = false // 是否已把累积文本作为一段 text 产出
    const flushText = function* (): Generator<AgentEvent> {
      if (textBuf && !textFlushed) {
        textFlushed = true
        yield { type: 'text', content: textBuf } as AgentEvent
      }
    }

    let completion: Completion
    try {
      let res = await stream.next()
      while (!res.done) {
        const part = res.value
        if (part.type === 'text') {
          textBuf += part.delta
          yield { type: 'delta', content: part.delta }
        } else {
          // 工具调用先于其后内容到达时，先把已说的文本作为一段 text 收口（保证 channel 端顺序正确）。
          yield* flushText()
          const args = safeArgs(part.call.function.arguments)
          yield { type: 'tool', name: part.call.function.name, summary: describeToolCall(part.call.function.name, args) }
          executor.add(part.call) // ← 立即并发开跑，不等流结束
        }
        res = await stream.next()
      }
      completion = res.value
    } catch (e: any) {
      // 被动恢复（reactive compact）：API 报「上下文超长」→ 强制压缩一次后重试本轮。
      // 只试一次（reactiveCompactAttempted 守门），压完还超就放行报错，避免死循环。
      if (!deps.noCompact && !reactiveCompactAttempted && isContextOverflow(e)) {
        reactiveCompactAttempted = true
        const did = await compactInPlace(history, deps, { force: true }).catch(() => false)
        if (did) {
          yield { type: 'tool', name: 'system', summary: '⚠ 上下文超长，已自动压缩后重试' }
          continue
        }
      }
      throw e // 不可恢复（含用户 abort）→ 抛给上层显示/反馈
    }

    const { content, toolCalls, finishReason } = completion
    reactiveCompactAttempted = false // 本轮模型成功应答 → 重置被动压缩闸

    // 收口：把整轮文本作为一段 text 产出（若前面因工具已收口过则不重复）。
    yield* flushText()

    history.push({
      role: 'assistant',
      content: content || '',
      tool_calls: toolCalls.length ? toolCalls : undefined,
    })

    if (executor.size) {
      // ③ 回收并发执行的工具结果（按调用顺序回灌，满足 OpenAI 的配对要求）。
      for await (const { call, result } of executor.drain()) {
        history.push({ role: 'tool', tool_call_id: call.id, content: result })
      }
      continue
    }

    // 无工具调用：本应结束；但若回复是被「输出长度上限」截断的（finish_reason==='length'），
    // 注入续写提示再来一轮，把没说完的话接着说完。
    if (finishReason === 'length' && outputRecovery < MAX_OUTPUT_RECOVERY) {
      outputRecovery++
      history.push({
        role: 'user',
        content:
          '（系统提示）你上一条回复因达到输出长度上限被截断。请直接从断点继续，' +
          '不要重复已经输出的内容，也不要道歉或重述；剩余内容较多时可分小段输出。',
      })
      yield { type: 'tool', name: 'system', summary: `↻ 输出被截断，自动续写（第 ${outputRecovery} 次）` }
      continue
    }

    return // 正常完成
  }

  yield { type: 'text', content: `[已达最大步数 ${maxSteps}，停止]` }
}

/** 判断一个错误是不是「上下文/提示超长」类（用于触发被动压缩重试）。 */
function isContextOverflow(e: any): boolean {
  const msg = String(e?.message ?? e).toLowerCase()
  return /maximum context length|context[_ ]length|context window|prompt is too long|too long|reduce the length|exceeds? the maximum|http 413/.test(
    msg,
  )
}

function safeArgs(raw: string): Record<string, any> {
  try {
    return JSON.parse(raw || '{}')
  } catch {
    return {}
  }
}
