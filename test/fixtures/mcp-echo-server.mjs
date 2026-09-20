import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import * as z from 'zod/v4'
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { setTimeout } from 'node:timers/promises'

const server = new McpServer(
  { name: 'ai-cli-test-mcp', version: '1.0.0' },
  { instructions: 'Use the echo tool for test messages.' },
)

server.registerResource(
  'test-guide',
  'memory://test-guide',
  { description: 'A test resource', mimeType: 'text/plain' },
  async uri => ({ contents: [{ uri: uri.toString(), text: 'resource body' }] }),
)

server.registerPrompt(
  'review',
  {
    description: 'Build a review prompt.',
    argsSchema: { target: z.string() },
  },
  async ({ target }) => ({
    description: `Review ${target}`,
    messages: [{ role: 'user', content: { type: 'text', text: `Please review ${target}` } }],
  }),
)

server.registerTool(
  'echo.tool',
  {
    description: 'Echo text and return a tiny image.',
    inputSchema: {
      text: z.string(),
      fail: z.boolean().optional(),
    },
  },
  async ({ text, fail }) => ({
    content: [
      { type: 'text', text: `echo: ${text}` },
      {
        type: 'image',
        mimeType: 'image/png',
        data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      },
    ],
    isError: fail === true,
  }),
)

let dynamicTool
server.registerTool(
  'install.dynamic',
  { description: 'Install a dynamic tool.', inputSchema: {} },
  async () => {
    if (!dynamicTool) {
      dynamicTool = server.registerTool(
        'dynamic.tool',
        { description: 'A dynamically registered tool.', inputSchema: { value: z.string() } },
        async ({ value }) => ({ content: [{ type: 'text', text: `dynamic: ${value}` }] }),
      )
    }
    return { content: [{ type: 'text', text: 'dynamic tool installed' }] }
  },
)

if (process.env.MCP_TEST_STARTED) writeFileSync(process.env.MCP_TEST_STARTED, String(process.pid))
while (process.env.MCP_TEST_GATE && !existsSync(process.env.MCP_TEST_GATE)) await setTimeout(10)
const transport = new StdioServerTransport()
const send = transport.send.bind(transport)
transport.send = message => {
  if (process.env.MCP_TEST_SILENT && message.method === 'notifications/tools/list_changed') return Promise.resolve()
  return send(message)
}
await server.connect(transport)
const onmessage = transport.onmessage
transport.onmessage = async message => {
  if (message.method === 'tools/list') {
    if (process.env.MCP_TEST_LIST_LOG) appendFileSync(process.env.MCP_TEST_LIST_LOG, 'list\n')
    while (process.env.MCP_TEST_LIST_GATE && existsSync(process.env.MCP_TEST_LIST_GATE)) await setTimeout(10)
    if (process.env.MCP_TEST_LIST_FAIL && existsSync(process.env.MCP_TEST_LIST_FAIL)) {
      await send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'test discovery failure' } })
      return
    }
  }
  onmessage?.(message)
}
