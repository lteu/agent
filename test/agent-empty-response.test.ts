import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { runAgent, type AgentEvent } from '../src/agent/engine.js'
import { messagesForRequest, type ChatMessage } from '../src/llm.js'

test('请求层过滤无工具调用的空 assistant，但保留 function-calling 配对消息', () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: 'question' },
    { role: 'assistant', content: '' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'call_1',
        type: 'function',
        function: { name: 'read_file', arguments: '{}' },
      }],
    },
  ]
  const filtered = messagesForRequest(messages)
  assert.equal(filtered.length, 2)
  assert.equal(filtered[1].tool_calls?.[0].id, 'call_1')
})

test('空响应恢复不会把空 assistant 发给 GLM 兼容接口', async t => {
  const requestMessages: ChatMessage[][] = []
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    requestMessages.push(JSON.parse(Buffer.concat(chunks).toString('utf8')).messages)

    res.writeHead(200, { 'content-type': 'text/event-stream' })
    if (requestMessages.length === 1) {
      res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n')
    } else {
      res.write('data: {"choices":[{"delta":{"content":"RECOVERED"},"finish_reason":null}]}\n\n')
      res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n')
    }
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
    provider: 'Qihuo GLM',
    noCompact: true,
    maxSteps: 3,
  })) {
    events.push(event)
  }

  assert.equal(requestMessages.length, 2)
  assert.equal(
    requestMessages[1].some(message =>
      message.role === 'assistant' && !message.content?.trim() && !message.tool_calls?.length),
    false,
  )
  assert.equal(
    history.some(message =>
      message.role === 'assistant' && !message.content?.trim() && !message.tool_calls?.length),
    false,
  )
  assert(events.some(event => event.type === 'tool' && event.summary.includes('模型返回空响应')))
  assert(events.some(event => event.type === 'text' && event.content === 'RECOVERED'))
})
