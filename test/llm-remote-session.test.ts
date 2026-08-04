import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'

import {
  createRemoteClaudeSession,
  streamCompletion,
  type ChatMessage,
} from '../src/llm.js'

async function consume<T>(generator: AsyncGenerator<unknown, T, unknown>): Promise<T> {
  let next = await generator.next()
  while (!next.done) next = await generator.next()
  return next.value
}

test('Remote Claude session 首步发全量，后续 --resume 只发增量消息', async t => {
  const bodies: any[] = []
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    bodies.push(body)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ choices: [], ai_remote_session: body.ai_remote_session })}\n\n`)
    if (body.ai_remote_session.mode === 'start') {
      res.write(`data: ${JSON.stringify({
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_1',
              type: 'function',
              function: { name: 'read_file', arguments: '{"path":"README.md"}' },
            }],
          },
          finish_reason: null,
        }],
      })}\n\n`)
      res.write('data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n')
    } else {
      res.write('data: {"choices":[{"index":0,"delta":{"content":"done"},"finish_reason":null}]}\n\n')
      res.write('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n')
    }
    res.end('data: [DONE]\n\n')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const address = server.address()
  assert(address && typeof address === 'object')

  const history: ChatMessage[] = [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'inspect' },
  ]
  const session = createRemoteClaudeSession()
  const options = {
    apiKey: 'test',
    model: 'test',
    provider: 'Claude via remote',
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    remoteClaudeSession: session,
  }
  const first = await consume(streamCompletion(history, options))
  history.push({ role: 'assistant', content: '', tool_calls: first.toolCalls })
  history.push({ role: 'tool', tool_call_id: 'call_1', content: 'file contents' })
  const second = await consume(streamCompletion(history, options))

  assert.equal(second.content, 'done')
  assert.deepEqual(bodies[0].messages, history.slice(0, 2))
  assert.equal(bodies[0].ai_remote_session.mode, 'start')
  assert.equal(bodies[0].ai_remote_session.step, 0)
  assert.deepEqual(bodies[1].messages, history.slice(2))
  assert.equal(bodies[1].ai_remote_session.id, bodies[0].ai_remote_session.id)
  assert.equal(bodies[1].ai_remote_session.mode, 'resume')
  assert.equal(bodies[1].ai_remote_session.step, 1)
})

test('gateway 未确认 session 协议时拒绝提交 cursor', async t => {
  const server = createServer(async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(
      'data: {"choices":[{"index":0,"delta":{"content":"legacy"},"finish_reason":"stop"}]}\n\n' +
      'data: [DONE]\n\n',
    )
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const address = server.address()
  assert(address && typeof address === 'object')
  const session = createRemoteClaudeSession()

  await assert.rejects(
    consume(streamCompletion([{ role: 'user', content: 'hi' }], {
      apiKey: 'test',
      model: 'test',
      provider: 'Claude via remote',
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      remoteClaudeSession: session,
    })),
    (error: any) => error?.code === 'REMOTE_SESSION_UNSUPPORTED',
  )
  assert.equal(session.active, false)
  assert.equal(session.historyCursor, 0)
})
