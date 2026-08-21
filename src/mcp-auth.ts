import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type Server } from 'node:http'
import { dirname, join } from 'node:path'
import {
  UnauthorizedError,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { CONFIG_PATH, type McpRemoteServerConfig } from './config.js'

type StoredOAuthServer = {
  serverName: string
  serverUrl: string
  clientInformation?: OAuthClientInformationMixed
  tokens?: OAuthTokens
  codeVerifier?: string
  state?: string
  discovery?: OAuthDiscoveryState
  updatedAt: number
}

type OAuthStore = {
  version: 1
  servers: Record<string, StoredOAuthServer>
}

export type McpOAuthStatus = 'authenticated' | 'not-authenticated'

export type McpOAuthResult = {
  status: 'authenticated'
  alreadyAuthenticated: boolean
}

const DEFAULT_CALLBACK_PORT = 3118
const AUTH_TIMEOUT_MS = 5 * 60_000

function authStorePath(): string {
  return process.env.AI_MCP_AUTH_STORE || join(dirname(CONFIG_PATH), 'mcp-auth.json')
}

function emptyStore(): OAuthStore {
  return { version: 1, servers: {} }
}

function readStore(): OAuthStore {
  const file = authStorePath()
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as OAuthStore
    if (parsed?.version === 1 && parsed.servers && typeof parsed.servers === 'object') return parsed
  } catch {
    // Missing or corrupt auth state behaves as signed out. It never blocks MCP startup.
  }
  return emptyStore()
}

function writeStore(store: OAuthStore): void {
  const file = authStorePath()
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.tmp.${process.pid}.${Date.now()}`
  try {
    writeFileSync(temp, JSON.stringify(store, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    chmodSync(temp, 0o600)
    renameSync(temp, file)
  } catch (error) {
    try { unlinkSync(temp) } catch { /* best effort */ }
    throw error
  }
}

function serverKey(name: string, url: string): string {
  const hash = createHash('sha256').update(url).digest('hex').slice(0, 16)
  return `${name}:${hash}`
}

function configuredCallbackPort(config: McpRemoteServerConfig): number {
  const fromEnv = Number(process.env.AI_MCP_OAUTH_CALLBACK_PORT)
  if (Number.isInteger(fromEnv) && fromEnv > 0 && fromEnv <= 65535) return fromEnv
  return config.oauth?.callbackPort ?? DEFAULT_CALLBACK_PORT
}

function callbackUrl(config: McpRemoteServerConfig): string {
  return `http://127.0.0.1:${configuredCallbackPort(config)}/callback`
}

function normalizeSameHostProxyUrl(value: string, serverUrl: string): string {
  let candidate: URL
  let expected: URL
  try {
    candidate = new URL(value)
    expected = new URL(serverUrl)
  } catch {
    return value
  }
  if (
    expected.protocol !== 'https:'
    || candidate.protocol !== 'http:'
    || candidate.hostname !== expected.hostname
    || ((candidate.port || expected.port) && candidate.port !== expected.port)
  ) return value
  candidate.protocol = 'https:'
  if (candidate.port === '80') candidate.port = expected.port
  return candidate.toString()
}

function normalizeDiscoveryValue<T>(value: T, serverUrl: string): T {
  if (typeof value === 'string') return normalizeSameHostProxyUrl(value, serverUrl) as T
  if (Array.isArray(value)) return value.map(item => normalizeDiscoveryValue(item, serverUrl)) as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      normalizeDiscoveryValue(item, serverUrl),
    ])) as T
  }
  return value
}

/**
 * Keep OAuth traffic on HTTPS when an MCP service behind a same-host reverse proxy
 * publishes internal `http://` URLs in RFC 8414/9728 metadata. Cross-host URLs and
 * explicit mismatched ports are never rewritten.
 */
export function createMcpOAuthFetch(config: McpRemoteServerConfig): FetchLike {
  return async (url, init) => {
    const originalUrl = new URL(url)
    const secureUrl = new URL(normalizeSameHostProxyUrl(originalUrl.toString(), config.url))
    const isAuthorizationMetadata = secureUrl.pathname.includes('/.well-known/oauth-authorization-server')
      || secureUrl.pathname.includes('/.well-known/openid-configuration')
    const requestUrl = isAuthorizationMetadata && config.oauth?.authServerMetadataUrl
      ? new URL(config.oauth.authServerMetadataUrl)
      : secureUrl
    const response = await fetch(requestUrl, init)
    const isDiscovery = secureUrl.pathname.includes('/.well-known/oauth-')
      || secureUrl.pathname.includes('/.well-known/openid-configuration')
    if (!isDiscovery || !response.headers.get('content-type')?.includes('application/json')) return response

    const raw = await response.clone().json().catch(() => undefined)
    if (!raw || typeof raw !== 'object') return response
    const normalized = normalizeDiscoveryValue(raw, config.url)
    const headers = new Headers(response.headers)
    headers.delete('content-length')
    return new Response(JSON.stringify(normalized), {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  }
}

function configuredClientSecret(name: string): string | undefined {
  const specific = `AI_MCP_${name.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}_CLIENT_SECRET`
  return process.env[specific] || process.env.MCP_CLIENT_SECRET
}

function updateServer(
  name: string,
  config: McpRemoteServerConfig,
  update: (current: StoredOAuthServer) => StoredOAuthServer,
): void {
  const store = readStore()
  const key = serverKey(name, config.url)
  const current = store.servers[key] ?? {
    serverName: name,
    serverUrl: config.url,
    updatedAt: Date.now(),
  }
  store.servers[key] = update(current)
  writeStore(store)
}

export class AiMcpOAuthProvider implements OAuthClientProvider {
  private codeVerifierValue?: string
  private stateValue = randomBytes(32).toString('base64url')

  constructor(
    readonly serverName: string,
    readonly config: McpRemoteServerConfig,
    private readonly onAuthorizationUrl?: (url: URL) => void | Promise<void>,
  ) {}

  get redirectUrl(): string {
    return callbackUrl(this.config)
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: `ai CLI (${this.serverName})`,
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: this.config.oauth?.clientId ? undefined : 'none',
    }
  }

  async state(): Promise<string> {
    updateServer(this.serverName, this.config, current => ({
      ...current,
      state: this.stateValue,
      updatedAt: Date.now(),
    }))
    return this.stateValue
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const configuredId = this.config.oauth?.clientId
    if (configuredId) {
      return {
        client_id: configuredId,
        client_secret: configuredClientSecret(this.serverName),
      }
    }
    return readStore().servers[serverKey(this.serverName, this.config.url)]?.clientInformation
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    updateServer(this.serverName, this.config, current => ({
      ...current,
      clientInformation,
      updatedAt: Date.now(),
    }))
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return readStore().servers[serverKey(this.serverName, this.config.url)]?.tokens
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    updateServer(this.serverName, this.config, current => ({
      ...current,
      tokens,
      codeVerifier: undefined,
      state: undefined,
      updatedAt: Date.now(),
    }))
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (this.onAuthorizationUrl) await this.onAuthorizationUrl(authorizationUrl)
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    this.codeVerifierValue = codeVerifier
    updateServer(this.serverName, this.config, current => ({
      ...current,
      codeVerifier,
      updatedAt: Date.now(),
    }))
  }

  async codeVerifier(): Promise<string> {
    const value = this.codeVerifierValue
      ?? readStore().servers[serverKey(this.serverName, this.config.url)]?.codeVerifier
    if (!value) throw new Error(`MCP OAuth code verifier 不存在，请重新运行 ai mcp auth ${this.serverName}`)
    return value
  }

  async saveDiscoveryState(discovery: OAuthDiscoveryState): Promise<void> {
    const normalized = normalizeDiscoveryValue(discovery, this.config.url)
    updateServer(this.serverName, this.config, current => ({
      ...current,
      discovery: normalized,
      updatedAt: Date.now(),
    }))
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    const discovery = readStore().servers[serverKey(this.serverName, this.config.url)]?.discovery
    return discovery ? normalizeDiscoveryValue(discovery, this.config.url) : undefined
  }

  async validateResourceURL(serverUrl: string | URL, resource?: string): Promise<URL | undefined> {
    if (!resource) return undefined
    const expected = new URL(serverUrl)
    const normalized = new URL(normalizeSameHostProxyUrl(resource, expected.toString()))
    const sameOrigin = normalized.origin === expected.origin
    const sameResource = normalized.pathname === expected.pathname
      && normalized.search === expected.search
    const originResource = normalized.pathname === '/' && !normalized.search && !normalized.hash
    if (!sameOrigin || (!sameResource && !originResource)) {
      throw new Error(`OAuth protected resource ${resource} does not match MCP server ${expected.toString()}`)
    }
    return normalized
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    updateServer(this.serverName, this.config, current => {
      const next = { ...current, updatedAt: Date.now() }
      if (scope === 'all' || scope === 'client') next.clientInformation = undefined
      if (scope === 'all' || scope === 'tokens') next.tokens = undefined
      if (scope === 'all' || scope === 'verifier') next.codeVerifier = undefined
      if (scope === 'all' || scope === 'discovery') next.discovery = undefined
      return next
    })
  }
}

export function getMcpOAuthStatus(name: string, config: McpRemoteServerConfig): McpOAuthStatus {
  const tokens = readStore().servers[serverKey(name, config.url)]?.tokens
  return tokens?.access_token ? 'authenticated' : 'not-authenticated'
}

export function clearMcpOAuth(name: string, config: McpRemoteServerConfig): void {
  const store = readStore()
  const key = serverKey(name, config.url)
  if (!Object.hasOwn(store.servers, key)) return
  delete store.servers[key]
  writeStore(store)
}

export function createMcpOAuthProvider(
  name: string,
  config: McpRemoteServerConfig,
  onAuthorizationUrl?: (url: URL) => void | Promise<void>,
): AiMcpOAuthProvider {
  return new AiMcpOAuthProvider(name, config, onAuthorizationUrl)
}

function openBrowser(url: URL): void {
  const command = process.platform === 'darwin'
    ? 'open'
    : process.platform === 'win32'
      ? 'cmd'
      : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url.toString()] : [url.toString()]
  const child = spawn(command, args, { detached: true, stdio: 'ignore' })
  child.unref()
}

function startCallbackServer(
  port: number,
  expectedState: string,
): Promise<{ server: Server; result: Promise<string> }> {
  let resolveCode!: (code: string) => void
  let rejectCode!: (error: Error) => void
  const result = new Promise<string>((resolve, reject) => {
    resolveCode = resolve
    rejectCode = reject
  })
  let settled = false
  const finish = (error?: Error, code?: string) => {
    if (settled) return
    settled = true
    if (error) rejectCode(error)
    else resolveCode(code!)
  }
  const server = createServer((request, response) => {
    try {
      const url = new URL(request.url || '/', `http://127.0.0.1:${port}`)
      if (url.pathname !== '/callback') {
        response.writeHead(404).end('Not found')
        return
      }
      const oauthError = url.searchParams.get('error')
      const state = url.searchParams.get('state')
      const code = url.searchParams.get('code')
      if (oauthError) throw new Error(`OAuth 授权失败: ${oauthError}`)
      if (!state || state !== expectedState) throw new Error('OAuth state 校验失败，请重新认证')
      if (!code) throw new Error('OAuth callback 缺少 authorization code')
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      response.end('<!doctype html><meta charset="utf-8"><title>ai MCP</title><h1>认证成功</h1><p>可以关闭这个窗口，返回终端。</p>')
      finish(undefined, code)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end(message)
      finish(new Error(message))
    }
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject)
      resolve({ server, result })
    })
  })
}

function transportForAuth(config: McpRemoteServerConfig, provider: OAuthClientProvider) {
  const oauthFetch = createMcpOAuthFetch(config)
  if (config.type === 'sse') {
    return new SSEClientTransport(new URL(config.url), {
      authProvider: provider,
      requestInit: { headers: config.headers },
      fetch: oauthFetch,
    })
  }
  return new StreamableHTTPClientTransport(new URL(config.url), {
    authProvider: provider,
    requestInit: { headers: config.headers },
    fetch: oauthFetch,
  })
}

async function verifyAuthenticatedConnection(
  name: string,
  config: McpRemoteServerConfig,
  provider: OAuthClientProvider,
): Promise<void> {
  const client = new Client({ name: 'ai-cli', version: '0.1.0' })
  try {
    await client.connect(transportForAuth(config, provider), { timeout: 20_000 })
  } finally {
    await client.close().catch(() => undefined)
  }
}

/** Complete OAuth Authorization Code + PKCE in the browser, persist tokens, then verify MCP initialization. */
export async function authenticateMcpServer(
  name: string,
  config: McpRemoteServerConfig,
  options: { openBrowser?: boolean; timeoutMs?: number } = {},
): Promise<McpOAuthResult> {
  const provider = createMcpOAuthProvider(name, config, async authorizationUrl => {
    process.stdout.write(`请在浏览器完成 MCP 授权：\n${authorizationUrl.toString()}\n`)
    if (options.openBrowser !== false) openBrowser(authorizationUrl)
  })

  const expectedState = await provider.state()
  const port = configuredCallbackPort(config)
  const callback = await startCallbackServer(port, expectedState)
  const client = new Client({ name: 'ai-cli', version: '0.1.0' })
  const transport = transportForAuth(config, provider)
  try {
    try {
      await client.connect(transport, { timeout: 20_000 })
      return { status: 'authenticated', alreadyAuthenticated: true }
    } catch (error) {
      if (!(error instanceof UnauthorizedError)) throw error
    }

    const timeoutMs = options.timeoutMs ?? AUTH_TIMEOUT_MS
    const code = await Promise.race([
      callback.result,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error('等待 OAuth 浏览器回调超时')), timeoutMs)
        timer.unref?.()
      }),
    ])
    if (!('finishAuth' in transport) || typeof transport.finishAuth !== 'function') {
      throw new Error('当前 MCP transport 不支持完成 OAuth')
    }
    await transport.finishAuth(code)
    await client.close().catch(() => undefined)
    await verifyAuthenticatedConnection(name, config, createMcpOAuthProvider(name, config))
    return { status: 'authenticated', alreadyAuthenticated: false }
  } finally {
    callback.server.close()
    await client.close().catch(() => undefined)
  }
}

export function mcpAuthStoreExists(): boolean {
  return existsSync(authStorePath())
}
