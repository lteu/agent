import type { ChatMessage } from '../llm.js'

export type ManagedSubagentStatus = 'completed' | 'max_steps' | 'failed' | 'cancelled' | 'busy'

export type ManagedSubagentEvent =
  | { type: 'text'; content: string }
  | { type: 'limit'; steps: number }
  | { type: string; [key: string]: unknown }

export type ManagedSubagentResult = {
  agent_id: string
  description: string
  status: ManagedSubagentStatus
  turns_used: number
  max_steps: number
  result: string
  message?: string
}

type ManagedSubagentSession = {
  id: string
  description: string
  history: ChatMessage[]
  running: boolean
  updatedAt: number
}

export type ManagedSubagentRunner = (
  history: ChatMessage[],
  maxSteps: number,
) => AsyncIterable<ManagedSubagentEvent>

export type ManagedSubagentInput = {
  description: string
  prompt: string
  agentId?: string
  maxSteps?: number
  cwd: string
}

const DEFAULT_MAX_STEPS = 200
const MAX_MAX_STEPS = 500
const MAX_SESSIONS = 100

function newAgentId(): string {
  return `agent_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

export function normalizeSubagentMaxSteps(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_STEPS
  return Math.max(1, Math.min(MAX_MAX_STEPS, Math.floor(value)))
}

function systemPrompt(cwd: string): string {
  return `你是由主 agent 派生的受管子 agent。你只负责用户分配给你的明确子任务，不要接管其他 agent 的范围。
当前工作目录是 ${cwd}。你具备全套本地工具，需要时直接读取文件、执行命令或检索网页。
持续工作到子任务真正完成；遇到单一路径失败时尝试合理替代方案。若任务包含多条题目，逐条记录进度和结果，避免漏项。
主 agent 提供的 task_id、输入路径、输出路径和任务边界视为已完成的调度结果。只读取完成本子任务必需的文件；
不要重新扫描整个工作区、总 metadata、总 results 或其他 agent 的目录，也不要重复验证全局任务划分，除非分配信息缺失或实际文件与其矛盾。
结束时必须返回一份自包含的简洁汇报，明确列出：已完成内容、最终答案或产物、未完成项及原因。不要把未完成任务描述成已完成。`
}

/**
 * 管理可恢复的子 agent sidechain。每个实例拥有独立历史和轮次预算；调用者可用 agent_id 续跑。
 * 同一个 agent 不允许并发续跑，不同 agent 则可由上层工具批次自然并行执行。
 */
export class ManagedSubagentStore {
  private sessions = new Map<string, ManagedSubagentSession>()

  constructor(private readonly maxSessions = MAX_SESSIONS) {}

  private prune(): void {
    if (this.sessions.size < this.maxSessions) return
    const idle = [...this.sessions.values()]
      .filter(session => !session.running)
      .sort((a, b) => a.updatedAt - b.updatedAt)
    while (this.sessions.size >= this.maxSessions && idle.length) {
      this.sessions.delete(idle.shift()!.id)
    }
  }

  async run(input: ManagedSubagentInput, runner: ManagedSubagentRunner): Promise<ManagedSubagentResult> {
    const maxSteps = normalizeSubagentMaxSteps(input.maxSteps)
    const description = input.description.trim() || '未命名子任务'
    const prompt = input.prompt.trim()
    let session: ManagedSubagentSession | undefined

    if (input.agentId) {
      session = this.sessions.get(input.agentId)
      if (!session) {
        return {
          agent_id: input.agentId,
          description,
          status: 'failed',
          turns_used: 0,
          max_steps: maxSteps,
          result: '',
          message: `未找到可恢复的子 agent：${input.agentId}`,
        }
      }
      if (session.running) {
        return {
          agent_id: session.id,
          description: session.description,
          status: 'busy',
          turns_used: 0,
          max_steps: maxSteps,
          result: '',
          message: '该子 agent 正在运行，不能并发续跑同一个 agent_id',
        }
      }
      session.history.push({
        role: 'user',
        content: `【继续子任务】${prompt || '继续完成尚未完成的工作，并汇报最终结果。'}`,
      })
      session.description = description
    } else {
      this.prune()
      const id = newAgentId()
      session = {
        id,
        description,
        history: [
          { role: 'system', content: systemPrompt(input.cwd) },
          { role: 'user', content: prompt },
        ],
        running: false,
        updatedAt: Date.now(),
      }
      this.sessions.set(id, session)
    }

    session.running = true
    session.updatedAt = Date.now()
    const assistantCountBefore = session.history.filter(message => message.role === 'assistant').length
    const texts: string[] = []
    let status: ManagedSubagentStatus = 'completed'
    let turnsUsed = 0
    let message: string | undefined

    try {
      for await (const event of runner(session.history, maxSteps)) {
        if (event.type === 'text' && typeof event.content === 'string' && event.content) {
          texts.push(event.content)
        } else if (event.type === 'limit') {
          status = 'max_steps'
          turnsUsed = typeof event.steps === 'number' ? event.steps : maxSteps
          message = '子 agent 达到轮次上限；请使用同一 agent_id 续跑，不要从头重做或静默接管。'
        }
      }
    } catch (error: any) {
      const cancelled = error?.name === 'AbortError'
      status = cancelled ? 'cancelled' : 'failed'
      message = error?.message ?? String(error)
    } finally {
      session.running = false
      session.updatedAt = Date.now()
    }

    if (!turnsUsed) {
      const assistantCountAfter = session.history.filter(item => item.role === 'assistant').length
      turnsUsed = Math.max(0, assistantCountAfter - assistantCountBefore)
    }
    const result = texts.join('\n').trim()
    if (status === 'completed' && !result) {
      status = 'failed'
      message = '子 agent 正常退出但没有返回最终文本；请检查其产物或使用同一 agent_id 续跑。'
    }

    return {
      agent_id: session.id,
      description: session.description,
      status,
      turns_used: turnsUsed,
      max_steps: maxSteps,
      result,
      ...(message ? { message } : {}),
    }
  }
}

export const managedSubagents = new ManagedSubagentStore()
