import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import http from 'node:http'
import readline from 'node:readline'

const MCP_PREFIX = 'mcp__local_agent__'
const FINAL_MARKER = '<LOCAL_AGENT_FINAL>'
const MAX_PROTOCOL_CONTINUES = 2
const REMOTE_BUILTIN_TOOLS = new Set(['WebSearch', 'WebFetch'])
const REMOTE_BUILTIN_TOOL_LIST = [...REMOTE_BUILTIN_TOOLS].join(',')

function runMcpServer() {
  const tools = JSON.parse(
    Buffer.from(process.env.AI_CLAUDE_MCP_TOOLS_B64 ?? '', 'base64').toString('utf8') || '[]',
  )
  const rl = readline.createInterface({ input: process.stdin })
  const send = value => process.stdout.write(`${JSON.stringify(value)}\n`)
  rl.on('line', line => {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (message.method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'local-agent-tool-capture', version: '1.0.0' },
        },
      })
      return
    }
    if (message.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: message.id, result: { tools } })
      return
    }
    if (message.method === 'ping') {
      send({ jsonrpc: '2.0', id: message.id, result: {} })
      return
    }
    if (message.method === 'tools/call') {
      // Intentionally do not answer. The parent gateway captures the assistant
      // tool_use event and terminates this Claude process before remote execution.
      return
    }
    if (message.id != null && !message.method?.startsWith('notifications/')) {
      send({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: 'Method not found' },
      })
    }
  })
}

if (process.argv[2] === '--mcp') {
  runMcpServer()
} else {
  runGateway()
}

function runGateway() {
  const host = process.env.AI_CLAUDE_GATEWAY_HOST ?? '127.0.0.1'
  const port = Number(process.env.AI_CLAUDE_GATEWAY_PORT ?? 8791)
  const claudeBin = process.env.AI_CLAUDE_BIN ?? '/usr/local/bin/claude'
  const claudeCwd = process.env.AI_CLAUDE_CWD ?? '/root'
  const selfPath = new URL(import.meta.url).pathname
  const maxBodyBytes = Number(process.env.AI_CLAUDE_MAX_BODY_BYTES ?? 8 * 1024 * 1024)
  const maxConcurrent = Number(process.env.AI_CLAUDE_MAX_CONCURRENT ?? 4)
  const configuredIdleTimeoutMs = Number(process.env.AI_CLAUDE_GATEWAY_IDLE_TIMEOUT_MS)
  const requestIdleTimeoutMs =
    Number.isFinite(configuredIdleTimeoutMs) && configuredIdleTimeoutMs >= 30_000
      ? Math.floor(configuredIdleTimeoutMs)
      : 900_000
  const startedAt = new Date().toISOString()
  let active = 0
  let completed = 0
  let remoteWebSearches = 0
  let remoteWebFetches = 0

  const systemPrompt = `You are the reasoning backend for an autonomous AI agent running on the
user's LOCAL computer. The JSON input contains the complete conversation. Follow its system and
user messages. Tools whose names begin with "${MCP_PREFIX}" are proxies for LOCAL tools.

If the user message is exactly MCP_GATEWAY_HANDSHAKE, reply exactly READY without calling tools.

When local inspection or action is required, call the appropriate MCP tool. The gateway will stop
this remote process before tool execution, run it on the local computer, and provide the result in
the next JSON conversation. Never claim a local tool is unavailable. Never guess file contents or
tool results. If the latest tool-role message already contains the needed result, use it and
continue.

For public online research, prefer the built-in WebSearch and WebFetch tools. They run inside this
remote Claude Code session and do not expose the user's local HOME, SSH credentials, or sandbox
network address. Use the proxied local web_fetch or run_bash internet access only when the remote
built-in tools cannot complete the request. No other remote built-in tools are allowed.

A text-only response ends the LOCAL agent turn immediately. Therefore never return a progress-only
message that merely says you will start, inspect, search, calculate, write, or continue later. In
the same response, either call the required local tool, or provide the completed, self-contained
answer. Prefix a genuinely complete text-only answer with exactly ${FINAL_MARKER}; the gateway
removes this protocol marker before returning it to the user. Do not use the marker when work still
remains.`

  function json(res, status, body) {
    const payload = `${JSON.stringify(body)}\n`
    res.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
    })
    res.end(payload)
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      req.on('data', chunk => {
        size += chunk.length
        if (size > maxBodyBytes) {
          reject(new Error('request body too large'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.once('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))))
      req.once('error', reject)
    })
  }

  function mcpTools(openAITools) {
    return openAITools.map(tool => ({
      name: tool.function.name,
      description: tool.function.description ?? '',
      inputSchema: tool.function.parameters ?? { type: 'object', properties: {} },
    }))
  }

  function callClaude(body, signal) {
    return new Promise((resolve, reject) => {
      const tools = mcpTools(Array.isArray(body.tools) ? body.tools : [])
      const args = [
        '--print',
        '--verbose',
        '--output-format',
        'stream-json',
        '--input-format',
        'stream-json',
        '--include-partial-messages',
        '--no-session-persistence',
        '--disable-slash-commands',
        '--model',
        typeof body.model === 'string' && body.model ? body.model : 'sonnet',
        '--system-prompt',
        systemPrompt,
      ]
      if (tools.length) {
        const toolsBase64 = Buffer.from(JSON.stringify(tools)).toString('base64')
        const mcpConfig = {
          mcpServers: {
            local_agent: {
              command: '/usr/bin/node',
              args: [selfPath, '--mcp'],
              env: {
                AI_CLAUDE_MCP_TOOLS_B64: toolsBase64,
              },
            },
          },
        }
        args.push(
          '--mcp-config',
          JSON.stringify(mcpConfig),
          '--strict-mcp-config',
        )
      }
      args.push(
        '--tools',
        REMOTE_BUILTIN_TOOL_LIST,
        '--allowedTools',
        REMOTE_BUILTIN_TOOL_LIST,
        '--permission-mode',
        'dontAsk',
      )
      args.push('--')

      const child = spawn(claudeBin, args, {
        cwd: claudeCwd,
        env: {
          HOME: '/root',
          USER: 'root',
          LOGNAME: 'root',
          PATH: '/usr/local/bin:/usr/bin:/bin',
          LANG: 'C.UTF-8',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      const stderr = []
      let settled = false
      let handshakeDone = false
      let handshakeTurnFinishing = false
      let remoteToolTurnFinishing = false
      let pendingText = null
      let pendingToolCompletion = null
      let protocolContinues = 0
      const usage = {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      }
      const addUsage = value => {
        for (const key of Object.keys(usage)) {
          const count = Number(value?.[key])
          if (Number.isFinite(count) && count >= 0) usage[key] += count
        }
      }
      const terminateChild = () => {
        if (child.exitCode != null || child.signalCode != null) return
        child.kill('SIGTERM')
        const forceKill = setTimeout(() => {
          if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL')
        }, 5_000)
        forceKill.unref()
      }
      let idleTimer
      const resetIdleTimer = () => {
        clearTimeout(idleTimer)
        idleTimer = setTimeout(() => {
          const error = new Error(
            `Claude gateway request timed out after ${requestIdleTimeoutMs}ms without output`,
          )
          error.code = 'GATEWAY_TIMEOUT'
          fail(error)
        }, requestIdleTimeoutMs)
        idleTimer.unref()
      }
      const finish = value => {
        if (settled) return
        settled = true
        clearTimeout(idleTimer)
        signal?.removeEventListener('abort', onAbort)
        const diagnostic = Buffer.concat(stderr).toString('utf8').trim()
        if (diagnostic) console.error(`claude stderr: ${diagnostic.slice(0, 2000)}`)
        terminateChild()
        resolve(value)
      }
      const fail = error => {
        if (settled) return
        settled = true
        clearTimeout(idleTimer)
        signal?.removeEventListener('abort', onAbort)
        terminateChild()
        reject(error)
      }
      const onAbort = () => fail(signal.reason ?? new DOMException('Client disconnected', 'AbortError'))
      if (signal?.aborted) {
        onAbort()
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      child.stderr.on('data', chunk => stderr.push(chunk))
      const lines = readline.createInterface({ input: child.stdout })
      lines.on('line', resetIdleTimer)
      resetIdleTimer()
      const sendConversation = () => {
        child.stdin.write(
          `${JSON.stringify({
            type: 'user',
            message: {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    messages: Array.isArray(body.messages) ? body.messages : [],
                  }),
                },
              ],
            },
          })}\n`,
        )
      }
      const continueIncompleteResponse = () => {
        protocolContinues += 1
        pendingText = null
        pendingToolCompletion = null
        child.stdin.write(
          `${JSON.stringify({
            type: 'user',
            message: {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text:
                    'PROTOCOL_CONTINUE: Your previous response was only a progress update or did ' +
                    `not mark a completed answer with ${FINAL_MARKER}. Do the promised work now. ` +
                    'Call the required local tool in this response. If the task is already fully ' +
                    `complete, return the self-contained final answer prefixed with ${FINAL_MARKER}.`,
                },
              ],
            },
          })}\n`,
        )
      }
      lines.on('line', line => {
        let event
        try {
          event = JSON.parse(line)
        } catch {
          return
        }
        if (event.type !== 'assistant' || !Array.isArray(event.message?.content)) return
        if (!handshakeDone) {
          handshakeDone = true
          handshakeTurnFinishing = true
          sendConversation()
          return
        }
        const content = event.message.content
        const toolBlocks = content.filter(
          block => block.type === 'tool_use' && block.name?.startsWith(MCP_PREFIX),
        )
        const remoteToolBlocks = content.filter(
          block => block.type === 'tool_use' && REMOTE_BUILTIN_TOOLS.has(block.name),
        )
        const unsupportedToolBlocks = content.filter(
          block =>
            block.type === 'tool_use' &&
            !block.name?.startsWith(MCP_PREFIX) &&
            !REMOTE_BUILTIN_TOOLS.has(block.name),
        )
        if (unsupportedToolBlocks.length) {
          fail(
            new Error(
              `Claude attempted unsupported remote tools: ${unsupportedToolBlocks
                .map(block => block.name ?? 'unknown')
                .join(', ')}`,
            ),
          )
          return
        }
        if (toolBlocks.length) {
          pendingText = null
          pendingToolCompletion = {
            content: content
              .filter(block => block.type === 'text')
              .map(block => block.text)
              .join(''),
            toolCalls: toolBlocks.map(block => ({
              id: block.id ?? `call_${randomUUID().replaceAll('-', '')}`,
              type: 'function',
              function: {
                name: block.name.slice(MCP_PREFIX.length),
                arguments: JSON.stringify(block.input ?? {}),
              },
            })),
          }
          return
        }
        if (remoteToolBlocks.length) {
          for (const block of remoteToolBlocks) {
            if (block.name === 'WebSearch') remoteWebSearches += 1
            if (block.name === 'WebFetch') remoteWebFetches += 1
          }
          remoteToolTurnFinishing = true
          pendingText = null
          pendingToolCompletion = null
          return
        }
        pendingToolCompletion = null
        pendingText = content
          .filter(block => block.type === 'text')
          .map(block => block.text)
          .join('')
      })
      lines.on('line', line => {
        let event
        try {
          event = JSON.parse(line)
        } catch {
          return
        }
        if (event.type !== 'stream_event' || event.event?.type !== 'message_delta') return
        addUsage(event.event.usage)
        const stopReason = event.event.delta?.stop_reason
        if (!stopReason || settled) return
        if (handshakeTurnFinishing) {
          handshakeTurnFinishing = false
          return
        }
        if (remoteToolTurnFinishing && stopReason === 'tool_use') {
          remoteToolTurnFinishing = false
          pendingText = null
          pendingToolCompletion = null
          return
        }

        if (stopReason === 'tool_use') {
          if (!pendingToolCompletion) {
            fail(new Error('Claude requested a tool without a capturable MCP tool block'))
            return
          }
          finish({ ...pendingToolCompletion, usage: { ...usage } })
          return
        }
        const completionText = pendingText ?? ''
        if (stopReason === 'max_tokens') {
          finish({
            content: completionText,
            toolCalls: [],
            finishReason: 'length',
            usage: { ...usage },
          })
          return
        }
        if (stopReason !== 'end_turn') {
          fail(new Error(`Claude stopped unexpectedly: ${stopReason}`))
          return
        }

        // An empty end_turn is valid. Forward it to the local agent engine,
        // whose bounded empty-response recovery can retry the turn. Treating
        // it as a gateway failure turns a recoverable response into HTTP 502.
        if (!completionText.trim()) {
          finish({
            content: '',
            toolCalls: [],
            finishReason: 'stop',
            usage: { ...usage },
          })
          return
        }

        const markerPattern = /^\s*<LOCAL_AGENT_FINAL>\s*/
        if (markerPattern.test(completionText)) {
          finish({
            content: completionText.replace(markerPattern, ''),
            toolCalls: [],
            finishReason: 'stop',
            usage: { ...usage },
          })
          return
        }
        if (protocolContinues < MAX_PROTOCOL_CONTINUES) {
          continueIncompleteResponse()
          return
        }
        fail(
          new Error(
            `Claude returned ${MAX_PROTOCOL_CONTINUES + 1} text responses without completing the task`,
          ),
        )
      })
      child.once('error', fail)
      child.once('exit', code => {
        if (!settled) {
          fail(
            new Error(
              `claude exited ${code}: ${Buffer.concat(stderr).toString('utf8').slice(0, 500)}`,
            ),
          )
        }
      })
      child.stdin.write(
        `${JSON.stringify({
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'MCP_GATEWAY_HANDSHAKE' }],
          },
        })}\n`,
      )
    })
  }

  function choiceFor(completion) {
    return {
      message: {
        role: 'assistant',
        content: completion.content,
        ...(completion.toolCalls.length ? { tool_calls: completion.toolCalls } : {}),
      },
      finish_reason: completion.toolCalls.length
        ? 'tool_calls'
        : completion.finishReason ?? 'stop',
    }
  }

  function openAIUsage(usage = {}) {
    const input = Number(usage.input_tokens) || 0
    const output = Number(usage.output_tokens) || 0
    const cacheRead = Number(usage.cache_read_input_tokens) || 0
    const cacheCreation = Number(usage.cache_creation_input_tokens) || 0
    const prompt = input + cacheRead + cacheCreation
    return {
      prompt_tokens: prompt,
      completion_tokens: output,
      total_tokens: prompt + output,
      input_tokens: input,
      output_tokens: output,
      cache_read_input_tokens: cacheRead,
      cache_creation_input_tokens: cacheCreation,
      prompt_tokens_details: { cached_tokens: cacheRead },
    }
  }

  function startStream(res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    res.flushHeaders()
    res.write(': connected\n\n')
  }

  function writeStream(res, choice, usage) {
    const delta = {
      role: 'assistant',
      ...(choice.message.content ? { content: choice.message.content } : {}),
      ...(choice.message.tool_calls
        ? {
            tool_calls: choice.message.tool_calls.map((call, index) => ({
              index,
              id: call.id,
              type: 'function',
              function: call.function,
            })),
          }
        : {}),
    }
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
    res.write(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason }] })}\n\n`,
    )
    res.write(`data: ${JSON.stringify({ choices: [], usage })}\n\n`)
    res.end('data: [DONE]\n\n')
  }

  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      json(res, 200, {
        ok: true,
        service: 'ai-claude-gateway',
        mode: 'claude-code-mcp-capture',
        started_at: startedAt,
        active,
        completed,
        max_concurrent: maxConcurrent,
        request_idle_timeout_ms: requestIdleTimeoutMs,
        remote_web_searches: remoteWebSearches,
        remote_web_fetches: remoteWebFetches,
      })
      return
    }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      json(res, 404, { error: { message: 'not found' } })
      return
    }
    if (active >= maxConcurrent) {
      json(res, 429, { error: { message: 'Claude gateway is busy' } })
      return
    }

    active += 1
    let heartbeat
    let clientAbort
    try {
      const body = await readBody(req)
      if (body.stream) {
        clientAbort = new AbortController()
        const abortOnDisconnect = () => {
          if (!res.writableEnded) {
            clientAbort.abort(new DOMException('Client disconnected', 'AbortError'))
          }
        }
        req.once('aborted', abortOnDisconnect)
        res.once('close', abortOnDisconnect)
        startStream(res)
        heartbeat = setInterval(() => {
          if (!res.writableEnded && !res.destroyed) res.write(': keep-alive\n\n')
        }, 15_000)
        heartbeat.unref()
      }

      const completion = await callClaude(body, clientAbort?.signal)
      const choice = choiceFor(completion)
      const usage = openAIUsage(completion.usage)
      completed += 1
      if (body.stream) writeStream(res, choice, usage)
      else {
        json(res, 200, {
          id: `chatcmpl_${randomUUID().replaceAll('-', '')}`,
          object: 'chat.completion',
          model: body.model ?? 'sonnet',
          choices: [{ index: 0, ...choice }],
          usage,
        })
      }
    } catch (error) {
      if (error?.name !== 'AbortError') {
        console.error(`gateway request failed: ${error?.stack ?? error?.message ?? String(error)}`)
      }
      if (res.headersSent) {
        if (!res.destroyed) res.destroy(error)
      } else {
        json(res, error?.code === 'GATEWAY_TIMEOUT' ? 504 : 502, {
          error: { message: error?.message ?? String(error) },
        })
      }
    } finally {
      clearInterval(heartbeat)
      active -= 1
    }
  })

  server.listen(port, host, () => {
    console.log(`ai-claude MCP capture gateway listening on http://${host}:${port}`)
  })
}
