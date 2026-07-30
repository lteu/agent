import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { streamCompletion, type ChatMessage } from '../src/llm.js'
import {
  addTokenUsage,
  tokenUsageFromAnthropic,
  tokenUsageFromOpenAI,
} from '../src/token-usage.js'

test('按 Claude Code 口径区分 Anthropic input/output/cache token', () => {
  assert.deepEqual(
    tokenUsageFromAnthropic({
      input_tokens: 10,
      output_tokens: 4,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 5,
    }),
    {
      inputTokens: 10,
      outputTokens: 4,
      cacheReadInputTokens: 20,
      cacheCreationInputTokens: 5,
      totalTokens: 39,
    },
  )
})

test('OpenAI cached_tokens 不会重复计入服务商 total_tokens', () => {
  assert.deepEqual(
    tokenUsageFromOpenAI({
      prompt_tokens: 30,
      completion_tokens: 7,
      total_tokens: 37,
      prompt_tokens_details: { cached_tokens: 12 },
    }),
    {
      inputTokens: 30,
      outputTokens: 7,
      cacheReadInputTokens: 12,
      cacheCreationInputTokens: 0,
      totalTokens: 37,
    },
  )
})

test('会话累计保留各 token 类别', () => {
  assert.deepEqual(
    addTokenUsage(
      tokenUsageFromAnthropic({ input_tokens: 3, output_tokens: 2 }),
      tokenUsageFromAnthropic({
        input_tokens: 4,
        output_tokens: 1,
        cache_read_input_tokens: 8,
      }),
    ),
    {
      inputTokens: 7,
      outputTokens: 3,
      cacheReadInputTokens: 8,
      cacheCreationInputTokens: 0,
      totalTokens: 18,
    },
  )
})

test('OpenAI 流请求开启 include_usage 并回传一次 usage', async t => {
  let requestBody: any
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    requestBody = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\n')
    res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n')
    res.write(
      'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":2,"total_tokens":13}}\n\n',
    )
    res.end('data: [DONE]\n\n')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const address = server.address()
  assert(address && typeof address === 'object')

  const observed: any[] = []
  const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }]
  const stream = streamCompletion(messages, {
    apiKey: 'test',
    model: 'test',
    baseURL: `http://127.0.0.1:${address.port}`,
    onUsage: usage => observed.push(usage),
  })
  let result = await stream.next()
  while (!result.done) result = await stream.next()

  assert.equal(requestBody.stream_options.include_usage, true)
  assert.equal(result.value.content, 'ok')
  assert.deepEqual(observed, [
    {
      inputTokens: 11,
      outputTokens: 2,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      totalTokens: 13,
    },
  ])
})
