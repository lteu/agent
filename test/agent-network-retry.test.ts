import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { runAgent, type AgentEvent } from '../src/agent/engine.js'
import type { ChatMessage } from '../src/llm.js'

test('网关 504 超时会安全重试当前模型轮次', async t => {
  let requests = 0
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) {
      // Drain the request before replying, matching a normal HTTP server.
    }
    requests += 1
    if (requests === 1) {
      res.writeHead(504, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          error: {
            message: 'Claude gateway request timed out after 900000ms without output',
          },
        }),
      )
      return
    }

    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"choices":[{"delta":{"content":"RECOVERED"},"finish_reason":null}]}\n\n')
    res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n')
    res.end('data: [DONE]\n\n')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const address = server.address()
  assert(address && typeof address === 'object')

  const history: ChatMessage[] = [
    { role: 'system', content: 'test' },
    { role: 'user', content: 'answer' },
  ]
  const events: AgentEvent[] = []
  for await (const event of runAgent(history, {
    apiKey: 'test',
    model: 'test',
    baseURL: `http://127.0.0.1:${address.port}`,
    provider: 'test gateway',
    noCompact: true,
    maxSteps: 2,
  })) {
    events.push(event)
  }

  assert.equal(requests, 2)
  assert(events.some(event => event.type === 'tool' && event.summary.includes('重试中（1/3）')))
  assert(events.some(event => event.type === 'text' && event.content === 'RECOVERED'))
})
