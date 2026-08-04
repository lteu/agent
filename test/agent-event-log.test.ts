import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import {
  createHistoryTraceContext,
  flushAgentEventLog,
  traceAgentEvent,
} from '../src/agent/history-trace.js'

test('agent event 日志聚合高频流并按大小轮转', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ai-agent-events-'))
  const previousDir = process.env.AI_LOG_DIR
  const previousMax = process.env.AI_AGENT_EVENT_LOG_MAX_BYTES
  process.env.AI_LOG_DIR = directory
  process.env.AI_AGENT_EVENT_LOG_MAX_BYTES = '2048'
  try {
    const context = createHistoryTraceContext('terminal', 'stress')
    for (let index = 0; index < 10_000; index++) {
      traceAgentEvent(context, { type: 'thinking', content: 'x' })
    }
    await flushAgentEventLog()
    const logPath = join(directory, 'agent-events.jsonl')
    const first = (await readFile(logPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.equal(first.length, 1)
    assert.equal(first[0].eventType, 'thinking')
    assert.equal(first[0].eventCount, 10_000)
    assert.equal(first[0].contentLength, 10_000)

    for (let index = 0; index < 5; index++) {
      traceAgentEvent(context, { type: 'model', phase: 'request', summary: `phase-${index}` })
    }
    await flushAgentEventLog()
    for (let index = 0; index < 5; index++) {
      traceAgentEvent(context, { type: 'model', phase: 'receiving', summary: `next-${index}` })
    }
    await flushAgentEventLog()
    assert.ok((await stat(`${logPath}.1`)).size > 0)
    assert.ok((await stat(logPath)).size <= 2048)
  } finally {
    if (previousDir === undefined) delete process.env.AI_LOG_DIR
    else process.env.AI_LOG_DIR = previousDir
    if (previousMax === undefined) delete process.env.AI_AGENT_EVENT_LOG_MAX_BYTES
    else process.env.AI_AGENT_EVENT_LOG_MAX_BYTES = previousMax
    await rm(directory, { recursive: true, force: true })
  }
})
