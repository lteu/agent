// Model Context Protocol client support.
//
// Configuration is intentionally compatible with Claude Code's `mcpServers`
// shape. User-wide entries live in ~/.ai/config.json; project entries live in
// .mcp.json files from the filesystem root down to the active working directory.

import { createHash } from 'node:crypto'
import { exec } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  ElicitRequestSchema,
  ListRootsRequestSchema,
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js'
import {
  CONFIG_PATH,
  loadRawConfig,
  saveLocalMcpServers,
  saveUserMcpServers,
  type McpServerConfig,
} from './config.js'
import { createMcpOAuthFetch, createMcpOAuthProvider } from './mcp-auth.js'
import { McpWebSocketTransport } from './mcp-websocket.js'
import type { LocalToolContentBlock } from './llm.js'
import type { ToolResult } from './tools.js'

export type McpConfigScope = 'local' | 'user' | 'project'

export type LoadedMcpConfiguration = {
  servers: Record<string, McpServerConfig>
  sources: Record<string, { scope: McpConfigScope; file: string }>
  errors: string[]
}

export type McpToolSchema = {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

type ConnectedServer = {
  name: string
  client: Client
  transport: Transport
  tools: Map<string, string>
  config: McpServerConfig
  cwd: string
  schemas: McpToolSchema[]
  refreshTools: () => Promise<void>
}

export type McpRuntime = {
  schemas: McpToolSchema[]
  failures: string[]
  /** InitializeResult.instructions supplied by connected servers, ready for system-prompt injection. */
  instructions?: string
  run: (name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<ToolResult>
  /** Refresh tool/prompt/resource discovery after MCP list-changed notifications or between agent turns. */
  refresh: () => Promise<void>
  /** Always returns the current schema list; unlike `schemas`, callers need not retain an array reference. */
  getSchemas: () => McpToolSchema[]
  close: () => Promise<void>
}

const SUPPORTED_IMAGE_TYPES = new Set<LocalToolContentBlock['mediaType']>([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
])
const MAX_DESCRIPTION_LENGTH = 2048
const MAX_RESULT_TEXT_LENGTH = 100_000
const MAX_IMAGE_BYTES = 4 * 1024 * 1024
const LIST_MCP_RESOURCES_TOOL = 'list_mcp_resources'
const READ_MCP_RESOURCE_TOOL = 'read_mcp_resource'
const LIST_MCP_PROMPTS_TOOL = 'list_mcp_prompts'
const GET_MCP_PROMPT_TOOL = 'get_mcp_prompt'
const execAsync = promisify(exec)

function mcpOutputDirectory(): string {
  return process.env.AI_MCP_OUTPUT_DIR || join(dirname(CONFIG_PATH), 'mcp-results')
}

function mimeExtension(mimeType: string | undefined): string {
  const known: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'audio/ogg': 'ogg',
    'application/pdf': 'pdf',
    'application/json': 'json',
    'text/plain': 'txt',
  }
  return known[mimeType ?? ''] ?? 'bin'
}

function persistMcpBuffer(data: string, mimeType: string | undefined, label: string): string | undefined {
  const maxBytes = positiveEnvInt('AI_MCP_MAX_PERSIST_BYTES', 50 * 1024 * 1024)
  const buffer = Buffer.from(data, 'base64')
  if (buffer.byteLength > maxBytes) return undefined
  const directory = mcpOutputDirectory()
  mkdirSync(directory, { recursive: true })
  const digest = createHash('sha256').update(buffer).digest('hex').slice(0, 12)
  const safeLabel = label.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40) || 'content'
  const file = join(directory, `${Date.now()}-${safeLabel}-${digest}.${mimeExtension(mimeType)}`)
  writeFileSync(file, buffer, { mode: 0o600 })
  return file
}

function persistMcpText(text: string, label: string): string {
  const directory = mcpOutputDirectory()
  mkdirSync(directory, { recursive: true })
  const digest = createHash('sha256').update(text).digest('hex').slice(0, 12)
  const safeLabel = label.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40) || 'text'
  const file = join(directory, `${Date.now()}-${safeLabel}-${digest}.txt`)
  writeFileSync(file, text, { encoding: 'utf8', mode: 0o600 })
  return file
}

function preserveLargeMcpText(text: string, label: string): string {
  if (text.length <= MAX_RESULT_TEXT_LENGTH) return text
  const file = persistMcpText(text, label)
  const tailLength = Math.min(2_000, Math.floor(MAX_RESULT_TEXT_LENGTH / 10))
  const headLength = MAX_RESULT_TEXT_LENGTH - tailLength
  return `${text.slice(0, headLength)}\n…（中间内容省略）…\n${text.slice(-tailLength)}\n（完整 MCP 结果已保存：${file}）`
}

function positiveEnvInt(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function stringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every(item => typeof item === 'string')
}

export function validateMcpServerConfig(name: string, value: unknown): string | null {
  if (!name.trim()) return 'MCP server name cannot be empty'
  if (!isRecord(value)) return `MCP server "${name}" must be an object`
  if (value.disabled !== undefined && typeof value.disabled !== 'boolean') {
    return `MCP server "${name}" has a non-boolean disabled value`
  }

  const type = value.type ?? 'stdio'
  if (type === 'stdio') {
    if (typeof value.command !== 'string' || !value.command.trim()) {
      return `MCP stdio server "${name}" requires a non-empty command`
    }
    if (value.args !== undefined && (!Array.isArray(value.args) || value.args.some(arg => typeof arg !== 'string'))) {
      return `MCP stdio server "${name}" args must be an array of strings`
    }
    if (value.env !== undefined && !stringRecord(value.env)) {
      return `MCP stdio server "${name}" env must contain only string values`
    }
    if (value.cwd !== undefined && typeof value.cwd !== 'string') {
      return `MCP stdio server "${name}" cwd must be a string`
    }
    return null
  }

  if (type === 'http' || type === 'sse' || type === 'ws') {
    if (typeof value.url !== 'string') return `MCP ${type} server "${name}" requires a URL`
    try {
      const url = new URL(value.url)
      const protocols = type === 'ws' ? ['ws:', 'wss:'] : ['http:', 'https:']
      if (!protocols.includes(url.protocol)) throw new Error('unsupported protocol')
    } catch {
      // The URL can contain ${ENV} placeholders; validate its shape again after expansion.
      if (!value.url.includes('${')) return `MCP ${type} server "${name}" has an invalid URL`
    }
    if (value.headers !== undefined && !stringRecord(value.headers)) {
      return `MCP ${type} server "${name}" headers must contain only string values`
    }
    if (value.headersHelper !== undefined && (typeof value.headersHelper !== 'string' || !value.headersHelper.trim())) {
      return `MCP ${type} server "${name}" headersHelper must be a non-empty command`
    }
    if (type === 'ws' && value.oauth !== undefined) {
      return `MCP ws server "${name}" does not support oauth config; use headers or headersHelper`
    }
    if (type !== 'ws' && value.oauth !== undefined) {
      if (!isRecord(value.oauth)) return `MCP ${type} server "${name}" oauth must be an object`
      if (value.oauth.clientId !== undefined && typeof value.oauth.clientId !== 'string') {
        return `MCP ${type} server "${name}" oauth.clientId must be a string`
      }
      if (
        value.oauth.callbackPort !== undefined
        && (!Number.isInteger(value.oauth.callbackPort) || Number(value.oauth.callbackPort) <= 0 || Number(value.oauth.callbackPort) > 65535)
      ) {
        return `MCP ${type} server "${name}" oauth.callbackPort must be an integer between 1 and 65535`
      }
      if (value.oauth.authServerMetadataUrl !== undefined) {
        if (typeof value.oauth.authServerMetadataUrl !== 'string') {
          return `MCP ${type} server "${name}" oauth.authServerMetadataUrl must be a string`
        }
        try {
          const metadataUrl = new URL(value.oauth.authServerMetadataUrl)
          if (metadataUrl.protocol !== 'https:') throw new Error('must use HTTPS')
        } catch {
          return `MCP ${type} server "${name}" oauth.authServerMetadataUrl must be a valid HTTPS URL`
        }
      }
    }
    return null
  }

  return `MCP server "${name}" uses unsupported transport "${String(type)}"`
}

function parseMcpServers(
  value: unknown,
  label: string,
): { servers: Record<string, McpServerConfig>; errors: string[] } {
  if (value === undefined) return { servers: {}, errors: [] }
  if (!isRecord(value)) return { servers: {}, errors: [`${label}: mcpServers must be an object`] }

  const servers: Record<string, McpServerConfig> = {}
  const errors: string[] = []
  for (const [name, config] of Object.entries(value)) {
    const error = validateMcpServerConfig(name, config)
    if (error) errors.push(`${label}: ${error}`)
    else servers[name] = config as McpServerConfig
  }
  return { servers, errors }
}

function projectConfigDirs(cwd: string): string[] {
  const dirs: string[] = []
  let current = resolve(cwd)
  while (true) {
    dirs.push(current)
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return dirs.reverse()
}

/** Nearest Git worktree root, or the active directory when no repository marker exists. */
export function findMcpProjectRoot(cwd: string = process.cwd()): string {
  let current = resolve(cwd)
  while (true) {
    if (existsSync(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return resolve(cwd)
    current = parent
  }
}

function readProjectConfigFile(file: string): { servers: Record<string, McpServerConfig>; errors: string[] } {
  if (!existsSync(file)) return { servers: {}, errors: [] }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
    if (!isRecord(parsed)) return { servers: {}, errors: [`${file}: top-level value must be an object`] }
    return parseMcpServers(parsed.mcpServers, file)
  } catch (error) {
    return { servers: {}, errors: [`${file}: ${error instanceof Error ? error.message : String(error)}`] }
  }
}

/** Load user and project MCP configs. Closer .mcp.json files override parent and user entries. */
export function loadMcpConfiguration(cwd: string = process.cwd()): LoadedMcpConfiguration {
  const servers: Record<string, McpServerConfig> = {}
  const sources: LoadedMcpConfiguration['sources'] = {}
  const errors: string[] = []

  const userFile = CONFIG_PATH
  const user = parseMcpServers(loadRawConfig().mcpServers, userFile)
  errors.push(...user.errors)
  for (const [name, config] of Object.entries(user.servers)) {
    servers[name] = config
    sources[name] = { scope: 'user', file: userFile }
  }

  for (const dir of projectConfigDirs(cwd)) {
    const file = join(dir, '.mcp.json')
    const project = readProjectConfigFile(file)
    errors.push(...project.errors)
    for (const [name, config] of Object.entries(project.servers)) {
      servers[name] = config
      sources[name] = { scope: 'project', file }
    }
  }


  const localRoot = findMcpProjectRoot(cwd)
  const local = parseMcpServers(loadRawConfig().mcpProjects?.[localRoot]?.mcpServers, `${CONFIG_PATH} (${localRoot})`)
  errors.push(...local.errors)
  for (const [name, config] of Object.entries(local.servers)) {
    servers[name] = config
    sources[name] = { scope: 'local', file: CONFIG_PATH }
  }

  return { servers, sources, errors }
}

function readWritableProjectConfig(cwd: string): Record<string, unknown> {
  const file = join(resolve(cwd), '.mcp.json')
  if (!existsSync(file)) return {}
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
  if (!isRecord(parsed)) throw new Error(`${file} 顶层必须是 JSON 对象`)
  if (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers)) {
    throw new Error(`${file} 的 mcpServers 必须是 JSON 对象`)
  }
  return parsed
}

function writeJsonAtomically(file: string, value: unknown): void {
  const mode = existsSync(file) ? statSync(file).mode : 0o644
  const temp = `${file}.tmp.${process.pid}.${Date.now()}`
  try {
    writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode })
    renameSync(temp, file)
  } catch (error) {
    try { unlinkSync(temp) } catch { /* best effort */ }
    throw error
  }
}

/** Add a server to one concrete scope. Existing names are rejected. */
export function addMcpServerConfig(
  name: string,
  config: McpServerConfig,
  scope: McpConfigScope,
  cwd: string = process.cwd(),
): string {
  const validationError = validateMcpServerConfig(name, config)
  if (validationError) throw new Error(validationError)

  if (scope === 'user') {
    const current = loadRawConfig().mcpServers ?? {}
    if (Object.hasOwn(current, name)) throw new Error(`用户配置中已存在 MCP server "${name}"`)
    saveUserMcpServers({ ...current, [name]: config })
    return '~/.ai/config.json'
  }

  if (scope === 'local') {
    const root = findMcpProjectRoot(cwd)
    const current = loadRawConfig().mcpProjects?.[root]?.mcpServers ?? {}
    if (Object.hasOwn(current, name)) throw new Error(`本机项目配置中已存在 MCP server "${name}"`)
    saveLocalMcpServers(root, { ...current, [name]: config })
    return `~/.ai/config.json (local: ${root})`
  }

  const file = join(resolve(cwd), '.mcp.json')
  const root = readWritableProjectConfig(cwd)
  const current = (root.mcpServers ?? {}) as Record<string, McpServerConfig>
  if (Object.hasOwn(current, name)) throw new Error(`${file} 中已存在 MCP server "${name}"`)
  writeJsonAtomically(file, { ...root, mcpServers: { ...current, [name]: config } })
  return file
}

/** Remove a server from one concrete scope. Project means the current directory's .mcp.json. */
export function removeMcpServerConfig(
  name: string,
  scope: McpConfigScope,
  cwd: string = process.cwd(),
): string {
  if (scope === 'user') {
    const current = loadRawConfig().mcpServers ?? {}
    if (!Object.hasOwn(current, name)) throw new Error(`用户配置中没有 MCP server "${name}"`)
    const { [name]: _removed, ...rest } = current
    saveUserMcpServers(rest)
    return '~/.ai/config.json'
  }

  if (scope === 'local') {
    const root = findMcpProjectRoot(cwd)
    const current = loadRawConfig().mcpProjects?.[root]?.mcpServers ?? {}
    if (!Object.hasOwn(current, name)) throw new Error(`本机项目配置中没有 MCP server "${name}"`)
    const { [name]: _removed, ...rest } = current
    saveLocalMcpServers(root, rest)
    return `~/.ai/config.json (local: ${root})`
  }

  const file = join(resolve(cwd), '.mcp.json')
  const root = readWritableProjectConfig(cwd)
  const current = (root.mcpServers ?? {}) as Record<string, McpServerConfig>
  if (!Object.hasOwn(current, name)) throw new Error(`${file} 中没有 MCP server "${name}"`)
  const { [name]: _removed, ...rest } = current
  writeJsonAtomically(file, { ...root, mcpServers: rest })
  return file
}

/** Expand Claude Code-style ${VAR} and ${VAR:-default} placeholders. */
export function expandMcpEnv(value: string): { value: string; missing: string[] } {
  const missing: string[] = []
  const expanded = value.replace(/\$\{([^}]+)\}/g, (original, body: string) => {
    const delimiter = body.indexOf(':-')
    const name = delimiter >= 0 ? body.slice(0, delimiter) : body
    const fallback = delimiter >= 0 ? body.slice(delimiter + 2) : undefined
    if (process.env[name] !== undefined) return process.env[name]!
    if (fallback !== undefined) return fallback
    missing.push(name)
    return original
  })
  return { value: expanded, missing: [...new Set(missing)] }
}

function expandConfig(config: McpServerConfig): { config: McpServerConfig; missing: string[] } {
  const missing: string[] = []
  const expand = (value: string): string => {
    const result = expandMcpEnv(value)
    missing.push(...result.missing)
    return result.value
  }

  if (config.type === 'http' || config.type === 'sse' || config.type === 'ws') {
    return {
      config: {
        ...config,
        url: expand(config.url),
        headers: config.headers
          ? Object.fromEntries(Object.entries(config.headers).map(([key, value]) => [key, expand(value)]))
          : undefined,
        headersHelper: config.headersHelper ? expand(config.headersHelper) : undefined,
        oauth: config.type !== 'ws' && config.oauth
          ? {
              ...config.oauth,
              clientId: config.oauth.clientId ? expand(config.oauth.clientId) : undefined,
              authServerMetadataUrl: config.oauth.authServerMetadataUrl
                ? expand(config.oauth.authServerMetadataUrl)
                : undefined,
            }
          : undefined,
      },
      missing: [...new Set(missing)],
    }
  }

  return {
    config: {
      ...config,
      command: expand(config.command),
      args: config.args?.map(expand),
      env: config.env
        ? Object.fromEntries(Object.entries(config.env).map(([key, value]) => [key, expand(value)]))
        : undefined,
      cwd: config.cwd ? expand(config.cwd) : undefined,
    },
    missing: [...new Set(missing)],
  }
}

export function normalizeMcpName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_')
}

export function buildMcpToolName(serverName: string, toolName: string): string {
  const full = `mcp__${normalizeMcpName(serverName)}__${normalizeMcpName(toolName)}`
  if (full.length <= 64) return full
  const hash = createHash('sha256').update(full).digest('hex').slice(0, 8)
  return `${full.slice(0, 55)}_${hash}`
}

function mergeHeaders(base: HeadersInit | undefined, extra: Record<string, string>): Headers {
  const headers = new Headers(base)
  for (const [key, value] of Object.entries(extra)) headers.set(key, value)
  return headers
}

async function dynamicMcpHeaders(
  name: string,
  config: Extract<McpServerConfig, { type: 'http' | 'sse' | 'ws' }>,
  cwd: string,
): Promise<Record<string, string>> {
  if (!config.headersHelper) return config.headers ?? {}
  const { stdout } = await execAsync(config.headersHelper, {
    cwd,
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    env: {
      ...process.env,
      AI_MCP_SERVER_NAME: name,
      AI_MCP_SERVER_URL: config.url,
    },
  })
  const parsed = JSON.parse(stdout.trim()) as unknown
  if (!stringRecord(parsed)) {
    throw new Error(`headersHelper for MCP server "${name}" 必须输出 string-to-string JSON object`)
  }
  return { ...(config.headers ?? {}), ...parsed }
}

async function createTransport(name: string, config: McpServerConfig, cwd: string): Promise<Transport> {
  if (config.type === 'http') {
    const headers = await dynamicMcpHeaders(name, config, cwd)
    return new StreamableHTTPClientTransport(new URL(config.url), {
      authProvider: createMcpOAuthProvider(name, config),
      fetch: createMcpOAuthFetch(config),
      requestInit: { headers },
      reconnectionOptions: {
        initialReconnectionDelay: 500,
        maxReconnectionDelay: 10_000,
        reconnectionDelayGrowFactor: 1.8,
        maxRetries: 4,
      },
    })
  }
  if (config.type === 'sse') {
    const headers = await dynamicMcpHeaders(name, config, cwd)
    const oauthFetch = createMcpOAuthFetch(config)
    return new SSEClientTransport(new URL(config.url), {
      authProvider: createMcpOAuthProvider(name, config),
      fetch: oauthFetch,
      requestInit: { headers },
      eventSourceInit: {
        fetch: async (url, init) => oauthFetch(url, { ...init, headers: mergeHeaders(init?.headers, headers) }),
      },
    })
  }
  if (config.type === 'ws') {
    const headers = await dynamicMcpHeaders(name, config, cwd)
    return new McpWebSocketTransport(new URL(config.url), headers)
  }

  const workingDirectory = config.cwd
    ? isAbsolute(config.cwd) ? config.cwd : resolve(cwd, config.cwd)
    : cwd
  return new StdioClientTransport({
    command: config.command,
    args: config.args ?? [],
    env: config.env ? { ...getDefaultEnvironment(), ...config.env } : undefined,
    cwd: workingDirectory,
    stderr: 'pipe',
  })
}

async function listAllTools(client: Client, timeout: number): Promise<any[]> {
  const tools: any[] = []
  let cursor: string | undefined
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined, { timeout })
    tools.push(...page.tools)
    cursor = page.nextCursor
  } while (cursor)
  return tools
}

async function listAllResources(client: Client, timeout: number, signal?: AbortSignal): Promise<any[]> {
  const resources: any[] = []
  let cursor: string | undefined
  do {
    const page = await client.listResources(cursor ? { cursor } : undefined, { timeout, signal })
    resources.push(...page.resources)
    cursor = page.nextCursor
  } while (cursor)
  return resources
}

async function listAllPrompts(client: Client, timeout: number, signal?: AbortSignal): Promise<any[]> {
  const prompts: any[] = []
  let cursor: string | undefined
  do {
    const page = await client.listPrompts(cursor ? { cursor } : undefined, { timeout, signal })
    prompts.push(...page.prompts)
    cursor = page.nextCursor
  } while (cursor)
  return prompts
}

async function discoverToolSchemas(
  client: Client,
  serverName: string,
  timeout: number,
): Promise<{ mapping: Map<string, string>; schemas: McpToolSchema[] }> {
  const tools = client.getServerCapabilities()?.tools ? await listAllTools(client, timeout) : []
  const mapping = new Map<string, string>()
  const schemas: McpToolSchema[] = []
  for (const tool of tools) {
    const exposedName = buildMcpToolName(serverName, tool.name)
    if (mapping.has(exposedName)) {
      throw new Error(`tools "${mapping.get(exposedName)}" and "${tool.name}" normalize to the same name`)
    }
    mapping.set(exposedName, tool.name)
    const rawDescription = typeof tool.description === 'string' ? tool.description : ''
    const description = rawDescription.length > MAX_DESCRIPTION_LENGTH
      ? rawDescription.slice(0, MAX_DESCRIPTION_LENGTH) + '…'
      : rawDescription
    schemas.push({
      type: 'function',
      function: {
        name: exposedName,
        description: `${description || tool.name} (MCP server: ${serverName})`,
        parameters: isRecord(tool.inputSchema)
          ? tool.inputSchema
          : { type: 'object', properties: {} },
      },
    })
  }
  return { mapping, schemas }
}

async function connectServer(
  name: string,
  config: McpServerConfig,
  cwd: string,
  onChanged?: () => void,
): Promise<{ server: ConnectedServer; schemas: McpToolSchema[] }> {
  const transport = await createTransport(name, config, cwd)
  const client = new Client(
    { name: 'ai-cli', version: '0.1.0' },
    { capabilities: { roots: {}, elicitation: { form: { applyDefaults: true }, url: {} } } },
  )
  client.setRequestHandler(ListRootsRequestSchema, async () => ({
    roots: [{ uri: pathToFileURL(cwd).toString(), name: 'working-directory' }],
  }))
  // The CLI does not guess sensitive answers. Servers receive a valid protocol response
  // instead of hanging if they elicit before the interactive UI installs a richer handler.
  client.setRequestHandler(ElicitRequestSchema, async () => ({ action: 'cancel' as const }))

  const timeout = positiveEnvInt('AI_MCP_CONNECT_TIMEOUT_MS', 10_000)
  const server: ConnectedServer = {
    name,
    client,
    transport,
    tools: new Map(),
    config,
    cwd,
    schemas: [],
    refreshTools: async () => {
      const discovered = await discoverToolSchemas(client, name, timeout)
      server.tools = discovered.mapping
      server.schemas = discovered.schemas
      onChanged?.()
    },
  }
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
    await server.refreshTools()
  })
  client.setNotificationHandler(ResourceListChangedNotificationSchema, async () => {
    onChanged?.()
  })
  client.setNotificationHandler(PromptListChangedNotificationSchema, async () => {
    onChanged?.()
  })

  let stderr = ''
  if (transport instanceof StdioClientTransport && transport.stderr) {
    transport.stderr.on('data', chunk => {
      stderr = (stderr + String(chunk)).slice(-8192)
    })
  }

  try {
    await client.connect(transport, { timeout })
    await server.refreshTools()
    return { server, schemas: server.schemas }
  } catch (error) {
    await client.close().catch(() => transport.close().catch(() => undefined))
    const detail = error instanceof UnauthorizedError
      ? `需要 OAuth 认证；运行 ai mcp auth ${name}`
      : error instanceof Error ? error.message : String(error)
    throw new Error(stderr.trim() ? `${detail}; stderr: ${stderr.trim()}` : detail)
  }
}

function stringifyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export function mcpCallResultToToolResult(result: any, startedAt: number = Date.now()): ToolResult {
  const text: string[] = []
  const modelContent: LocalToolContentBlock[] = []
  for (const block of Array.isArray(result?.content) ? result.content : []) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      text.push(block.text)
    } else if (block?.type === 'image') {
      if (
        typeof block.data === 'string' &&
        SUPPORTED_IMAGE_TYPES.has(block.mimeType) &&
        Buffer.byteLength(block.data, 'base64') <= MAX_IMAGE_BYTES
      ) {
        modelContent.push({ type: 'image', mediaType: block.mimeType, data: block.data })
        text.push(`[MCP 图片：${block.mimeType}]`)
      } else {
        const file = typeof block.data === 'string'
          ? persistMcpBuffer(block.data, block.mimeType, 'image')
          : undefined
        text.push(file
          ? `[MCP 图片未直接回灌，已保存：${file}（${block.mimeType ?? 'unknown'}）]`
          : `[MCP 图片未回灌：格式不支持或超过持久化上限（${block.mimeType ?? 'unknown'}）]`)
      }
    } else if (block?.type === 'resource' && block.resource) {
      if (typeof block.resource.text === 'string') {
        text.push(`[资源 ${block.resource.uri ?? ''}]\n${block.resource.text}`)
      } else {
        const file = typeof block.resource.blob === 'string'
          ? persistMcpBuffer(block.resource.blob, block.resource.mimeType, 'resource')
          : undefined
        text.push(file
          ? `[二进制资源 ${block.resource.uri ?? ''} 已保存：${file}（${block.resource.mimeType ?? 'unknown'}）]`
          : `[二进制资源 ${block.resource.uri ?? ''} 未保存：${block.resource.mimeType ?? 'unknown'}]`)
      }
    } else if (block?.type === 'resource_link') {
      text.push(`[资源链接 ${block.name ?? ''}] ${block.uri ?? ''}`.trim())
    } else if (block?.type === 'audio') {
      const file = typeof block.data === 'string'
        ? persistMcpBuffer(block.data, block.mimeType, 'audio')
        : undefined
      text.push(file
        ? `[MCP 音频已保存：${file}（${block.mimeType ?? 'unknown'}）]`
        : `[MCP 音频未保存：缺少数据或超过持久化上限（${block.mimeType ?? 'unknown'}）]`)
    } else if (block !== undefined) {
      text.push(stringifyJson(block))
    }
  }
  if (result?.structuredContent !== undefined) {
    text.push(`结构化结果：\n${stringifyJson(result.structuredContent)}`)
  }
  const output = preserveLargeMcpText(text.join('\n\n') || '(MCP 工具返回空结果)', 'tool-result')
  const isError = result?.isError === true
  return {
    ok: !isError,
    output,
    error: isError ? { code: 'mcp_tool_error', message: output } : undefined,
    evidence: { kind: 'legacy' },
    modelContent: modelContent.length ? modelContent : undefined,
    durationMs: Date.now() - startedAt,
  }
}

function mcpResourceResultToToolResult(result: any, startedAt: number): ToolResult {
  const text: string[] = []
  const modelContent: LocalToolContentBlock[] = []
  for (const content of Array.isArray(result?.contents) ? result.contents : []) {
    if (typeof content?.text === 'string') {
      text.push(`[资源 ${content.uri ?? ''}]\n${content.text}`)
      continue
    }
    if (typeof content?.blob !== 'string') continue
    if (
      SUPPORTED_IMAGE_TYPES.has(content.mimeType) &&
      Buffer.byteLength(content.blob, 'base64') <= MAX_IMAGE_BYTES
    ) {
      modelContent.push({ type: 'image', mediaType: content.mimeType, data: content.blob })
      text.push(`[图片资源 ${content.uri ?? ''}：${content.mimeType}]`)
    } else {
      const file = persistMcpBuffer(content.blob, content.mimeType, 'resource')
      text.push(file
        ? `[二进制资源 ${content.uri ?? ''} 已保存：${file}（${content.mimeType ?? 'unknown'}）]`
        : `[二进制资源 ${content.uri ?? ''} 未保存：${content.mimeType ?? 'unknown'}]`)
    }
  }
  const output = preserveLargeMcpText(text.join('\n\n') || '(MCP resource 返回空内容)', 'resource-result')
  return {
    ok: true,
    output,
    evidence: { kind: 'legacy' },
    modelContent: modelContent.length ? modelContent : undefined,
    durationMs: Date.now() - startedAt,
  }
}

function mcpPromptResultToToolResult(result: any, startedAt: number): ToolResult {
  const text: string[] = []
  const modelContent: LocalToolContentBlock[] = []
  if (typeof result?.description === 'string' && result.description.trim()) {
    text.push(result.description.trim())
  }
  for (const message of Array.isArray(result?.messages) ? result.messages : []) {
    const role = message?.role === 'assistant' ? 'assistant' : 'user'
    const content = message?.content
    if (content?.type === 'text' && typeof content.text === 'string') {
      text.push(`[${role}]\n${content.text}`)
    } else if (
      content?.type === 'image'
      && typeof content.data === 'string'
      && SUPPORTED_IMAGE_TYPES.has(content.mimeType)
      && Buffer.byteLength(content.data, 'base64') <= MAX_IMAGE_BYTES
    ) {
      modelContent.push({ type: 'image', mediaType: content.mimeType, data: content.data })
      text.push(`[${role} image: ${content.mimeType}]`)
    } else if (content?.type === 'resource' && content.resource) {
      if (typeof content.resource.text === 'string') {
        text.push(`[${role} resource ${content.resource.uri ?? ''}]\n${content.resource.text}`)
      } else {
        text.push(`[${role} binary resource ${content.resource.uri ?? ''}: ${content.resource.mimeType ?? 'unknown'}]`)
      }
    } else if (content !== undefined) {
      text.push(`[${role}]\n${stringifyJson(content)}`)
    }
  }
  const output = preserveLargeMcpText(text.join('\n\n') || '(MCP prompt 返回空内容)', 'prompt-result')
  return {
    ok: true,
    output,
    evidence: { kind: 'legacy' },
    modelContent: modelContent.length ? modelContent : undefined,
    durationMs: Date.now() - startedAt,
  }
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  fn: (value: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(values.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (true) {
      const index = next++
      if (index >= values.length) return
      try {
        results[index] = { status: 'fulfilled', value: await fn(values[index]) }
      } catch (reason) {
        results[index] = { status: 'rejected', reason }
      }
    }
  }))
  return results
}

/** Connect configured servers and expose their discovered tools in the Agent's function-calling format. */
export async function createMcpRuntime(options: {
  cwd?: string
  servers?: Record<string, McpServerConfig>
} = {}): Promise<McpRuntime> {
  const cwd = resolve(options.cwd ?? process.cwd())
  const loaded = options.servers ? { servers: options.servers, errors: [] } : loadMcpConfiguration(cwd)
  const failures = [...loaded.errors]
  const configs: Array<[string, McpServerConfig]> = []

  if (process.env.AI_MCP_DISABLED !== '1') {
    for (const [name, rawConfig] of Object.entries(loaded.servers)) {
      if (rawConfig.disabled) continue
      const expanded = expandConfig(rawConfig)
      if (expanded.missing.length) {
        failures.push(`${name}: 缺少环境变量 ${expanded.missing.join(', ')}`)
        continue
      }
      const validationError = validateMcpServerConfig(name, expanded.config)
      if (validationError) {
        failures.push(validationError)
        continue
      }
      configs.push([name, expanded.config])
    }
  }

  const connected = new Map<string, ConnectedServer>()
  const schemas: McpToolSchema[] = []
  const exposedNames = new Set<string>()
  let rebuildSchemas = (): void => {}
  const results = await mapWithConcurrency(
    configs,
    4,
    ([name, config]) => connectServer(name, config, cwd, () => rebuildSchemas()),
  )
  for (let index = 0; index < results.length; index++) {
    const result = results[index]
    const name = configs[index][0]
    if (result.status === 'rejected') {
      failures.push(`${name}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`)
      continue
    }
    let collision: string | undefined
    for (const schema of result.value.schemas) {
      if (exposedNames.has(schema.function.name)) collision = schema.function.name
    }
    if (collision) {
      failures.push(`${name}: MCP tool name collision: ${collision}`)
      await result.value.server.client.close().catch(() => undefined)
      continue
    }
    connected.set(name, result.value.server)
    for (const schema of result.value.schemas) {
      exposedNames.add(schema.function.name)
    }
  }

  const resourceSchemas: McpToolSchema[] = [
    {
      type: 'function',
      function: {
        name: LIST_MCP_RESOURCES_TOOL,
        description: '列出已连接 MCP server 提供的 resources；可选按 server 名过滤。',
        parameters: {
          type: 'object',
          properties: {
            server: { type: 'string', description: '可选的 MCP server 名' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: READ_MCP_RESOURCE_TOOL,
        description: '按 server 名和 URI 读取一个 MCP resource。通常先调用 list_mcp_resources。',
        parameters: {
          type: 'object',
          properties: {
            server: { type: 'string', description: 'MCP server 名' },
            uri: { type: 'string', description: 'resource URI' },
          },
          required: ['server', 'uri'],
        },
      },
    },
  ]
  const promptSchemas: McpToolSchema[] = [
    {
      type: 'function',
      function: {
        name: LIST_MCP_PROMPTS_TOOL,
        description: '列出已连接 MCP server 提供的 prompts 和参数。',
        parameters: {
          type: 'object',
          properties: { server: { type: 'string', description: '可选的 MCP server 名' } },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: GET_MCP_PROMPT_TOOL,
        description: '获取一个 MCP prompt 的消息内容。',
        parameters: {
          type: 'object',
          properties: {
            server: { type: 'string', description: 'MCP server 名' },
            name: { type: 'string', description: 'prompt 名' },
            arguments: {
              type: 'object',
              description: 'prompt 参数；键和值均按 server 声明传入',
              additionalProperties: { type: 'string' },
            },
          },
          required: ['server', 'name'],
        },
      },
    },
  ]

  const getResourceServers = () => [...connected.values()].filter(
    server => Boolean(server.client.getServerCapabilities()?.resources),
  )
  const getPromptServers = () => [...connected.values()].filter(
    server => Boolean(server.client.getServerCapabilities()?.prompts),
  )
  const dynamicCollisionFailures = new Set<string>()
  rebuildSchemas = () => {
    const next: McpToolSchema[] = []
    const names = new Set<string>()
    for (const server of connected.values()) {
      for (const schema of server.schemas) {
        if (names.has(schema.function.name)) {
          const message = `${server.name}: MCP tool name collision after refresh: ${schema.function.name}`
          if (!dynamicCollisionFailures.has(message)) {
            dynamicCollisionFailures.add(message)
            failures.push(message)
          }
          continue
        }
        names.add(schema.function.name)
        next.push(schema)
      }
    }
    if (getResourceServers().length) next.push(...resourceSchemas)
    if (getPromptServers().length) next.push(...promptSchemas)
    schemas.splice(0, schemas.length, ...next)
  }
  rebuildSchemas()

  const isRetryableConnectionError = (error: unknown): boolean => {
    const value = error as Error & { code?: number }
    const message = value?.message ?? String(error)
    return (
      (value?.code === 404 && /"code"\s*:\s*-32001|session not found/i.test(message))
      || /connection closed|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|SSE stream disconnected|maximum reconnection attempts/i.test(message)
    )
  }

  const reconnectServer = async (server: ConnectedServer): Promise<ConnectedServer> => {
    await server.client.close().catch(() => undefined)
    const replacement = await connectServer(server.name, server.config, server.cwd, () => rebuildSchemas())
    connected.set(server.name, replacement.server)
    rebuildSchemas()
    return replacement.server
  }

  const run = async (name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> => {
    const startedAt = Date.now()
    if (name === LIST_MCP_RESOURCES_TOOL) {
      const resourceServers = getResourceServers()
      const target = typeof args.server === 'string' ? args.server : undefined
      const selected = target ? resourceServers.filter(server => server.name === target) : resourceServers
      if (target && !selected.length) {
        const message = `找不到支持 resources 的 MCP server "${target}"；可用：${resourceServers.map(server => server.name).join(', ') || '(无)'}`
        return {
          ok: false,
          output: message,
          error: { code: 'mcp_server_not_found', message },
          durationMs: Date.now() - startedAt,
        }
      }
      const timeout = positiveEnvInt('AI_MCP_TOOL_TIMEOUT_MS', 120_000)
      const listed = await Promise.all(selected.map(async server => {
        try {
          const resources = await listAllResources(server.client, timeout, signal)
          return resources.map(resource => ({
            server: server.name,
            uri: resource.uri,
            name: resource.name,
            description: resource.description,
            mimeType: resource.mimeType,
          }))
        } catch (error) {
          return [{ server: server.name, error: error instanceof Error ? error.message : String(error) }]
        }
      }))
      const output = preserveLargeMcpText(stringifyJson(listed.flat()), 'resource-list')
      return {
        ok: true,
        output,
        evidence: { kind: 'legacy' },
        durationMs: Date.now() - startedAt,
      }
    }
    if (name === READ_MCP_RESOURCE_TOOL) {
      const resourceServers = getResourceServers()
      const serverName = typeof args.server === 'string' ? args.server : ''
      const uri = typeof args.uri === 'string' ? args.uri : ''
      const server = resourceServers.find(candidate => candidate.name === serverName)
      if (!server || !uri) {
        const message = !server
          ? `找不到支持 resources 的 MCP server "${serverName}"`
          : 'read_mcp_resource 缺少 uri'
        return {
          ok: false,
          output: message,
          error: { code: 'invalid_mcp_resource', message },
          durationMs: Date.now() - startedAt,
        }
      }
      try {
        const result = await server.client.readResource(
          { uri },
          { signal, timeout: positiveEnvInt('AI_MCP_TOOL_TIMEOUT_MS', 120_000) },
        )
        return mcpResourceResultToToolResult(result, startedAt)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          ok: false,
          output: `MCP resource 读取失败: ${message}`,
          error: { code: 'mcp_resource_failed', message },
          durationMs: Date.now() - startedAt,
        }
      }
    }
    if (name === LIST_MCP_PROMPTS_TOOL) {
      const promptServers = getPromptServers()
      const target = typeof args.server === 'string' ? args.server : undefined
      const selected = target ? promptServers.filter(server => server.name === target) : promptServers
      if (target && !selected.length) {
        const message = `找不到支持 prompts 的 MCP server "${target}"；可用：${promptServers.map(server => server.name).join(', ') || '(无)'}`
        return {
          ok: false,
          output: message,
          error: { code: 'mcp_server_not_found', message },
          durationMs: Date.now() - startedAt,
        }
      }
      const timeout = positiveEnvInt('AI_MCP_TOOL_TIMEOUT_MS', 120_000)
      const listed = await Promise.all(selected.map(async server => {
        try {
          const prompts = await listAllPrompts(server.client, timeout, signal)
          return prompts.map(prompt => ({
            server: server.name,
            name: prompt.name,
            title: prompt.title,
            description: prompt.description,
            arguments: prompt.arguments,
          }))
        } catch (error) {
          return [{ server: server.name, error: error instanceof Error ? error.message : String(error) }]
        }
      }))
      return {
        ok: true,
        output: preserveLargeMcpText(stringifyJson(listed.flat()), 'prompt-list'),
        evidence: { kind: 'legacy' },
        durationMs: Date.now() - startedAt,
      }
    }
    if (name === GET_MCP_PROMPT_TOOL) {
      const serverName = typeof args.server === 'string' ? args.server : ''
      const promptName = typeof args.name === 'string' ? args.name : ''
      const server = getPromptServers().find(candidate => candidate.name === serverName)
      if (!server || !promptName) {
        const message = !server
          ? `找不到支持 prompts 的 MCP server "${serverName}"`
          : 'get_mcp_prompt 缺少 name'
        return {
          ok: false,
          output: message,
          error: { code: 'invalid_mcp_prompt', message },
          durationMs: Date.now() - startedAt,
        }
      }
      const promptArgs = isRecord(args.arguments)
        ? Object.fromEntries(Object.entries(args.arguments).map(([key, value]) => [key, String(value)]))
        : undefined
      try {
        const result = await server.client.getPrompt(
          { name: promptName, arguments: promptArgs },
          { signal, timeout: positiveEnvInt('AI_MCP_TOOL_TIMEOUT_MS', 120_000) },
        )
        return mcpPromptResultToToolResult(result, startedAt)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          ok: false,
          output: `MCP prompt 获取失败: ${message}`,
          error: { code: 'mcp_prompt_failed', message },
          durationMs: Date.now() - startedAt,
        }
      }
    }
    for (const server of connected.values()) {
      const originalName = server.tools.get(name)
      if (!originalName) continue
      try {
        const result = await server.client.callTool(
          { name: originalName, arguments: args },
          undefined,
          {
            signal,
            timeout: positiveEnvInt('AI_MCP_TOOL_TIMEOUT_MS', 120_000),
            resetTimeoutOnProgress: true,
          },
        )
        return mcpCallResultToToolResult(result, startedAt)
      } catch (error) {
        if (isRetryableConnectionError(error) && !signal?.aborted) {
          try {
            const reconnected = await reconnectServer(server)
            const retryName = reconnected.tools.get(name)
            if (!retryName) throw new Error(`reconnected server no longer provides tool ${name}`)
            const retried = await reconnected.client.callTool(
              { name: retryName, arguments: args },
              undefined,
              {
                signal,
                timeout: positiveEnvInt('AI_MCP_TOOL_TIMEOUT_MS', 120_000),
                resetTimeoutOnProgress: true,
              },
            )
            return mcpCallResultToToolResult(retried, startedAt)
          } catch (retryError) {
            error = retryError
          }
        }
        const message = error instanceof Error ? error.message : String(error)
        return {
          ok: false,
          output: `MCP 工具调用失败: ${message}`,
          error: { code: 'mcp_call_failed', message },
          durationMs: Date.now() - startedAt,
        }
      }
    }
    return {
      ok: false,
      output: `未知 MCP 工具: ${name}`,
      error: { code: 'unknown_mcp_tool', message: `未知 MCP 工具: ${name}` },
      durationMs: Date.now() - startedAt,
    }
  }

  let closed = false
  const refresh = async (): Promise<void> => {
    if (closed) return
    const results = await Promise.allSettled([...connected.values()].map(server => server.refreshTools()))
    results.forEach((result, index) => {
      if (result.status !== 'rejected') return
      const server = [...connected.values()][index]
      const message = `${server?.name ?? 'unknown'}: MCP refresh failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`
      if (!failures.includes(message)) failures.push(message)
    })
    rebuildSchemas()
  }
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    await Promise.allSettled([...connected.values()].map(server => server.client.close()))
    connected.clear()
  }

  const instructionBlocks = [...connected.values()].flatMap(server => {
    const raw = server.client.getInstructions()?.trim()
    if (!raw) return []
    const clipped = raw.length > MAX_DESCRIPTION_LENGTH
      ? raw.slice(0, MAX_DESCRIPTION_LENGTH) + '…'
      : raw
    return [`## ${server.name}\n${clipped}`]
  })
  const instructions = instructionBlocks.length
    ? `# MCP Server Instructions\n\n${instructionBlocks.join('\n\n')}`.slice(0, 10_000)
    : undefined

  return { schemas, failures, instructions, run, refresh, getSchemas: () => [...schemas], close }
}

export function summarizeMcpServer(config: McpServerConfig): string {
  if (config.type === 'http' || config.type === 'sse' || config.type === 'ws') {
    return `${config.type.toUpperCase()} ${config.url}`
  }
  return `stdio ${[config.command, ...(config.args ?? [])].join(' ')}`
}
