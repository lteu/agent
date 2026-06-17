// Agent 引擎：与 UI 无关的「模型↔工具反复调用」循环。
// 终端界面和 QQ channel 共用它——谁来消费这个事件流都行。
//
// 用法：
//   for await (const ev of runAgent(history, deps)) {
//     if (ev.type === 'text') ...   // 助手要对用户说的话
//     if (ev.type === 'tool') ...   // 正在调用某个本地工具（用于显示进度）
//   }
// history 会被原地追加（assistant / tool 消息），方便跨轮累积上下文。

import { chatComplete, type ChatMessage } from '../deepseek.js'
import { TOOL_SCHEMAS, runTool, describeToolCall } from '../tools.js'

export type AgentEvent =
  | { type: 'text'; content: string }
  | { type: 'tool'; name: string; summary: string }

export type EngineDeps = {
  apiKey: string
  model: string
  baseURL: string
  signal?: AbortSignal
  /** 防止工具循环失控的最大步数，默认 25。 */
  maxSteps?: number
}

export async function* runAgent(
  history: ChatMessage[],
  deps: EngineDeps,
): AsyncGenerator<AgentEvent, void, unknown> {
  const maxSteps = deps.maxSteps ?? 25

  for (let step = 0; step < maxSteps; step++) {
    const { content, toolCalls } = await chatComplete(history, {
      apiKey: deps.apiKey,
      model: deps.model,
      baseURL: deps.baseURL,
      signal: deps.signal,
      tools: TOOL_SCHEMAS,
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
        result = await runTool(tc.function.name, args)
      } catch (e: any) {
        result = '错误: ' + (e?.message ?? String(e))
      }
      history.push({ role: 'tool', tool_call_id: tc.id, content: result })
    }
  }

  yield { type: 'text', content: `[已达最大步数 ${maxSteps}，停止]` }
}
