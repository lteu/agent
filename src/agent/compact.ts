// 上下文压缩（autocompact）：长对话不能无限增长，否则迟早撑爆模型上下文窗口。
// 思路对标 Claude Code 的 autocompact / OpenClaw 的 compact：
// 当历史的「估算 token」超过阈值时，调用一次模型，把较旧的那段历史总结成一段摘要，
// 用这段摘要原地替换掉原文，只完整保留 system 提示与最近若干条消息。
//
// 与 SessionStore.trim() 的区别：trim 是「直接丢弃」最旧的消息（无损但会丢上下文），
// 压缩是「有损总结」——省 token 的同时尽量保住关键事实/决定/未完成事项。

import { chatComplete, type ChatMessage } from '../llm.js'

export type CompactDeps = {
  apiKey: string
  model: string
  baseURL: string
  provider?: string
  signal?: AbortSignal
  /** 触发压缩的估算 token 阈值，默认 40000。 */
  compactThreshold?: number
  /** 压缩时保留的最近消息条数（不含 system），默认 12。 */
  keepRecent?: number
}

/** 粗略估算整段历史的 token 数（CJK/英文混合，按 ~3 字符/token 取整，够用即可）。 */
export function estimateTokens(history: ChatMessage[]): number {
  let chars = 0
  for (const m of history) {
    chars += m.content?.length ?? 0
    for (const tc of m.tool_calls ?? []) {
      chars += tc.function.name.length + tc.function.arguments.length
    }
  }
  return Math.ceil(chars / 3)
}

/** 把一条消息渲染成给「摘要模型」看的纯文本行。 */
function renderForSummary(m: ChatMessage): string {
  if (m.role === 'tool') return `[工具结果] ${m.content ?? ''}`
  const calls = m.tool_calls?.length
    ? ' [调用工具: ' + m.tool_calls.map(t => t.function.name).join(', ') + ']'
    : ''
  return `[${m.role}] ${m.content ?? ''}${calls}`
}

/**
 * 必要时就地压缩历史；返回是否发生了压缩。
 * - 不超阈值：原样返回 false。
 * - 超阈值：调用模型把 [1, cut) 段总结为一条 user 摘要，splice 替换；保留 system 与最近 keepRecent 条。
 *   cut 会对齐到 user 边界，避免把 assistant(tool_calls) 与其 tool 结果拆散。
 * 失败时（模型报错等）静默返回 false，让上层继续用原历史，绝不因压缩失败而中断主流程。
 */
export async function compactInPlace(
  history: ChatMessage[],
  deps: CompactDeps,
  opts: { force?: boolean } = {},
): Promise<boolean> {
  // force=true：不看阈值，直接尝试压缩（用于「API 报上下文超长」后的被动补救）。
  const threshold = deps.compactThreshold ?? 40000
  if (!opts.force && estimateTokens(history) < threshold) return false

  const keepRecent = deps.keepRecent ?? 12
  const hasSystem = history[0]?.role === 'system'
  const base = hasSystem ? 1 : 0

  // 目标 cut：保留最后 keepRecent 条；再向后挪到下一个 user 边界，保证不切断工具配对。
  let cut = Math.max(base, history.length - keepRecent)
  while (cut < history.length && history[cut].role !== 'user') cut++
  // 可压缩的旧消息太少（< 4 条）就不折腾，留给 trim/下一轮。
  if (cut - base < 4 || cut >= history.length) return false

  const oldText = history
    .slice(base, cut)
    .map(renderForSummary)
    .join('\n')
    .slice(0, 60000) // 摘要输入本身也限个量，避免压缩请求过大

  let summary: string
  try {
    const { content } = await chatComplete(
      [
        {
          role: 'system',
          content:
            '你是对话历史压缩器。把用户给出的一段较早的对话历史压缩成简洁中文摘要，' +
            '务必保留：关键事实与结论、已做出的决定、涉及的文件/路径及其改动、仍未完成的待办。' +
            '丢弃寒暄与冗余。只输出摘要正文，不要前言。',
        },
        { role: 'user', content: oldText },
      ],
      {
        apiKey: deps.apiKey,
        model: deps.model,
        baseURL: deps.baseURL,
        provider: deps.provider,
        signal: deps.signal,
      },
    )
    summary = content.trim()
  } catch {
    return false
  }
  if (!summary) return false

  history.splice(base, cut - base, {
    role: 'user',
    content: '【以下为更早对话的自动压缩摘要】\n' + summary,
  })
  return true
}
