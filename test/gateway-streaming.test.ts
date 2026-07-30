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
lines.on('line', () => {
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
  send({
    type: 'assistant',
    message: {
      content: [{
        type: 'tool_use',
        id: 'remote_search_1',
        name: 'WebSearch',
        input: { query: 'test' },
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
  setTimeout(() => emitText('<LOCAL_AGENT_FINAL>STREAM_OK'), 1200)
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
  assert.match(payload, /data: \[DONE\]/)
  const completedHealth: any = await fetch(`${origin}/health`).then(res => res.json())
  assert.equal(completedHealth.remote_web_searches, 1)
  assert.equal(completedHealth.remote_web_fetches, 0)

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
