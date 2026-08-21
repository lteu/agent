import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import * as z from 'zod/v4'

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

await server.connect(new StdioServerTransport())
