import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
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

test('gateway 用 --session-id 启动并在下一步用 --resume 发送权威工具结果增量', async t => {
  const dir = await mkdtemp(join(process.cwd(), '.ai-claude-resume-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const capture = join(dir, 'capture.jsonl')
  const fakeClaude = join(dir, 'fake-claude')
  const fakeClaudeScript = join(dir, 'fake-claude.mjs')
  await writeFile(
    fakeClaudeScript,
    `import { appendFileSync } from 'node:fs'
import readline from 'node:readline'
const args = process.argv.slice(2)
const resume = args.includes('--resume')
const capture = ${JSON.stringify(capture)}
appendFileSync(capture, JSON.stringify({ kind: 'args', args }) + '\\n')
const send = value => process.stdout.write(JSON.stringify(value) + '\\n')
const emitStop = reason => send({ type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: reason }, usage: { input_tokens: 1, output_tokens: 1 } } })
let turn = 0
readline.createInterface({ input: process.stdin }).on('line', line => {
  turn += 1
  appendFileSync(capture, JSON.stringify({ kind: 'input', resume, line: JSON.parse(line) }) + '\\n')
  if (!resume && turn === 1) {
    send({ type: 'assistant', message: { content: [{ type: 'text', text: 'READY' }] } })
    emitStop('end_turn')
    return
  }
  if (!resume) {
    send({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'call_1', name: 'mcp__local_agent__view_image', input: { path: 'shot.png' } }] } })
    emitStop('tool_use')
    return
  }
  send({ type: 'assistant', message: { content: [{ type: 'text', text: 'RESUMED_OK' }] } })
  emitStop('end_turn')
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
      AI_CLAUDE_GATEWAY_EVENT_LOG: join(dir, 'events.jsonl'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  gateway.stderr.on('data', chunk => { stderr += String(chunk) })
  t.after(() => {
    if (gateway.exitCode == null && gateway.signalCode == null) gateway.kill('SIGTERM')
  })
  const origin = `http://127.0.0.1:${port}`
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await fetch(`${origin}/health`).then(res => res.ok).catch(() => false)) break
    await new Promise(resolveWait => setTimeout(resolveWait, 20))
  }

  const sessionId = '12345678-1234-4123-8123-123456789abc'
  const request = async (body: any) => {
    const response = await fetch(`${origin}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test', stream: true, ...body }),
    })
    return { status: response.status, text: await response.text() }
  }
  const tools = [{ type: 'function', function: { name: 'view_image', parameters: { type: 'object' } } }]
  const first = await request({
    ai_remote_session: { id: sessionId, mode: 'start', step: 0 },
    ai_remote_trace: true,
    messages: [{ role: 'user', content: 'read it' }],
    tools,
  })
  assert.equal(first.status, 200, stderr)
  assert.match(first.text, /ai_remote_session/)
  assert.match(first.text, /call_1/)
  assert.match(first.text, /"kind":"spawn"/)
  assert.match(first.text, /"label":"handshake"/)
  assert.match(first.text, /"label":"initial-conversation"/)
  assert.match(first.text, /"kind":"stdout"/)

  const wrongToolResult = await fetch(`${origin}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'test',
      stream: false,
      ai_remote_session: { id: sessionId, mode: 'resume', step: 1 },
      messages: [{ role: 'tool', tool_call_id: 'wrong_call', content: 'wrong' }],
      tools,
    }),
  })
  assert.equal(wrongToolResult.status, 409)
  assert.equal((await wrongToolResult.json()).error.code, 'REMOTE_SESSION_INVALID')

  const delta = [
    { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'view_image', arguments: '{}' } }] },
    {
      role: 'tool',
      tool_call_id: 'call_1',
      content: 'IMAGE LOADED',
      ai_local_tool_content: [{ type: 'image', mediaType: 'image/png', data: 'aW1hZ2UtYnl0ZXM=' }],
    },
  ]
  const second = await request({
    ai_remote_session: { id: sessionId, mode: 'resume', step: 1 },
    ai_remote_trace: true,
    messages: delta,
    tools,
  })
  assert.equal(second.status, 200, stderr)
  assert.match(second.text, /RESUMED_OK/)
  assert.match(second.text, /"label":"resume-update"/)

  const events = (await readFile(capture, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  const invocations = events.filter(event => event.kind === 'args')
  assert.equal(invocations.length, 2)
  assert.deepEqual(invocations[0].args.slice(invocations[0].args.indexOf('--session-id'), invocations[0].args.indexOf('--session-id') + 2), ['--session-id', sessionId])
  assert.deepEqual(invocations[1].args.slice(invocations[1].args.indexOf('--resume'), invocations[1].args.indexOf('--resume') + 2), ['--resume', sessionId])
  assert.doesNotMatch(
    invocations[0].args[invocations[0].args.indexOf('--allowedTools') + 1],
    /mcp__local_agent__view_image/,
  )
  const resumeInputs = events.filter(event => event.kind === 'input' && event.resume)
  assert.equal(resumeInputs.length, 1, 'resume 进程不应再进行 handshake')
  assert.equal(resumeInputs[0].line.message.content[0].type, 'text')
  assert.match(resumeInputs[0].line.message.content[0].text, /LOCAL_AGENT_RESUME_UPDATE/)
  assert.match(resumeInputs[0].line.message.content[0].text, /"tool_use_id":"call_1"/)
  assert.match(resumeInputs[0].line.message.content[0].text, /"tool_name":"view_image"/)
  assert.match(resumeInputs[0].line.message.content[0].text, /IMAGE LOADED/)
  assert.doesNotMatch(resumeInputs[0].line.message.content[0].text, /aW1hZ2UtYnl0ZXM=/)
  assert.equal(resumeInputs[0].line.message.content[1].type, 'text')
  assert.match(resumeInputs[0].line.message.content[1].text, /LOCAL_AGENT_IMAGE_RESULT/)
  assert.deepEqual(resumeInputs[0].line.message.content[2], {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2UtYnl0ZXM=' },
  })
  assert.doesNotMatch(JSON.stringify(resumeInputs[0]), /read it/)

  const stale = await fetch(`${origin}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'test',
      stream: false,
      ai_remote_session: { id: sessionId, mode: 'resume', step: 1 },
      messages: [{ role: 'user', content: 'duplicate' }],
    }),
  })
  assert.equal(stale.status, 409)
  assert.equal((await stale.json()).error.code, 'REMOTE_SESSION_STALE')
})
