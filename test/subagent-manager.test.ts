import assert from 'node:assert/strict'
import test from 'node:test'
import type { ChatMessage } from '../src/llm.js'
import {
  ManagedSubagentStore,
  normalizeSubagentMaxSteps,
  type ManagedSubagentEvent,
} from '../src/agent/subagent-manager.js'
import { buildSystemPrompt } from '../src/agent/session.js'

test('主 agent 恢复批量任务时优先复用检查点并尽快派发', () => {
  const prompt = buildSystemPrompt('/workspace', 'terminal')
  assert.match(prompt, /不得先做全量工作区盘点/)
  assert.match(prompt, /checkpoint\/index/)
  assert.match(prompt, /不要重复 list 同一目录/)
  assert.match(prompt, /回收后统一做一次/)
})

test('子 agent 默认获得 200 步，并限制异常预算', () => {
  assert.equal(normalizeSubagentMaxSteps(undefined), 200)
  assert.equal(normalizeSubagentMaxSteps(0), 1)
  assert.equal(normalizeSubagentMaxSteps(12.8), 12)
  assert.equal(normalizeSubagentMaxSteps(9999), 500)
})

test('子 agent 返回稳定 agent_id 和结构化完成状态', async () => {
  const store = new ManagedSubagentStore()
  const result = await store.run({
    description: '回答第一题',
    prompt: '计算 1+1',
    cwd: '/tmp',
  }, async function* (history: ChatMessage[], maxSteps: number): AsyncGenerator<ManagedSubagentEvent> {
    assert.equal(maxSteps, 200)
    assert.match(String(history[0]?.content), /不要重新扫描整个工作区/)
    assert.match(String(history[0]?.content), /主 agent 提供的 task_id/)
    assert.match(String(history[1]?.content), /计算 1\+1/)
    history.push({ role: 'assistant', content: '答案是 2' })
    yield { type: 'text', content: '答案是 2' }
  })

  assert.match(result.agent_id, /^agent_/)
  assert.equal(result.status, 'completed')
  assert.equal(result.turns_used, 1)
  assert.equal(result.result, '答案是 2')
})

test('达到步数上限后可用同一 agent_id 和原历史续跑', async () => {
  const store = new ManagedSubagentStore()
  const first = await store.run({
    description: '调查一组题',
    prompt: '先调查题目 A',
    maxSteps: 3,
    cwd: '/tmp',
  }, async function* (history: ChatMessage[]): AsyncGenerator<ManagedSubagentEvent> {
    history.push({ role: 'assistant', content: '已找到部分证据' })
    yield { type: 'text', content: '已找到部分证据' }
    yield { type: 'limit', steps: 3 }
  })

  assert.equal(first.status, 'max_steps')
  assert.equal(first.turns_used, 3)

  const resumed = await store.run({
    description: '调查一组题',
    prompt: '继续并给出最终答案',
    agentId: first.agent_id,
    maxSteps: 8,
    cwd: '/tmp',
  }, async function* (history: ChatMessage[]): AsyncGenerator<ManagedSubagentEvent> {
    assert.ok(history.some(message => String(message.content).includes('先调查题目 A')))
    assert.ok(history.some(message => String(message.content).includes('继续并给出最终答案')))
    history.push({ role: 'assistant', content: '最终答案 A' })
    yield { type: 'text', content: '最终答案 A' }
  })

  assert.equal(resumed.agent_id, first.agent_id)
  assert.equal(resumed.status, 'completed')
  assert.equal(resumed.max_steps, 8)
  assert.equal(resumed.result, '最终答案 A')
})

test('同一个 agent_id 不能被并发续跑', async () => {
  const store = new ManagedSubagentStore()
  const created = await store.run({
    description: '建立会话',
    prompt: '初始化',
    cwd: '/tmp',
  }, async function* (): AsyncGenerator<ManagedSubagentEvent> {
    yield { type: 'text', content: '初始化完成' }
  })

  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const running = store.run({
    description: '建立会话',
    prompt: '长时间继续',
    agentId: created.agent_id,
    cwd: '/tmp',
  }, async function* (): AsyncGenerator<ManagedSubagentEvent> {
    await gate
    yield { type: 'text', content: '继续完成' }
  })

  await Promise.resolve()
  const busy = await store.run({
    description: '建立会话',
    prompt: '重复继续',
    agentId: created.agent_id,
    cwd: '/tmp',
  }, async function* (): AsyncGenerator<ManagedSubagentEvent> {
    yield { type: 'text', content: '不应运行' }
  })
  assert.equal(busy.status, 'busy')

  release()
  assert.equal((await running).status, 'completed')
})
