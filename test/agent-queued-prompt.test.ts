import assert from 'node:assert/strict'
import test from 'node:test'
import { queuedPromptMessage } from '../src/agent/engine.js'

test('运行中追加的问题被合并为下一轮立即执行的用户指令', () => {
  const message = queuedPromptMessage([' 不要泄漏答案 ', '改用公开来源'])
  assert.match(message, /不要等原任务结束后再处理/)
  assert.match(message, /\[追加指令 1\]\n不要泄漏答案/)
  assert.match(message, /\[追加指令 2\]\n改用公开来源/)
})
