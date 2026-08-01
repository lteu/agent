import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { streamCompletion } from '../src/llm.js'

test('模型流暴露连接、等待和接收阶段', async t => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\n')
    res.end('data: [DONE]\n\n')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const address = server.address()
  assert(address && typeof address === 'object')

  const phases: string[] = []
  for await (const part of streamCompletion([{ role: 'user', content: 'hi' }], {
    apiKey: 'test',
    model: 'test',
    baseURL: `http://127.0.0.1:${address.port}`,
  })) {
    if (part.type === 'model') phases.push(part.phase)
  }

  assert.deepEqual(phases, ['connecting', 'waiting', 'receiving'])
})

test('首包静默超过阈值会终止模型流', async t => {
  const previous = process.env.AI_LLM_FIRST_TOKEN_TIMEOUT_MS
  process.env.AI_LLM_FIRST_TOKEN_TIMEOUT_MS = '30'
  t.after(() => {
    if (previous === undefined) delete process.env.AI_LLM_FIRST_TOKEN_TIMEOUT_MS
    else process.env.AI_LLM_FIRST_TOKEN_TIMEOUT_MS = previous
  })

  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.flushHeaders()
    t.after(() => res.destroy())
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const address = server.address()
  assert(address && typeof address === 'object')

  await assert.rejects(
    async () => {
      for await (const _part of streamCompletion([{ role: 'user', content: 'hi' }], {
        apiKey: 'test',
        model: 'test',
        baseURL: `http://127.0.0.1:${address.port}`,
      })) {
        // consume
      }
    },
    /first token timed out after 30ms/,
  )
})

test('响应头计时器不会误杀仍在正常流式输出的长请求', async t => {
  const previousHeaders = process.env.AI_LLM_HEADERS_TIMEOUT_MS
  const previousFirst = process.env.AI_LLM_FIRST_TOKEN_TIMEOUT_MS
  process.env.AI_LLM_HEADERS_TIMEOUT_MS = '30'
  process.env.AI_LLM_FIRST_TOKEN_TIMEOUT_MS = '200'
  t.after(() => {
    if (previousHeaders === undefined) delete process.env.AI_LLM_HEADERS_TIMEOUT_MS
    else process.env.AI_LLM_HEADERS_TIMEOUT_MS = previousHeaders
    if (previousFirst === undefined) delete process.env.AI_LLM_FIRST_TOKEN_TIMEOUT_MS
    else process.env.AI_LLM_FIRST_TOKEN_TIMEOUT_MS = previousFirst
  })

  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.flushHeaders()
    setTimeout(() => {
      res.write('data: {"choices":[{"delta":{"content":"still alive"},"finish_reason":"stop"}]}\n\n')
      res.end('data: [DONE]\n\n')
    }, 70)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const address = server.address()
  assert(address && typeof address === 'object')

  const text: string[] = []
  for await (const part of streamCompletion([{ role: 'user', content: 'hi' }], {
    apiKey: 'test',
    model: 'test',
    baseURL: `http://127.0.0.1:${address.port}`,
  })) {
    if (part.type === 'text') text.push(part.delta)
  }
  assert.deepEqual(text, ['still alive'])
})

test('OpenAI 兼容 reasoning_content 作为 thinking 事件透传且不混入正文', async t => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"choices":[{"delta":{"reasoning_content":"inspect evidence"},"finish_reason":null}]}\n\n')
    res.write('data: {"choices":[{"delta":{"content":"final"},"finish_reason":null}]}\n\n')
    res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n')
    res.end('data: [DONE]\n\n')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const address = server.address()
  assert(address && typeof address === 'object')

  const thinking: string[] = []
  const text: string[] = []
  const stream = streamCompletion([{ role: 'user', content: 'hi' }], {
    apiKey: 'test',
    model: 'test',
    baseURL: `http://127.0.0.1:${address.port}`,
  })
  let result = await stream.next()
  while (!result.done) {
    if (result.value.type === 'thinking') thinking.push(result.value.delta)
    if (result.value.type === 'text') text.push(result.value.delta)
    result = await stream.next()
  }
  assert.deepEqual(thinking, ['inspect evidence'])
  assert.deepEqual(text, ['final'])
  assert.equal(result.value.content, 'final')
})

test('Anthropic thinking_delta 作为独立事件透传', async t => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\n')
    res.write('data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n')
    res.write('data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"compare sources"}}\n\n')
    res.write('data: {"type":"content_block_stop","index":0}\n\n')
    res.write('data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n')
    res.write('data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"done"}}\n\n')
    res.write('data: {"type":"content_block_stop","index":1}\n\n')
    res.write('data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n')
    res.end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const address = server.address()
  assert(address && typeof address === 'object')

  const thinking: string[] = []
  for await (const part of streamCompletion([{ role: 'user', content: 'hi' }], {
    apiKey: 'test',
    model: 'test',
    provider: 'Anthropic',
    baseURL: `http://127.0.0.1:${address.port}`,
  })) {
    if (part.type === 'thinking') thinking.push(part.delta)
  }
  assert.deepEqual(thinking, ['compare sources'])
})
