import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout } from 'node:timers/promises'
import test from 'node:test'
import { createMcpRuntime } from '../src/mcp.js'
import { runAgent } from '../src/agent/engine.js'
import type { ChatMessage } from '../src/llm.js'

const fixture = fileURLToPath(new URL('./fixtures/mcp-echo-server.mjs', import.meta.url))
const config = (env = {}) => ({ type: 'stdio' as const, command: process.execPath, args: [fixture], env })
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 5000
  while (!predicate()) {
    assert(Date.now() < deadline, 'condition timed out')
    await setTimeout(10)
  }
}

test('background discovery publishes fast servers while slow ones are still connecting', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-background-'))
  const gate = join(dir, 'gate')
  const runtime = await createMcpRuntime({ background: true, servers: {
    slow: config({ MCP_TEST_GATE: gate }), fast: config(),
    broken: { type: 'stdio', command: join(dir, 'missing-command') },
  } })
  try {
    assert.equal(runtime.loading, true)
    await until(() => runtime.getSchemas().some(s => s.function.name === 'mcp__fast__echo_tool'))
    assert.equal(runtime.loading, true)
    assert(!runtime.getSchemas().some(s => s.function.name === 'mcp__slow__echo_tool'))
    assert.match(runtime.instructions ?? '', /## fast/)
    assert.equal((await runtime.run('mcp__fast__echo_tool', { text: 'ready' })).ok, true)
    writeFileSync(gate, '')
    await runtime.ready
    assert.equal(runtime.loading, false)
    assert(runtime.getSchemas().some(s => s.function.name === 'mcp__slow__echo_tool'))
    assert.match(runtime.instructions ?? '', /## slow/)
    assert(runtime.failures.some(f => f.startsWith('broken:')))
  } finally {
    await runtime.close()
    rmSync(dir, { recursive: true, force: true })
  }
  assert.deepEqual(runtime.getSchemas(), [])
})

test('closing during initialization cancels the connection and terminates its child', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-close-'))
  const started = join(dir, 'started')
  const runtime = await createMcpRuntime({ background: true, servers: {
    slow: config({ MCP_TEST_GATE: join(dir, 'never'), MCP_TEST_STARTED: started }),
  } })
  try {
    await until(() => existsSync(started))
    const pid = Number(readFileSync(started, 'utf8'))
    await runtime.close()
    await runtime.ready
    assert.equal(runtime.loading, false)
    assert.deepEqual(runtime.getSchemas(), [])
    assert.deepEqual(runtime.failures, [])
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
    await runtime.close()
  } finally {
    await runtime.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('agent turns do not await background MCP, then reuse discovered tools and instructions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-agent-'))
  const gate = join(dir, 'gate')
  const requests: any[] = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    requests.push(JSON.parse(Buffer.concat(chunks).toString()))
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address === 'object')
  const runtime = await createMcpRuntime({ background: true, servers: {
    fixture: config({ MCP_TEST_GATE: gate }),
  } })
  const history: ChatMessage[] = [{ role: 'system', content: 'test' }]
  const turn = async () => {
    history.push({ role: 'user', content: 'hello' })
    for await (const _ of runAgent(history, {
      apiKey: 'test', model: 'test', provider: 'Qihuo GLM',
      baseURL: `http://127.0.0.1:${address.port}`, noCompact: true, mcp: runtime,
    })) { /* consume */ }
  }
  try {
    await turn()
    assert.equal(runtime.loading, true)
    writeFileSync(gate, '')
    await runtime.ready
    // A dynamically installed tool is session state: it disappears on reconnect.
    await runtime.run('mcp__fixture__install_dynamic', {})
    await runtime.refresh()
    let refreshes = 0
    runtime.refresh = async () => { refreshes++ }
    await turn()
    await turn()
    assert.equal(refreshes, 0)
    assert.equal(requests.length, 3)
    assert(!requests[0].tools.some((s: any) => s.function.name === 'mcp__fixture__echo_tool'))
    for (const request of requests.slice(1)) {
      assert(request.tools.some((s: any) => s.function.name === 'mcp__fixture__dynamic_tool'))
      assert.match(request.messages[0].content, /Use the echo tool/)
    }
    assert.equal(history[0].content, 'test')
    assert.equal((await runtime.run('mcp__fixture__dynamic_tool', { value: 'retained' })).ok, true)
  } finally {
    await runtime.close()
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(dir, { recursive: true, force: true })
  }
})

const listCount = (file: string) => existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').length : 0

test('ten consecutive model rounds reuse the initial tools/list result', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-ten-rounds-'))
  const log = join(dir, 'lists')
  const runtime = await createMcpRuntime({ servers: { fixture: config({ MCP_TEST_LIST_LOG: log }) } })
  let requests = 0
  const counts: number[] = []
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    requests++
    counts.push(listCount(log))
    const delta = requests < 10 ? { tool_calls: [{ index: 0, id: `call_${requests}`, type: 'function',
      function: { name: 'mcp__fixture__echo_tool', arguments: '{"text":"round"}' } }] } : { content: 'done' }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: requests < 10 ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`)
  })
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert(address && typeof address === 'object')
    const history: ChatMessage[] = [{ role: 'user', content: 'run ten rounds' }]
    for await (const _ of runAgent(history, {
      apiKey: 'test', model: 'test', provider: 'Qihuo GLM',
      baseURL: `http://127.0.0.1:${address.port}`, noCompact: true, mcp: runtime, maxSteps: 10,
    })) { /* consume */ }
    assert.equal(requests, 10)
    assert.deepEqual(counts, Array(10).fill(1))
    assert.equal(listCount(log), 1)
  } finally {
    await runtime.close()
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(dir, { recursive: true, force: true })
  }
})

test('notifications target one server; concurrent refreshes coalesce and failures retain the cache', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-refresh-'))
  const logA = join(dir, 'a'), logB = join(dir, 'b')
  const gate = join(dir, 'gate'), fail = join(dir, 'fail')
  const runtime = await createMcpRuntime({ servers: {
    a: config({ MCP_TEST_LIST_LOG: logA, MCP_TEST_LIST_GATE: gate, MCP_TEST_LIST_FAIL: fail }),
    b: config({ MCP_TEST_LIST_LOG: logB }),
  } })
  try {
    assert.equal(listCount(logA), 1)
    assert.equal(listCount(logB), 1)
    await runtime.run('mcp__a__install_dynamic', {})
    await until(() => runtime.getSchemas().some(s => s.function.name === 'mcp__a__dynamic_tool'))
    assert.equal(listCount(logA), 2)
    assert.equal(listCount(logB), 1)
    writeFileSync(gate, '')
    const requests = Array.from({ length: 10 }, () => runtime.refresh('a'))
    await until(() => listCount(logA) === 3)
    rmSync(gate)
    await Promise.all(requests)
    assert.equal(listCount(logA), 3)
    assert.equal(listCount(logB), 1)
    const successfulSchemas = runtime.getSchemas()
    writeFileSync(fail, '')
    await runtime.refresh('a')
    assert.deepEqual(runtime.getSchemas(), successfulSchemas)
    assert(runtime.failures.some(f => /a: MCP refresh failed/.test(f)))
    assert.equal((await runtime.run('mcp__a__dynamic_tool', { value: 'cached' })).ok, true)
    rmSync(fail)
    await runtime.refresh('a')
    assert.equal(listCount(logA), 5)
    await assert.rejects(runtime.refresh('missing'), /找不到已连接/)
  } finally {
    rmSync(gate, { force: true })
    await runtime.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a notification during discovery schedules a follow-up without losing the change', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-invalidate-'))
  const log = join(dir, 'lists'), gate = join(dir, 'gate')
  const runtime = await createMcpRuntime({ servers: {
    fixture: config({ MCP_TEST_LIST_LOG: log, MCP_TEST_LIST_GATE: gate }),
  } })
  try {
    writeFileSync(gate, '')
    const pending = runtime.refresh()
    await until(() => listCount(log) === 2)
    await runtime.run('mcp__fixture__install_dynamic', {})
    // Tool responses and notifications share the ordered stdio stream.
    rmSync(gate)
    await pending
    await until(() => listCount(log) === 3)
    assert(runtime.getSchemas().some(s => s.function.name === 'mcp__fixture__dynamic_tool'))
  } finally {
    rmSync(gate, { force: true })
    await runtime.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('TTL background discovery finds silent changes and stops on close', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-ttl-'))
  const log = join(dir, 'lists')
  const runtime = await createMcpRuntime({ refreshIntervalMs: 100, servers: {
    fixture: config({ MCP_TEST_LIST_LOG: log, MCP_TEST_SILENT: '1' }),
  } })
  try {
    await runtime.run('mcp__fixture__install_dynamic', {})
    await until(() => runtime.getSchemas().some(s => s.function.name === 'mcp__fixture__dynamic_tool'))
    assert(listCount(log) >= 2)
    await runtime.close()
    const closedCount = listCount(log)
    await setTimeout(220)
    assert.equal(listCount(log), closedCount)
    assert.deepEqual(runtime.getSchemas(), [])
  } finally {
    await runtime.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('concurrent tool retries reconnect and rediscover only the disconnected server', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-reconnect-'))
  const logA = join(dir, 'a'), logB = join(dir, 'b'), started = join(dir, 'pid')
  const runtime = await createMcpRuntime({ servers: {
    a: config({ MCP_TEST_LIST_LOG: logA, MCP_TEST_STARTED: started }),
    b: config({ MCP_TEST_LIST_LOG: logB }),
  } })
  try {
    const pid = Number(readFileSync(started, 'utf8'))
    process.kill(pid, 'SIGTERM')
    await until(() => {
      try { process.kill(pid, 0); return false } catch { return true }
    })
    const results = await Promise.all(Array.from({ length: 5 }, () => runtime.run('mcp__a__echo_tool', { text: 'retry' })))
    assert(results.every(result => result.ok), JSON.stringify(results))
    assert.equal(listCount(logA), 2)
    assert.equal(listCount(logB), 1)
  } finally {
    await runtime.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
