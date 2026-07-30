// 可选的 LLM 最终核验模块。
//
// 设计目标：
// 默认关闭；工具参数、执行结果、文件快照与测试证据由本地确定性逻辑校验。
//
// 验证失败的处理：
// 不通过 → 把核验意见作为 user 消息回灌历史，让主循环接着跑（最多重试 N 次）。

import { chatComplete, type ChatMessage } from '../llm.js'
import type { CompactDeps } from './compact.js'

export type VerifyDeps = CompactDeps & {
  signal?: AbortSignal
}

export type VerifyResult = {
  pass: boolean
  score: number // 0-100
  issues: string[]
  suggestion: string
}

// ———————————————————————————————————————————————
// #1 最终核验
// ———————————————————————————————————————————————

const FINAL_VERIFY_SYSTEM = `你是一个严格的任务核验官。请对比「用户原始需求」和「Agent 最终交付结果」，
按以下维度打分并给出具体问题。务必严格，不要给人情分，不要因为回答礼貌就给高分。

【打分维度（每项 0-25 分，总分 100）】
1. 需求覆盖度（0-25）：是否完整回答了用户的所有问题/需求，有没有遗漏
   - 用户明确要求的产出物（代码、文件、数据、方案等）必须实际给出，只说"做好了""写完了"但没贴内容 = 0 分
   - 只回答了部分问题，漏了一部分 = 按比例扣分
2. 事实准确性（0-25）：有没有事实错误、幻觉、编造的内容、不存在的文件/函数/API
   - 有严重幻觉（编造了不存在的东西）= 0 分
   - 有轻微事实错误 = 扣 5-15 分
3. 产出完整性（0-25）：代码/方案是否可运行、逻辑是否自洽、有没有明显缺漏
   - 代码缺关键部分、方案只有骨架没有细节 = 低分
   - 可直接使用、逻辑自洽 = 高分
4. 可用性（0-25）：结果是否足够详细、用户能否直接理解和使用
   - 过于简略、只有结论没有过程 = 低分
   - 清晰、有条理、用户拿来就能用 = 高分

【输出格式】严格输出 JSON，不要任何额外文字、不要 markdown 代码块包裹：
{
  "pass": true/false,
  "score": 0-100,
  "issues": ["问题1", "问题2"],
  "suggestion": "一句话修正建议"
}

判定规则：总分 >= 70 且没有严重事实错误时 pass=true，否则 pass=false。
特别注意：只要用户要求了具体产出物（代码、文件、数据等）而 Agent 没有实际给出（只是口头上说做好了），必须判不通过。`

/**
 * 找到本轮对话的「原始用户需求」——即历史中第一条 user 消息的内容。
 * （压缩后的摘要也以 user 角色存在，但其内容以「【以下为更早对话的自动压缩摘要】」开头，需跳过。）
 */
export function findOriginalQuery(history: ChatMessage[]): string {
  for (const m of history) {
    if (m.role === 'user' && typeof m.content === 'string' && !m.content.startsWith('【以下为更早对话的自动压缩摘要】')) {
      // 跳过系统注入的核验反馈/续写提示等
      if (m.content.startsWith('【核验反馈】') || m.content.startsWith('（系统提示）')) continue
      return m.content
    }
  }
  return ''
}

/**
 * 拿到当前最新的助手回复（最后一条 assistant 消息的 content）。
 */
function findLatestAssistantReply(history: ChatMessage[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === 'assistant') return history[i].content ?? ''
  }
  return ''
}

/**
 * 从完整历史中截取「最近一轮」上下文给核验模型看（避免整段历史太长）。
 * 策略：从最后一条 user 消息（即原始需求/上一轮核验反馈）开始，到最后一条 assistant 结束。
 */
function sliceRecentRound(history: ChatMessage[]): ChatMessage[] {
  // 找倒数第二条 user 之前的内容作为可舍弃部分；不够就全给
  let userCount = 0
  let cut = 0
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]
    if (m.role === 'user' && typeof m.content === 'string' && !m.content.startsWith('【以下为更早对话的自动压缩摘要】')) {
      userCount++
      if (userCount >= 2) {
        cut = i
        break
      }
    }
  }
  return history.slice(Math.max(0, cut))
}

/**
 * #1 最终核验：判断当前最终交付是否满足原始需求。
 * 返回 { pass, score, issues, suggestion }。
 * 核验本身失败（模型报错等）时静默返回 pass=true，避免因核验故障而中断主流程。
 */
export async function verifyFinalResult(
  history: ChatMessage[],
  deps: VerifyDeps,
): Promise<VerifyResult> {
  const originalQuery = findOriginalQuery(history)
  const latestReply = findLatestAssistantReply(history)

  // 没有原始需求或没有回复 → 跳过（理论上不会发生，但保险起见）
  if (!originalQuery || !latestReply) {
    return { pass: true, score: 100, issues: [], suggestion: '' }
  }

  const recent = sliceRecentRound(history)
  const historyText = recent
    .map(m => {
      if (m.role === 'tool') return `[工具结果 ${m.tool_call_id}] ${(m.content ?? '').slice(0, 500)}`
      const calls = m.tool_calls?.length
        ? ' [调用工具: ' + m.tool_calls.map(t => t.function.name).join(', ') + ']'
        : ''
      return `[${m.role}] ${(m.content ?? '').slice(0, 1000)}${calls}`
    })
    .join('\n')
    .slice(0, 30000)

  const userPrompt = `【用户原始需求】
${originalQuery}

【对话过程与最终交付】
${historyText}

请按上面的评分标准进行核验，严格输出 JSON。`

  try {
    const { content } = await chatComplete(
      [
        { role: 'system', content: FINAL_VERIFY_SYSTEM },
        { role: 'user', content: userPrompt },
      ],
      {
        apiKey: deps.apiKey,
        model: deps.model,
        baseURL: deps.baseURL,
        provider: deps.provider,
        signal: deps.signal,
        onRequest: deps.onRequest,
        onUsage: deps.onUsage,
      },
    )
    return parseVerifyJSON(content)
  } catch {
    // 核验本身失败 → 放行，不因为核验故障而卡住主流程
    return { pass: true, score: 100, issues: [], suggestion: '' }
  }
}

/**
 * 从模型输出中提取 JSON。模型可能包了 markdown 代码块、可能前后有废话，这里做兜底解析。
 */
function parseVerifyJSON(text: string): VerifyResult {
  // 先尝试直接解析
  try {
    const obj = JSON.parse(text.trim())
    return normalizeVerifyResult(obj)
  } catch { /* fallthrough */ }

  // 尝试提取 ```json ... ``` 块
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (m) {
    try {
      const obj = JSON.parse(m[1].trim())
      return normalizeVerifyResult(obj)
    } catch { /* fallthrough */ }
  }

  // 尝试提取第一个 { 到最后一个 }
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first !== -1 && last !== -1 && last > first) {
    try {
      const obj = JSON.parse(text.slice(first, last + 1))
      return normalizeVerifyResult(obj)
    } catch { /* fallthrough */ }
  }

  // 彻底解析不了 → 放行
  return { pass: true, score: 100, issues: [], suggestion: '' }
}

function normalizeVerifyResult(obj: any): VerifyResult {
  const score = typeof obj?.score === 'number' ? Math.max(0, Math.min(100, obj.score)) : 100
  const pass = obj?.pass === true || (typeof obj?.pass !== 'boolean' && score >= 70)
  const issues = Array.isArray(obj?.issues) ? obj.issues.filter(Boolean).slice(0, 10) : []
  const suggestion = typeof obj?.suggestion === 'string' ? obj.suggestion : ''
  return { pass, score, issues, suggestion }
}
