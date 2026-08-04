import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, renameSync, rmSync, statSync } from 'node:fs'
import http from 'node:http'
import readline from 'node:readline'

const MCP_PREFIX = 'mcp__local_agent__'
const REMOTE_BUILTIN_TOOLS = new Set(['WebSearch', 'WebFetch'])
const REMOTE_BUILTIN_TOOL_LIST = [...REMOTE_BUILTIN_TOOLS].join(',')

const RATE_LIMIT_NAMES = {
  five_hour: 'session limit',
  seven_day: 'weekly limit',
  seven_day_opus: 'Opus limit',
  seven_day_sonnet: 'Sonnet limit',
  overage: 'extra usage limit',
}

function rateLimitError(info = {}) {
  const name = RATE_LIMIT_NAMES[info.rateLimitType] ?? 'session limit'
  const reset = Number(info.resetsAt)
  const resetText = Number.isFinite(reset)
    ? ` Resets at ${new Date(reset * 1000).toISOString()}.`
    : ''
  const error = new Error(`You've hit your ${name}.${resetText}`)
  error.code = 'CLAUDE_RATE_LIMIT'
  return error
}

function resultEventError(event) {
  if (event?.type !== 'result' || event.is_error !== true) return undefined
  const errors = Array.isArray(event.errors)
    ? event.errors.filter(value => typeof value === 'string' && value.trim())
    : []
  const useful = errors.find(value => !value.startsWith('[ede_diagnostic]'))
  const error = new Error(useful ?? `Claude stopped with ${event.subtype ?? 'an execution error'}`)
  error.code = 'CLAUDE_EXECUTION_ERROR'
  return error
}

const GATEWAY_EVENT_LOG =
  process.env.AI_CLAUDE_GATEWAY_EVENT_LOG ?? '/var/log/ai-claude-gateway/events.jsonl'
const GATEWAY_EVENT_LOG_MAX_BYTES = 25 * 1024 * 1024

function logGatewayEvent(requestId, event, details = {}) {
  try {
    if (
      existsSync(GATEWAY_EVENT_LOG) &&
      statSync(GATEWAY_EVENT_LOG).size >= GATEWAY_EVENT_LOG_MAX_BYTES
    ) {
      rmSync(`${GATEWAY_EVENT_LOG}.1`, { force: true })
      renameSync(GATEWAY_EVENT_LOG, `${GATEWAY_EVENT_LOG}.1`)
    }
    appendFileSync(
      GATEWAY_EVENT_LOG,
      `${JSON.stringify({
        time: new Date().toISOString(),
        pid: process.pid,
        requestId,
        event,
        ...details,
      })}\n`,
    )
  } catch {
    // Diagnostics must never break the relay.
  }
}

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
  const remoteSessions = new Map()
  const activeRemoteSessions = new Set()
  const remoteSessionTtlMs = 24 * 60 * 60 * 1000

  const systemPrompt = `You are the reasoning backend for an autonomous AI agent running on the
user's LOCAL computer. The first JSON input contains the authoritative conversation. On resumed
steps, LOCAL_AGENT_RESUME_UPDATE appends only new information to this same session. Follow all
system and user messages. Tools whose names begin with "${MCP_PREFIX}" are proxies for LOCAL tools.

Claude Code may record a permission-denied tool_result when the gateway stops a process after
capturing a LOCAL proxy tool_use. That denial is only a transport artifact: the gateway deliberately
does not execute local tools remotely. On a resumed step, LOCAL_AGENT_RESUME_UPDATE contains the
authoritative results produced on the user's computer. Always use those results and do not retry the
same operation because of the earlier permission-denied artifact.

If the user message is exactly MCP_GATEWAY_HANDSHAKE, reply exactly READY without calling tools.

When local inspection or action is required, call the appropriate MCP tool. The gateway will stop
this remote process before tool execution, run it on the local computer, and provide the result in
the next JSON conversation. Never claim a local tool is unavailable. Never guess file contents or
tool results. If the latest tool-role message already contains the needed result, use it and
continue.

When the user asks to inspect or analyze a screenshot/image, call the proxied view_image tool and
use the actual image block returned in LOCAL_AGENT_IMAGE_RESULT. Never read an image with read_file,
install OCR as a substitute, or infer unseen pixels from the filename or user description. If
view_image fails, do not make image-dependent edits until visual evidence is available.

For public online research, prefer the built-in WebSearch and WebFetch tools. They run inside this
remote Claude Code session and do not expose the user's local HOME, SSH credentials, or sandbox
network address. Use the proxied local web_fetch or run_bash internet access only when the remote
built-in tools cannot complete the request. No other remote built-in tools are allowed.
Conversation text enclosed in <remote_web_research> is a preserved result from a previous remote
WebSearch/WebFetch round. Reuse that evidence instead of repeating the same research after a local
tool call.

During multi-step work, keep the user informed when a meaningful finding changes or confirms the
next step. Put one concise, factual progress sentence in the same assistant response as the next
tool call, for example: "Found exact snapshots for both dates. Let me pull the menu content from
each." Do not narrate every routine action, repeat tool parameters, or emit filler such as "I am
working on it." A progress sentence is not a final answer.

A text-only response ends the LOCAL agent turn immediately. Therefore never return a progress-only
message that merely says you will start, inspect, search, calculate, write, or continue later. In
the same response, either call the required local tool, or provide the completed, self-contained
answer.`

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

  function remoteSessionFor(body) {
    const value = body?.ai_remote_session
    if (value == null) return undefined
    if (
      typeof value.id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.id) ||
      !['start', 'resume'].includes(value.mode) ||
      !Number.isInteger(value.step) ||
      value.step < 0 ||
      (value.mode === 'start' && value.step !== 0) ||
      (value.mode === 'resume' && value.step < 1)
    ) {
      throw Object.assign(new Error('Invalid ai_remote_session request'), {
        code: 'REMOTE_SESSION_INVALID',
      })
    }
    return { id: value.id, mode: value.mode, step: value.step }
  }

  function pruneRemoteSessions() {
    const cutoff = Date.now() - remoteSessionTtlMs
    for (const [id, state] of remoteSessions) {
      if (state.updatedAt < cutoff && !activeRemoteSessions.has(id)) remoteSessions.delete(id)
    }
  }

  function acquireRemoteSession(session, messages) {
    if (!session) return
    pruneRemoteSessions()
    if (activeRemoteSessions.has(session.id)) {
      throw Object.assign(new Error('Remote Claude session already has an in-flight request'), {
        code: 'REMOTE_SESSION_BUSY',
      })
    }
    const state = remoteSessions.get(session.id)
    if (session.mode === 'start' && state) {
      throw Object.assign(new Error('Remote Claude session id has already been started'), {
        code: 'REMOTE_SESSION_STALE',
      })
    }
    // State may be absent after a gateway restart while Claude's persisted session still exists.
    if (session.mode === 'resume' && state && state.lastStep !== session.step - 1) {
      throw Object.assign(new Error('Remote Claude session step is stale or out of order'), {
        code: 'REMOTE_SESSION_STALE',
      })
    }
    if (session.mode === 'resume' && state?.pendingToolUseIds?.length) {
      const submitted = new Set(
        (Array.isArray(messages) ? messages : [])
          .filter(message => message?.role === 'tool' && typeof message.tool_call_id === 'string')
          .map(message => message.tool_call_id),
      )
      if (
        submitted.size !== state.pendingToolUseIds.length ||
        state.pendingToolUseIds.some(id => !submitted.has(id))
      ) {
        throw Object.assign(new Error('Resume tool results do not match pending tool_use ids'), {
          code: 'REMOTE_SESSION_INVALID',
        })
      }
    }
    activeRemoteSessions.add(session.id)
  }

  function releaseRemoteSession(session, completedStep, pendingToolUseIds = []) {
    if (!session) return
    activeRemoteSessions.delete(session.id)
    if (completedStep) {
      remoteSessions.set(session.id, {
        lastStep: session.step,
        pendingToolUseIds,
        updatedAt: Date.now(),
      })
    }
  }

  function localImageBlocks(message) {
    if (!Array.isArray(message?.ai_local_tool_content)) return []
    return message.ai_local_tool_content.filter(
      block =>
        block?.type === 'image' &&
        ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(block.mediaType) &&
        typeof block.data === 'string' &&
        block.data.length > 0,
    )
  }

  function imageMessageBlocks(attachments) {
    return attachments.flatMap(attachment =>
      attachment.images.flatMap((image, index) => [
        {
          type: 'text',
          text:
            `LOCAL_AGENT_IMAGE_RESULT tool_use_id=${attachment.toolUseId} ` +
            `image=${index + 1}/${attachment.images.length}. ` +
            'The next content block is the authoritative local image. Analyze its actual pixels; ' +
            'do not use OCR installation or infer the image from its filename.',
        },
        {
          type: 'image',
          source: { type: 'base64', media_type: image.mediaType, data: image.data },
        },
      ]),
    )
  }

  function initialConversationInput(messages) {
    const attachments = []
    const sanitizedMessages = (Array.isArray(messages) ? messages : []).map(message => {
      const images = localImageBlocks(message)
      if (images.length) {
        attachments.push({ toolUseId: message.tool_call_id ?? 'unknown', images })
      }
      const { ai_local_tool_content: _content, ...sanitized } = message ?? {}
      return images.length
        ? {
            ...sanitized,
            ai_local_images: images.map(image => ({ media_type: image.mediaType })),
          }
        : sanitized
    })
    return [
      { type: 'text', text: JSON.stringify({ messages: sanitizedMessages }) },
      ...imageMessageBlocks(attachments),
    ]
  }

  function resumeInput(messages) {
    const updates = []
    const attachments = []
    const toolNames = new Map()
    for (const message of Array.isArray(messages) ? messages : []) {
      if (message?.role !== 'assistant' || !Array.isArray(message.tool_calls)) continue
      for (const call of message.tool_calls) {
        if (typeof call?.id === 'string') toolNames.set(call.id, call.function?.name ?? 'unknown')
      }
    }
    for (const message of Array.isArray(messages) ? messages : []) {
      if (message?.role === 'assistant') continue
      if (message?.role === 'tool') {
        if (typeof message.tool_call_id !== 'string' || !message.tool_call_id) {
          throw Object.assign(new Error('Resume tool result is missing tool_call_id'), {
            code: 'REMOTE_SESSION_INVALID',
          })
        }
        const images = localImageBlocks(message)
        updates.push({
          type: 'local_tool_result',
          tool_use_id: message.tool_call_id,
          tool_name: toolNames.get(message.tool_call_id) ?? 'unknown',
          content: typeof message.content === 'string' ? message.content : '',
          ...(images.length
            ? { images: images.map(image => ({ media_type: image.mediaType })) }
            : {}),
        })
        if (images.length) attachments.push({ toolUseId: message.tool_call_id, images })
        continue
      }
      if ((message?.role === 'user' || message?.role === 'system') && typeof message.content === 'string') {
        if (message.content) updates.push({ type: message.role, content: message.content })
      }
    }
    if (!updates.length) {
      throw Object.assign(new Error('Resume request contains no new user or tool result content'), {
        code: 'REMOTE_SESSION_INVALID',
      })
    }
    return {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              'LOCAL_AGENT_RESUME_UPDATE\n' +
              'These are authoritative incremental updates from the local agent. Use them to continue; ' +
              'do not repeat completed local calls.\n' +
              JSON.stringify(updates),
          },
          ...imageMessageBlocks(attachments),
        ],
      },
    }
  }

  function callClaude(
    body,
    remoteSession,
    signal,
    onProgress = () => {},
    onUsage = () => {},
    onTrace = () => {},
  ) {
    return new Promise((resolve, reject) => {
      const tools = mcpTools(Array.isArray(body.tools) ? body.tools : [])
      const localToolNames = new Set(tools.map(tool => tool.name))
      const args = [
        '--print',
        '--verbose',
        '--output-format',
        'stream-json',
        '--input-format',
        'stream-json',
        '--include-partial-messages',
        '--disable-slash-commands',
      ]
      if (remoteSession) {
        args.push(remoteSession.mode === 'start' ? '--session-id' : '--resume', remoteSession.id)
      } else {
        args.push('--no-session-persistence')
      }
      args.push(
        '--model',
        typeof body.model === 'string' && body.model ? body.model : 'sonnet',
        '--system-prompt',
        systemPrompt,
      )
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

      const childEnv = {
        HOME: '/root',
        USER: 'root',
        LOGNAME: 'root',
        PATH: '/usr/local/bin:/usr/bin:/bin',
        LANG: 'C.UTF-8',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      }

      onTrace({
        direction: 'gateway',
        kind: 'spawn',
        session: remoteSession,
        data: { executable: claudeBin, cwd: claudeCwd, args, env: childEnv },
      })

      const child = spawn(claudeBin, args, {
        cwd: claudeCwd,
        env: childEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      const stderr = []
      let settled = false
      let handshakeDone = remoteSession?.mode === 'resume'
      let handshakeTurnFinishing = false
      let remoteToolTurnFinishing = false
      let pendingText = null
      let pendingToolCompletion = null
      const pendingRemoteTools = new Map()
      const emittedThinking = new Set()
      const remoteResearch = []
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
      const writeClaudeInput = (label, message) => {
        onTrace({
          direction: 'gateway->claude',
          kind: 'stdin',
          label,
          session: remoteSession,
          data: message,
        })
        child.stdin.write(`${JSON.stringify(message)}\n`)
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
        onTrace({
          direction: 'gateway',
          kind: 'completion',
          session: remoteSession,
          data: value,
        })
        terminateChild()
        resolve(value)
      }
      const fail = error => {
        if (settled) return
        settled = true
        clearTimeout(idleTimer)
        signal?.removeEventListener('abort', onAbort)
        onTrace({
          direction: 'gateway',
          kind: 'completion',
          session: remoteSession,
          data: {
            failed: true,
            error: { name: error?.name, code: error?.code, message: error?.message ?? String(error) },
          },
        })
        terminateChild()
        reject(error)
      }
      const onAbort = () => fail(signal.reason ?? new DOMException('Client disconnected', 'AbortError'))
      if (signal?.aborted) {
        onAbort()
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      child.stderr.on('data', chunk => {
        stderr.push(chunk)
        onTrace({
          direction: 'claude->gateway',
          kind: 'stderr',
          session: remoteSession,
          data: chunk.toString('utf8'),
        })
      })
      const lines = readline.createInterface({ input: child.stdout })
      lines.on('line', line => {
        onTrace({
          direction: 'claude->gateway',
          kind: 'stdout',
          session: remoteSession,
          data: line,
        })
      })
      resetIdleTimer()
      const sendConversation = () => {
        writeClaudeInput('initial-conversation', {
          type: 'user',
          message: {
            role: 'user',
            content: initialConversationInput(body.messages),
          },
        })
      }
      lines.on('line', line => {
        let event
        try {
          event = JSON.parse(line)
        } catch {
          return
        }
        // Claude Code emits subscription limits as dedicated SDK events. They
        // are not assistant text and were previously ignored while still
        // keeping the gateway idle timer alive indefinitely.
        if (event.type === 'rate_limit_event') {
          if (event.rate_limit_info?.status === 'rejected') {
            fail(rateLimitError(event.rate_limit_info))
          }
          return
        }
        if (event.type === 'assistant' && event.error) {
          const error = event.error === 'rate_limit'
            ? rateLimitError()
            : Object.assign(new Error(`Claude API error: ${event.error}`), {
                code: 'CLAUDE_API_ERROR',
              })
          fail(error)
          return
        }
        const resultError = resultEventError(event)
        if (resultError) {
          fail(resultError)
          return
        }
        if (event.type === 'user' && Array.isArray(event.message?.content)) {
          resetIdleTimer()
          for (const block of event.message.content) {
            if (block.type !== 'tool_result' || !block.tool_use_id) continue
            const pending = pendingRemoteTools.get(block.tool_use_id)
            if (!pending) continue
            pendingRemoteTools.delete(block.tool_use_id)
            const result = event.tool_use_result
            if (typeof block.content === 'string' && block.content.trim()) {
              remoteResearch.push(
                `[${pending.name} ${JSON.stringify(pending.input)}]\n${block.content.slice(0, 6_000)}`,
              )
              while (remoteResearch.join('\n\n').length > 24_000) remoteResearch.shift()
            }
            const duration = Number(result?.durationSeconds)
            const durationText = Number.isFinite(duration)
              ? duration >= 1
                ? `${Math.round(duration)}s`
                : `${Math.round(duration * 1000)}ms`
              : ''
            const failed =
              block.is_error === true ||
              result?.is_error === true ||
              (typeof block.content === 'string' &&
                /^(error|tool use error|web search failed|web fetch failed)\b/i.test(
                  block.content.trim(),
                ))
            let summary
            if (pending.name === 'WebSearch') {
              const searches = Number(result?.searchCount)
              const count = Number.isFinite(searches) ? searches : 1
              const failureText =
                typeof block.content === 'string'
                  ? block.content.trim().split('\n')[0].slice(0, 500)
                  : 'Web search failed'
              summary = failed
                ? `Error: ${failureText}`
                : `Did ${count} search${count === 1 ? '' : 'es'}${
                    durationText ? ` in ${durationText}` : ''
                  }`
            } else {
              const bytes = Number(result?.bytes)
              const sizeText = Number.isFinite(bytes)
                ? bytes >= 1024
                  ? `${(bytes / 1024).toFixed(1)} KB`
                  : `${bytes} bytes`
                : ''
              const code = Number(result?.code)
              const codeText = String(result?.codeText ?? '').trim()
              const statusText = Number.isFinite(code)
                ? `${code}${codeText ? ` ${codeText}` : ''}`
                : ''
              const failureText =
                typeof block.content === 'string'
                  ? block.content.trim().split('\n')[0].slice(0, 500)
                  : 'Web fetch failed'
              summary = failed
                ? `Error: ${failureText}`
                : `Received ${sizeText || 'response'}${statusText ? ` (${statusText})` : ''}${
                    durationText ? ` in ${durationText}` : ''
                  }`
            }
            onProgress({
              phase: failed ? 'failure' : 'success',
              name: pending.name,
              callId: block.tool_use_id,
              summary,
              // UI transcript and model context have different retention rules. The local
              // transcript receives the complete result; remoteResearch above remains bounded.
              detail: typeof block.content === 'string' ? block.content : undefined,
            })
          }
          return
        }
        if (event.type !== 'assistant' || !Array.isArray(event.message?.content)) return
        resetIdleTimer()
        if (!handshakeDone) {
          handshakeDone = true
          handshakeTurnFinishing = true
          sendConversation()
          return
        }
        const content = event.message.content
        for (const block of content) {
          if (block.type !== 'thinking' || typeof block.thinking !== 'string' || !block.thinking) continue
          if (emittedThinking.has(block.thinking)) continue
          emittedThinking.add(block.thinking)
          onProgress({
            phase: 'info',
            name: 'thinking',
            summary: 'Thinking',
            detail: block.thinking,
          })
        }
        const toolBlocks = content.filter(
          block =>
            block.type === 'tool_use' &&
            (block.name?.startsWith(MCP_PREFIX) || localToolNames.has(block.name)),
        )
        const remoteToolBlocks = content.filter(
          block => block.type === 'tool_use' && REMOTE_BUILTIN_TOOLS.has(block.name),
        )
        const unsupportedToolBlocks = content.filter(
          block =>
            block.type === 'tool_use' &&
            !block.name?.startsWith(MCP_PREFIX) &&
            !localToolNames.has(block.name) &&
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
            remoteContext: remoteResearch.join('\n\n'),
            toolCalls: toolBlocks.map(block => ({
              id: block.id ?? `call_${randomUUID().replaceAll('-', '')}`,
              type: 'function',
              function: {
                name: block.name.startsWith(MCP_PREFIX)
                  ? block.name.slice(MCP_PREFIX.length)
                  : block.name,
                arguments: JSON.stringify(block.input ?? {}),
              },
            })),
          }
          return
        }
        if (remoteToolBlocks.length) {
          const stageText = content
            .filter(block => block.type === 'text')
            .map(block => block.text)
            .join('')
            .trim()
          // Claude often explains an important finding immediately before its
          // next WebSearch/WebFetch call. Do not classify that text with a
          // narrow "I'll/let me/next" heuristic: factual research notes do not
          // necessarily contain progress verbs, and silently dropping them
          // leaves the local UI showing only raw tool cards.
          if (stageText) {
            onProgress({
              phase: 'info',
              name: 'remote-status',
              summary: `● ${stageText}`,
            })
          }
          for (const block of remoteToolBlocks) {
            if (block.name === 'WebSearch') remoteWebSearches += 1
            if (block.name === 'WebFetch') remoteWebFetches += 1
            const callId = block.id ?? `remote_${randomUUID().replaceAll('-', '')}`
            const input = block.input ?? {}
            pendingRemoteTools.set(callId, { name: block.name, input })
            const target =
              block.name === 'WebSearch'
                ? String(input.query ?? '')
                : String(input.url ?? input.uri ?? '')
            onProgress({
              phase: 'start',
              name: block.name,
              callId,
              summary:
                block.name === 'WebSearch'
                  ? `Web Search(${target.replace(/\s+/g, ' ').trim()})`
                  : `Fetch(${target})`,
              detail: JSON.stringify(input, null, 2),
            })
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
        resetIdleTimer()
        addUsage(event.event.usage)
        onUsage({ ...usage })
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

        // A non-empty end_turn is authoritative. Requiring a private completion marker caused a
        // second near-identical generation and invalidated most of the prompt cache. Strip the
        // legacy marker for sessions created by older gateways, but never ask Claude to rewrite.
        finish({
          content: completionText.replace(/^\s*<LOCAL_AGENT_FINAL>\s*/, ''),
          toolCalls: [],
          finishReason: 'stop',
          usage: { ...usage },
        })
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
      if (remoteSession?.mode === 'resume') {
        writeClaudeInput('resume-update', resumeInput(body.messages))
      } else {
        writeClaudeInput('handshake', {
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'MCP_GATEWAY_HANDSHAKE' }],
          },
        })
      }
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

  function writeStream(res, choice, usage, remoteContext) {
    if (remoteContext) {
      res.write(
        `data: ${JSON.stringify({
          choices: [],
          ai_remote_context: { content: remoteContext },
        })}\n\n`,
      )
    }
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

  function writeProgress(res, progress) {
    if (res.writableEnded || res.destroyed) return
    res.write(`data: ${JSON.stringify({ choices: [], ai_remote_progress: progress })}\n\n`)
  }

  function writeRemoteSessionAck(res, session) {
    if (res.writableEnded || res.destroyed) return
    res.write(`data: ${JSON.stringify({ choices: [], ai_remote_session: session })}\n\n`)
  }

  function writeRemoteTrace(res, trace) {
    if (res.writableEnded || res.destroyed) return
    res.write(`data: ${JSON.stringify({ choices: [], ai_remote_trace: trace })}\n\n`)
  }

  function writeUsage(res, usage) {
    if (res.writableEnded || res.destroyed) return
    res.write(`data: ${JSON.stringify({ choices: [], usage })}\n\n`)
  }

  function writeStreamError(res, error, requestId) {
    if (res.writableEnded || res.destroyed) return
    res.write(
      `data: ${JSON.stringify({
        choices: [],
        ai_remote_error: {
          requestId,
          message: error?.message ?? String(error),
          code: error?.code ?? 'REMOTE_GATEWAY_ERROR',
        },
      })}\n\n`,
    )
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
        tracked_remote_sessions: remoteSessions.size,
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
    const requestId = `req_${randomUUID().replaceAll('-', '')}`
    let heartbeat
    let clientAbort
    let body
    let remoteSession
    let remoteSessionAcquired = false
    let remoteSessionCompleted = false
    let remoteSessionPendingToolUseIds = []
    const remoteTraceEvents = []
    try {
      body = await readBody(req)
      remoteSession = remoteSessionFor(body)
      acquireRemoteSession(remoteSession, body.messages)
      remoteSessionAcquired = Boolean(remoteSession)
      logGatewayEvent(requestId, 'request_start', {
        model: body.model ?? 'sonnet',
        stream: Boolean(body.stream),
        messageCount: Array.isArray(body.messages) ? body.messages.length : 0,
        localToolCount: Array.isArray(body.tools) ? body.tools.length : 0,
        remoteSessionMode: remoteSession?.mode,
        remoteSessionStep: remoteSession?.step,
      })
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
        if (remoteSession) writeRemoteSessionAck(res, remoteSession)
        heartbeat = setInterval(() => {
          if (!res.writableEnded && !res.destroyed) res.write(': keep-alive\n\n')
        }, 15_000)
        heartbeat.unref()
      }

      const completion = await callClaude(
        body,
        remoteSession,
        clientAbort?.signal,
        body.stream
          ? progress => {
              logGatewayEvent(requestId, 'progress', progress)
              writeProgress(res, progress)
            }
          : undefined,
        body.stream
          ? usage => writeUsage(res, openAIUsage(usage))
          : undefined,
        body.ai_remote_trace === true
          ? trace => {
              const event = { requestId, ...trace }
              if (body.stream) writeRemoteTrace(res, event)
              else remoteTraceEvents.push(event)
            }
          : undefined,
      )
      const choice = choiceFor(completion)
      const usage = openAIUsage(completion.usage)
      completed += 1
      remoteSessionCompleted = true
      remoteSessionPendingToolUseIds = completion.toolCalls.map(call => call.id)
      logGatewayEvent(requestId, 'request_complete', {
        finishReason: choice.finish_reason,
        contentLength: completion.content.length,
        localToolCalls: completion.toolCalls.map(call => call.function.name),
        usage: completion.usage,
      })
      if (body.stream) writeStream(res, choice, usage, completion.remoteContext)
      else {
        json(res, 200, {
          id: `chatcmpl_${randomUUID().replaceAll('-', '')}`,
          object: 'chat.completion',
          model: body.model ?? 'sonnet',
          choices: [{ index: 0, ...choice }],
          usage,
          ...(remoteSession ? { ai_remote_session: remoteSession } : {}),
          ...(body.ai_remote_trace === true ? { ai_remote_trace: remoteTraceEvents } : {}),
          ...(completion.remoteContext
            ? { ai_remote_context: { content: completion.remoteContext } }
            : {}),
        })
      }
    } catch (error) {
      logGatewayEvent(requestId, error?.name === 'AbortError' ? 'request_aborted' : 'request_error', {
        errorName: error?.name,
        errorCode: error?.code,
        message: error?.message ?? String(error),
      })
      if (error?.name !== 'AbortError') {
        console.error(`gateway request failed: ${error?.stack ?? error?.message ?? String(error)}`)
      }
      if (res.headersSent) {
        if (body?.stream) writeStreamError(res, error, requestId)
        else if (!res.destroyed) res.destroy(error)
      } else {
        const status = error?.code === 'GATEWAY_TIMEOUT'
          ? 504
          : String(error?.code ?? '').startsWith('REMOTE_SESSION_')
            ? 409
            : 502
        json(res, status, {
          error: { message: error?.message ?? String(error), code: error?.code },
        })
      }
    } finally {
      clearInterval(heartbeat)
      if (remoteSessionAcquired) {
        releaseRemoteSession(
          remoteSession,
          remoteSessionCompleted,
          remoteSessionPendingToolUseIds,
        )
      }
      active -= 1
    }
  })

  server.listen(port, host, () => {
    console.log(`ai-claude MCP capture gateway listening on http://${host}:${port}`)
  })
}
