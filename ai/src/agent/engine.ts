// Agent 引擎：与 UI 无关的「模型↔工具反复调用」循环。
// 终端界面和 QQ channel 共用它——谁来消费这个事件流都行。
//
// 用法：
//   for await (const ev of runAgent(history, deps)) {
//     if (ev.type === 'text') ...   // 助手要对用户说的话
//     if (ev.type === 'tool') ...   // 正在调用某个本地工具（用于显示进度）
//   }
// history 会被原地追加（assistant / tool 消息），方便跨轮累积上下文。

import { chatComplete, type ChatMessage } from '../llm.js'
import { TOOL_SCHEMAS, runTool, describeToolCall } from '../tools.js'

export type AgentEvent =
  | { type: 'text'; content: string }
  | { type: 'tool'; name: string; summary: string }

/** 由具体 channel 注入的额外工具（如 QQ 的 send_image），与内置工具合并提供给模型。 */
export type ExtraTools = {
  schemas: readonly { function: { name: string } }[]
  run: (name: string, args: Record<string, any>) => Promise<string> | string
}

export type EngineDeps = {
  apiKey: string
  model: string
  baseURL: string
  /** 服务商显示名，仅用于报错信息。 */
  provider?: string
  signal?: AbortSignal
  /** 防止工具循环失控的最大步数，默认 25。 */
  maxSteps?: number
  /** channel 专属工具：与内置 TOOL_SCHEMAS 合并，执行时优先用它。 */
  extraTools?: ExtraTools
  /** 子 agent 递归深度，由 run_agent 工具派生时自增，用于限制嵌套层数。 */
  depth?: number
}

export async function* runAgent(
  history: ChatMessage[],
  deps: EngineDeps,
): AsyncGenerator<AgentEvent, void, unknown> {
  const maxSteps = deps.maxSteps ?? 25
  const extraNames = new Set((deps.extraTools?.schemas ?? []).map(s => s.function.name))
  const tools = [...TOOL_SCHEMAS, ...(deps.extraTools?.schemas ?? [])]

  for (let step = 0; step < maxSteps; step++) {
    const { content, toolCalls } = await chatComplete(history, {
      apiKey: deps.apiKey,
      model: deps.model,
      baseURL: deps.baseURL,
      provider: deps.provider,
      signal: deps.signal,
      tools,
    })

    history.push({
      role: 'assistant',
      content: content || '',
      tool_calls: toolCalls.length ? toolCalls : undefined,
    })
    if (content) yield { type: 'text', content }

    if (!toolCalls.length) return // 没有工具调用 = 最终答复

    for (const tc of toolCalls) {
      let args: Record<string, any> = {}
      try {
        args = JSON.parse(tc.function.arguments || '{}')
      } catch {
        /* 参数解析失败时按空对象处理 */
      }
      yield { type: 'tool', name: tc.function.name, summary: describeToolCall(tc.function.name, args) }
      let result: string
      try {
        result = extraNames.has(tc.function.name)
          ? await deps.extraTools!.run(tc.function.name, args)
          : await runTool(tc.function.name, args, {
              apiKey: deps.apiKey,
              model: deps.model,
              baseURL: deps.baseURL,
              provider: deps.provider,
              signal: deps.signal,
              depth: deps.depth ?? 0,
            })
      } catch (e: any) {
        result = '错误: ' + (e?.message ?? String(e))
      }
      history.push({ role: 'tool', tool_call_id: tc.id, content: result })
    }
  }

  yield { type: 'text', content: `[已达最大步数 ${maxSteps}，停止]` }
}
