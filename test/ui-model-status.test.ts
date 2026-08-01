import assert from 'node:assert/strict'
import test from 'node:test'
import { formatModelStatus, type ModelStatus } from '../src/ui-model-status.js'

const status = (phase: ModelStatus['phase'], at = 1_000): ModelStatus => ({
  phase,
  phaseStartedAt: at,
  lastActivityAt: at,
})

test('模型状态展示真实阶段和静默时间', () => {
  assert.equal(
    formatModelStatus(status('connecting'), 6_000, 'glm-5.2'),
    '正在连接 glm-5.2（静默 5s）',
  )
  assert.equal(
    formatModelStatus(status('waiting'), 36_000, 'glm-5.2'),
    '等待 glm-5.2 响应（静默 35s · 响应较慢）',
  )
  assert.equal(
    formatModelStatus(status('receiving'), 96_000, 'glm-5.2'),
    '正在接收 glm-5.2 输出（静默 95s · 响应持续较慢，可按 Esc 中断）',
  )
})
