import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { WebSocketServer } from 'ws'
import * as z from 'zod/v4'
import {
  clearMcpOAuth,
  createMcpOAuthProvider,
  getMcpOAuthStatus,
  mcpAuthStoreExists,
} from '../src/mcp-auth.js'
import {
  addMcpServerConfig,
  buildMcpToolName,
  createMcpRuntime,
  expandMcpEnv,
  loadMcpConfiguration,
  mcpCallResultToToolResult,
  removeMcpServerConfig,
} from '../src/mcp.js'

test('project MCP config walks parents, lets closer files override, and preserves unrelated JSON', () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-mcp-config-'))
  const child = join(root, 'packages', 'demo')
  mkdirSync(child, { recursive: true })
  writeFileSync(join(root, '.mcp.json'), JSON.stringify({
    note: 'keep me',
    mcpServers: {
      shared: { command: 'root-command' },
      parentOnly: { type: 'http', url: 'https://example.com/mcp' },
    },
  }))
  writeFileSync(join(child, '.mcp.json'), JSON.stringify({
    mcpServers: { shared: { type: 'stdio', command: 'child-command', args: ['--ok'] } },
  }))

  const loaded = loadMcpConfiguration(child)
  assert.equal((loaded.servers.shared as any).command, 'child-command')
  assert.equal((loaded.servers.parentOnly as any).url, 'https://example.com/mcp')
  assert.equal(loaded.sources.shared.file, join(child, '.mcp.json'))

  addMcpServerConfig('added', { type: 'stdio', command: 'node' }, 'project', child)
  let childJson = JSON.parse(readFileSync(join(child, '.mcp.json'), 'utf8'))
  assert.equal(childJson.mcpServers.added.command, 'node')
  removeMcpServerConfig('added', 'project', child)
  childJson = JSON.parse(readFileSync(join(child, '.mcp.json'), 'utf8'))
  assert.equal(childJson.mcpServers.added, undefined)
})

test('MCP environment placeholders and long tool names are normalized deterministically', () => {
  const previous = process.env.AI_MCP_TEST_VALUE
  process.env.AI_MCP_TEST_VALUE = 'secret-value'
  try {
    assert.deepEqual(expandMcpEnv('${AI_MCP_TEST_VALUE}/${MISSING:-fallback}/${ABSENT}'), {
      value: 'secret-value/fallback/${ABSENT}',
      missing: ['ABSENT'],
    })
  } finally {
    if (previous === undefined) delete process.env.AI_MCP_TEST_VALUE
    else process.env.AI_MCP_TEST_VALUE = previous
  }

  assert.equal(buildMcpToolName('my server', 'echo.tool'), 'mcp__my_server__echo_tool')
  const long = buildMcpToolName('server'.repeat(20), 'tool'.repeat(20))
  assert.equal(long.length, 64)
  assert.equal(long, buildMcpToolName('server'.repeat(20), 'tool'.repeat(20)))
})

test('large and binary MCP results are persisted instead of silently discarded', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-mcp-output-'))
  const previous = process.env.AI_MCP_OUTPUT_DIR
  process.env.AI_MCP_OUTPUT_DIR = directory
  try {
    const result = mcpCallResultToToolResult({
      content: [
        { type: 'text', text: 'x'.repeat(110_000) },
        { type: 'audio', mimeType: 'audio/wav', data: Buffer.from('wave').toString('base64') },
      ],
    })
    assert.equal(result.ok, true)
    assert.match(result.output, /完整 MCP 结果已保存/)
    assert.match(result.output, /MCP 音频已保存/)
    const files = readdirSync(directory)
    assert(files.some(file => file.endsWith('.txt')))
    assert(files.some(file => file.endsWith('.wav')))
  } finally {
    if (previous === undefined) delete process.env.AI_MCP_OUTPUT_DIR
    else process.env.AI_MCP_OUTPUT_DIR = previous
  }
})

test('MCP OAuth provider persists client registration and tokens with logout support', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-mcp-auth-'))
  const previous = process.env.AI_MCP_AUTH_STORE
  process.env.AI_MCP_AUTH_STORE = join(directory, 'auth.json')
  const config = { type: 'http' as const, url: 'https://mcp.example.test/mcp' }
  try {
    const provider = createMcpOAuthProvider('remote', config)
    await provider.saveClientInformation({ client_id: 'registered-client' })
    await provider.saveCodeVerifier('verifier')
    await provider.saveTokens({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      token_type: 'Bearer',
      expires_in: 3600,
    })

    const reloaded = createMcpOAuthProvider('remote', config)
    assert.equal((await reloaded.clientInformation())?.client_id, 'registered-client')
    assert.equal((await reloaded.tokens())?.refresh_token, 'refresh-token')
    assert.equal(getMcpOAuthStatus('remote', config), 'authenticated')
    assert.equal(mcpAuthStoreExists(), true)

    const proxyProvider = createMcpOAuthProvider('proxy', {
      type: 'http',
      url: 'https://mcp.example.test/mcp',
    })
    assert.equal(
      (await proxyProvider.validateResourceURL(
        'https://mcp.example.test/mcp',
        'http://mcp.example.test',
      ))?.toString(),
      'https://mcp.example.test/',
    )
    await assert.rejects(
      proxyProvider.validateResourceURL(
        'https://mcp.example.test/mcp',
        'http://attacker.example.test',
      ),
      /does not match/,
    )

    clearMcpOAuth('remote', config)
    assert.equal(getMcpOAuthStatus('remote', config), 'not-authenticated')
  } finally {
    if (previous === undefined) delete process.env.AI_MCP_AUTH_STORE
    else process.env.AI_MCP_AUTH_STORE = previous
  }
})

test('stdio MCP tools are discovered, called, and return text plus model image content', async () => {
  const fixture = fileURLToPath(new URL('./fixtures/mcp-echo-server.mjs', import.meta.url))
  const runtime = await createMcpRuntime({
    cwd: process.cwd(),
    servers: {
      'fixture server': {
        type: 'stdio',
        command: process.execPath,
        args: [fixture],
      },
    },
  })

  try {
    assert.deepEqual(runtime.failures, [])
    assert.match(runtime.instructions ?? '', /Use the echo tool/)
    const echoSchema = runtime.schemas.find(schema => schema.function.name === 'mcp__fixture_server__echo_tool')
    assert(echoSchema)
    assert.equal((echoSchema.function.parameters as any).properties.text.type, 'string')
    assert(runtime.schemas.some(schema => schema.function.name === 'list_mcp_resources'))
    assert(runtime.schemas.some(schema => schema.function.name === 'read_mcp_resource'))
    assert(runtime.schemas.some(schema => schema.function.name === 'list_mcp_prompts'))
    assert(runtime.schemas.some(schema => schema.function.name === 'get_mcp_prompt'))

    const success = await runtime.run('mcp__fixture_server__echo_tool', { text: 'hello' })
    assert.equal(success.ok, true)
    assert.match(success.output, /echo: hello/)
    assert.equal(success.modelContent?.[0].mediaType, 'image/png')

    const failure = await runtime.run('mcp__fixture_server__echo_tool', { text: 'bad', fail: true })
    assert.equal(failure.ok, false)
    assert.equal(failure.error?.code, 'mcp_tool_error')
    assert.match(failure.output, /echo: bad/)

    const resources = await runtime.run('list_mcp_resources', { server: 'fixture server' })
    assert.equal(resources.ok, true)
    assert.match(resources.output, /memory:\/\/test-guide/)
    const resource = await runtime.run('read_mcp_resource', {
      server: 'fixture server',
      uri: 'memory://test-guide',
    })
    assert.equal(resource.ok, true)
    assert.match(resource.output, /resource body/)

    const prompts = await runtime.run('list_mcp_prompts', { server: 'fixture server' })
    assert.equal(prompts.ok, true)
    assert.match(prompts.output, /review/)
    const prompt = await runtime.run('get_mcp_prompt', {
      server: 'fixture server',
      name: 'review',
      arguments: { target: 'src/mcp.ts' },
    })
    assert.equal(prompt.ok, true)
    assert.match(prompt.output, /Please review src\/mcp\.ts/)

    const install = await runtime.run('mcp__fixture_server__install_dynamic', {})
    assert.equal(install.ok, true)
    await runtime.refresh()
    assert(runtime.getSchemas().some(schema => schema.function.name === 'mcp__fixture_server__echo_tool'))
    assert(runtime.getSchemas().some(schema => schema.function.name === 'mcp__fixture_server__dynamic_tool'))
    const dynamic = await runtime.run('mcp__fixture_server__dynamic_tool', { value: 'ready' })
    assert.equal(dynamic.ok, true)
    assert.match(dynamic.output, /dynamic: ready/)
  } finally {
    await runtime.close()
  }
})

test('Streamable HTTP MCP sends configured headers and calls discovered tools', async () => {
  const app = createMcpExpressApp()
  let sawHeader = false
  app.use('/mcp', (req, _res, next) => {
    if (req.headers.authorization === 'Bearer test-token') sawHeader = true
    next()
  })
  app.post('/mcp', async (req, res) => {
    const server = new McpServer({ name: 'http-fixture', version: '1.0.0' })
    server.registerTool('upper', {
      description: 'Uppercase text',
      inputSchema: { text: z.string() },
    }, async ({ text }) => ({ content: [{ type: 'text', text: text.toUpperCase() }] }))
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    await server.connect(transport)
    res.on('close', () => void server.close())
    await transport.handleRequest(req, res, req.body)
  })
  app.get('/mcp', (_req, res) => res.status(405).end())
  app.delete('/mcp', (_req, res) => res.status(405).end())

  const httpServer = await new Promise<ReturnType<typeof app.listen>>(resolveListen => {
    const listening = app.listen(0, () => resolveListen(listening))
  })
  const address = httpServer.address()
  assert(address && typeof address === 'object')

  const runtime = await createMcpRuntime({
    servers: {
      remote: {
        type: 'http',
        url: `http://127.0.0.1:${address.port}/mcp`,
        headers: { Authorization: 'Bearer test-token' },
      },
    },
  })
  try {
    assert.deepEqual(runtime.failures, [])
    assert.equal(runtime.schemas[0].function.name, 'mcp__remote__upper')
    const result = await runtime.run('mcp__remote__upper', { text: 'hello' })
    assert.equal(result.ok, true)
    assert.equal(result.output, 'HELLO')
    assert.equal(sawHeader, true)
  } finally {
    await runtime.close()
    await new Promise<void>((resolveClose, rejectClose) => {
      httpServer.close(error => error ? rejectClose(error) : resolveClose())
    })
  }
})

test('WebSocket MCP sends configured headers, discovers tools, and calls them', async () => {
  let sawHeader = false
  const websocketServer = new WebSocketServer({ port: 0 })
  websocketServer.on('connection', (socket, request) => {
    if (request.headers.authorization === 'Bearer websocket-token') sawHeader = true
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString()) as {
        jsonrpc: '2.0'
        id?: string | number
        method?: string
        params?: Record<string, unknown>
      }
      if (message.id === undefined) return
      let result: Record<string, unknown>
      if (message.method === 'initialize') {
        result = {
          protocolVersion: message.params?.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'websocket-fixture', version: '1.0.0' },
        }
      } else if (message.method === 'tools/list') {
        result = {
          tools: [{
            name: 'reverse',
            description: 'Reverse text',
            inputSchema: {
              type: 'object',
              properties: { text: { type: 'string' } },
              required: ['text'],
            },
          }],
        }
      } else if (message.method === 'tools/call') {
        const call = message.params as { arguments?: { text?: string } }
        result = {
          content: [{ type: 'text', text: [...(call.arguments?.text ?? '')].reverse().join('') }],
        }
      } else {
        socket.send(JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: `Unknown method ${message.method}` },
        }))
        return
      }
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
    })
  })
  await new Promise<void>(resolveListening => websocketServer.once('listening', resolveListening))
  const address = websocketServer.address()
  assert(address && typeof address === 'object')

  const runtime = await createMcpRuntime({
    servers: {
      realtime: {
        type: 'ws',
        url: `ws://127.0.0.1:${address.port}`,
        headers: { Authorization: 'Bearer websocket-token' },
      },
    },
  })
  try {
    assert.deepEqual(runtime.failures, [])
    assert(runtime.getSchemas().some(schema => schema.function.name === 'mcp__realtime__reverse'))
    const result = await runtime.run('mcp__realtime__reverse', { text: 'stressed' })
    assert.equal(result.ok, true)
    assert.equal(result.output, 'desserts')
    assert.equal(sawHeader, true)
  } finally {
    await runtime.close()
    await new Promise<void>(resolveClose => websocketServer.close(() => resolveClose()))
  }
})
