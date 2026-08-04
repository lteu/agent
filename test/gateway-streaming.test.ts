import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import test from 'node:test'

async function unusedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  assert(address && typeof address === 'object')
  await new Promise<void>((resolveClose, reject) =>
    server.close(error => (error ? reject(error) : resolveClose())),
  )
  return address.port
}

test('流式网关立即发送响应头，不等待 Claude 完整回答', async t => {
  const dir = await mkdtemp(join(process.cwd(), '.ai-claude-gateway-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const fakeClaude = join(dir, 'fake-claude')
  const fakeClaudeScript = join(dir, 'fake-claude.mjs')
  await writeFile(
    fakeClaudeScript,
    `import readline from 'node:readline'
const lines = readline.createInterface({ input: process.stdin })
let turn = 0
const send = value => process.stdout.write(JSON.stringify(value) + '\\n')
lines.on('line', line => {
  turn += 1
  const emitText = text => {
    send({ type: 'assistant', message: { content: [{ type: 'text', text }] } })
    send({
      type: 'stream_event',
      event: {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    })
  }
  if (turn === 1) {
    emitText('READY')
    return
  }
  if (turn === 2) {
    if (line.includes('unprefixed-local-tool')) {
      send({
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use',
            id: 'local_mode_search_1',
            name: 'WebSearch',
            input: { query: 'preserve this research' },
          }],
        },
      })
      send({
        type: 'stream_event',
        event: {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use' },
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      })
      setTimeout(() => {
        send({
          type: 'user',
          message: {
            content: [{
              type: 'tool_result',
              tool_use_id: 'local_mode_search_1',
              content: 'preserved remote evidence',
            }],
          },
          tool_use_result: { searchCount: 1, durationSeconds: 0.1 },
        })
        send({
          type: 'assistant',
          message: {
            content: [{
              type: 'tool_use',
              id: 'local_bash_1',
              name: 'run_bash',
              input: { command: 'pwd', intent: 'test' },
            }],
          },
        })
        send({
          type: 'stream_event',
          event: {
            type: 'message_delta',
            delta: { stop_reason: 'tool_use' },
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        })
      }, 10)
      return
    }
    if (line.includes('unsupported-remote-tool')) {
      send({
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use',
            id: 'dangerous_1',
            name: 'DangerousRemoteTool',
            input: {},
          }],
        },
      })
      return
    }
    if (line.includes('session-limit')) {
      send({
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'rejected',
          rateLimitType: 'five_hour',
          resetsAt: 1_800_000_000,
        },
      })
      return
    }
    send({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'thinking',
            thinking: 'Compare both snapshots before choosing the next source.',
          },
          {
            type: 'text',
            text:
              "I'll search for the exact source first. " +
              'Found exact snapshots for both dates. Let me pull the menu content from each. ' +
              'The source contains evidence that must remain visible before the next fetch. ' +
              'x'.repeat(1_100) +
              ' TAIL_FACT_MUST_REMAIN_VISIBLE',
          },
          {
            type: 'tool_use',
            id: 'remote_search_1',
            name: 'WebSearch',
            input: { query: 'test' },
          },
        ],
      },
    })
    send({
      type: 'stream_event',
      event: {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    })
    setTimeout(() => {
      send({
        type: 'user',
        message: {
          content: [{
            type: 'tool_result',
            tool_use_id: 'remote_search_1',
            content: 'REMOTE_RESULT_HEAD ' + 'r'.repeat(2_500) + ' REMOTE_RESULT_TAIL',
          }],
        },
        tool_use_result: { searchCount: 1, durationSeconds: 1.2 },
      })
      emitText('STREAM_OK')
    }, 1200)
    return
  }
  emitText('UNEXPECTED_EXTRA_TURN')
})
`,
  )
  await writeFile(
    fakeClaude,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeClaudeScript)} "$@"\n`,
  )
  await chmod(fakeClaude, 0o755)

  const port = await unusedPort()
  const gateway = spawn(process.execPath, [resolve('deploy/ai-claude-gateway.mjs')], {
    env: {
      ...process.env,
      AI_CLAUDE_BIN: fakeClaude,
      AI_CLAUDE_CWD: process.cwd(),
      AI_CLAUDE_GATEWAY_HOST: '127.0.0.1',
      AI_CLAUDE_GATEWAY_PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let gatewayStderr = ''
  gateway.stderr.on('data', chunk => {
    gatewayStderr += String(chunk)
  })
  t.after(() => {
    if (gateway.exitCode == null && gateway.signalCode == null) gateway.kill('SIGTERM')
  })

  const origin = `http://127.0.0.1:${port}`
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await fetch(`${origin}/health`).then(res => res.ok).catch(() => false)) break
    await new Promise(resolveWait => setTimeout(resolveWait, 20))
  }

  const started = Date.now()
  const response = await fetch(`${origin}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'test',
      stream: true,
      messages: [{ role: 'user', content: 'test' }],
    }),
  })
  const headersElapsed = Date.now() - started
  assert.equal(response.status, 200)
  assert(headersElapsed < 700, `response headers took ${headersElapsed}ms`)

  const payload = await response.text().catch(error => {
    throw new Error(`stream terminated: ${String(error)}\ngateway stderr: ${gatewayStderr}`)
  })
  assert.match(payload, /STREAM_OK/)
  assert.match(payload, /ai_remote_progress/)
  assert.match(payload, /I'll search for the exact source first/)
  assert.match(
    payload,
    /Found exact snapshots for both dates\. Let me pull the menu content from each\./,
  )
  assert.match(
    payload,
    /The source contains evidence that must remain visible before the next fetch\./,
  )
  assert.match(payload, /TAIL_FACT_MUST_REMAIN_VISIBLE/)
  assert.match(payload, /Web Search/)
  assert.match(payload, /Did 1 search in 1s/)
  assert.match(payload, /Compare both snapshots before choosing the next source\./)
  assert.match(payload, /REMOTE_RESULT_HEAD/)
  assert.match(payload, /REMOTE_RESULT_TAIL/)
  assert.doesNotMatch(payload, /UNEXPECTED_EXTRA_TURN/)
  assert.match(payload, /"usage":\{"prompt_tokens":/)
  assert.match(payload, /data: \[DONE\]/)
  const completedHealth: any = await fetch(`${origin}/health`).then(res => res.json())
  assert.equal(completedHealth.remote_web_searches, 1)
  assert.equal(completedHealth.remote_web_fetches, 0)

  const localToolResponse = await fetch(`${origin}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'test',
      stream: true,
      messages: [{ role: 'user', content: 'unprefixed-local-tool' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'run_bash',
            description: 'test',
            parameters: { type: 'object', properties: {} },
          },
        },
      ],
    }),
  })
  const localToolPayload = await localToolResponse.text()
  assert.match(localToolPayload, /"name":"run_bash"/)
  assert.match(localToolPayload, /"finish_reason":"tool_calls"/)
  assert.match(localToolPayload, /ai_remote_context/)

  const unsupportedResponse = await fetch(`${origin}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'test',
      stream: true,
      messages: [{ role: 'user', content: 'unsupported-remote-tool' }],
    }),
  })
  const unsupportedPayload = await unsupportedResponse.text()
  assert.match(unsupportedPayload, /ai_remote_error/)
  assert.match(unsupportedPayload, /DangerousRemoteTool/)
  assert.match(unsupportedPayload, /data: \[DONE\]/)

  const limitStarted = Date.now()
  const limitResponse = await fetch(`${origin}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'test',
      stream: true,
      messages: [{ role: 'user', content: 'session-limit' }],
    }),
  })
  const limitPayload = await limitResponse.text()
  assert(Date.now() - limitStarted < 1_000, 'rate limit should terminate immediately')
  assert.match(limitPayload, /ai_remote_error/)
  assert.match(limitPayload, /You've hit your session limit/)
  assert.match(limitPayload, /CLAUDE_RATE_LIMIT/)
  assert.match(limitPayload, /data: \[DONE\]/)

  const disconnected = await fetch(`${origin}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'test',
      stream: true,
      messages: [{ role: 'user', content: 'disconnect' }],
    }),
  })
  await disconnected.body?.cancel()

  let active = -1
  for (let attempt = 0; attempt < 50; attempt++) {
    const health: any = await fetch(`${origin}/health`).then(res => res.json())
    active = health.active
    if (active === 0) break
    await new Promise(resolveWait => setTimeout(resolveWait, 20))
  }
  assert.equal(active, 0, 'client disconnect should cancel the active Claude request')
})
