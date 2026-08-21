import { dirname } from 'node:path'
import type { McpRemoteServerConfig, McpServerConfig } from './config.js'
import {
  authenticateMcpServer,
  clearMcpOAuth,
  getMcpOAuthStatus,
} from './mcp-auth.js'
import {
  addMcpServerConfig,
  createMcpRuntime,
  loadMcpConfiguration,
  removeMcpServerConfig,
  summarizeMcpServer,
  type McpConfigScope,
} from './mcp.js'

const HELP = `ai mcp — 管理 Model Context Protocol servers

用法:
  ai mcp list
  ai mcp get <名字>
  ai mcp test <名字>
  ai mcp auth|login <名字> [--no-browser]
  ai mcp logout <名字>
  ai mcp prompts [server]
  ai mcp prompt <server> <prompt> [KEY=value...]
  ai mcp remove <名字> [--scope local|user|project]
  ai mcp add [--scope local|user|project] [--transport stdio|http|sse|ws] <名字> <命令或URL> [参数...]
  ai mcp add [--scope local|user|project] <名字> --url <URL>
  ai mcp add-json [--scope local|user|project] <名字> '<JSON>'

示例:
  ai mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem .
  ai mcp add -e API_KEY=xxx github -- npx -y @modelcontextprotocol/server-github
  ai mcp add --transport http -H 'Authorization: Bearer \${TOKEN}' sentry https://example.com/mcp
  ai mcp add dcpv2 --url https://example.com/mcp/dcpv2
  ai mcp add --transport ws realtime wss://example.com/mcp
  ai mcp add --transport http --client-id my-client --callback-port 3118 remote https://example.com/mcp
  ai mcp add --scope project local-tools -- node ./tools/mcp-server.mjs

说明:
  默认 scope 为 local（只对当前项目、本机生效）；user 全局生效；project 写入可共享的 .mcp.json。
  stdio server 的命令参数以 - 开头时，建议在命令前加 --。
  OAuth 支持 --client-id、--client-secret 和 --callback-port；secret 从环境变量读取，不写入配置。
  配置值支持 \${VAR} 与 \${VAR:-default} 环境变量展开。`

function parseScope(value: string | undefined): McpConfigScope {
  if (value === 'local' || value === 'user' || value === 'project') return value
  throw new Error('--scope 只能是 local、user 或 project')
}

function parseKeyValue(raw: string, flag: string): [string, string] {
  const index = raw.indexOf('=')
  if (index <= 0) throw new Error(`${flag} 需要 KEY=value`)
  return [raw.slice(0, index), raw.slice(index + 1)]
}

function parseHeader(raw: string): [string, string] {
  const index = raw.indexOf(':')
  if (index <= 0) throw new Error('-H/--header 需要 "Header-Name: value"')
  return [raw.slice(0, index).trim(), raw.slice(index + 1).trim()]
}

type AddOptions = {
  scope: McpConfigScope
  transport: 'stdio' | 'http' | 'sse' | 'ws'
  name: string
  target: string
  serverArgs: string[]
  env: Record<string, string>
  headers: Record<string, string>
  headersHelper?: string
  clientId?: string
  callbackPort?: number
  clientSecretRequested: boolean
}

function parseAddArgs(args: string[]): AddOptions {
  let scope: McpConfigScope = 'local'
  let transport: AddOptions['transport'] = 'stdio'
  let transportExplicit = false
  let urlTarget: string | undefined
  const env: Record<string, string> = {}
  const headers: Record<string, string> = {}
  const positional: string[] = []
  let headersHelper: string | undefined
  let clientId: string | undefined
  let callbackPort: number | undefined
  let clientSecretRequested = false
  let afterDelimiter = false

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (afterDelimiter) {
      positional.push(arg)
      continue
    }
    if (arg === '--') {
      afterDelimiter = true
      continue
    }
    if (arg === '--scope' || arg === '-s') {
      scope = parseScope(args[++index])
      continue
    }
    if (arg === '--transport' || arg === '-t') {
      const value = args[++index]
      if (value !== 'stdio' && value !== 'http' && value !== 'sse' && value !== 'ws') {
        throw new Error('--transport 只能是 stdio、http、sse 或 ws')
      }
      transport = value
      transportExplicit = true
      continue
    }
    if (arg === '--url') {
      const value = args[++index]
      if (!value) throw new Error('--url 需要 URL')
      if (urlTarget) throw new Error('--url 只能指定一次')
      urlTarget = value
      if (!transportExplicit) transport = 'http'
      continue
    }
    if (arg === '--env' || arg === '-e') {
      const [key, value] = parseKeyValue(args[++index] ?? '', arg)
      env[key] = value
      continue
    }
    if (arg === '--header' || arg === '-H') {
      const [key, value] = parseHeader(args[++index] ?? '')
      headers[key] = value
      continue
    }
    if (arg === '--headers-helper') {
      headersHelper = args[++index]
      if (!headersHelper) throw new Error('--headers-helper 需要命令')
      continue
    }
    if (arg === '--client-id') {
      clientId = args[++index]
      if (!clientId) throw new Error('--client-id 需要值')
      continue
    }
    if (arg === '--client-secret') {
      clientSecretRequested = true
      continue
    }
    if (arg === '--callback-port') {
      const value = Number(args[++index])
      if (!Number.isInteger(value) || value <= 0 || value > 65535) {
        throw new Error('--callback-port 必须是 1 到 65535 的整数')
      }
      callbackPort = value
      continue
    }
    if (arg.startsWith('-')) throw new Error(`未知参数: ${arg}`)
    positional.push(arg)
  }

  const name = positional[0]
  const target = urlTarget ?? positional[1]
  const serverArgs = urlTarget ? positional.slice(1) : positional.slice(2)
  if (!name || !target) throw new Error('add 需要 <名字> 和 <命令或URL>')
  if (urlTarget && transport === 'stdio') {
    throw new Error('--url 适用于 http、sse 或 ws transport，不能与 stdio 一起使用')
  }
  if ((transport === 'http' || transport === 'sse' || transport === 'ws') && serverArgs.length) {
    throw new Error(`${transport} transport 不接受命令参数`)
  }
  if (clientSecretRequested) {
    if (!clientId) throw new Error('--client-secret 需要同时提供 --client-id')
    const specific = `AI_MCP_${name.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}_CLIENT_SECRET`
    if (!process.env[specific] && !process.env.MCP_CLIENT_SECRET) {
      throw new Error(`--client-secret 已指定；请先设置 ${specific} 或 MCP_CLIENT_SECRET 环境变量`)
    }
  }
  return {
    scope,
    transport,
    name,
    target,
    serverArgs,
    env,
    headers,
    headersHelper,
    clientId,
    callbackPort,
    clientSecretRequested,
  }
}

function redactedConfig(config: McpServerConfig): Record<string, unknown> {
  if (config.type === 'http' || config.type === 'sse' || config.type === 'ws') {
    return {
      ...config,
      headers: config.headers
        ? Object.fromEntries(Object.keys(config.headers).map(key => [key, '<configured>']))
        : undefined,
    }
  }
  return {
    ...config,
    env: config.env
      ? Object.fromEntries(Object.keys(config.env).map(key => [key, '<configured>']))
      : undefined,
  }
}

function parseOptionalScope(args: string[]): McpConfigScope | undefined {
  if (!args.length) return undefined
  if (args.length !== 2 || (args[0] !== '--scope' && args[0] !== '-s')) {
    throw new Error('只支持可选参数 --scope local|user|project')
  }
  return parseScope(args[1])
}

async function checkServerHealth(
  name: string,
  config: McpServerConfig,
  cwd: string,
): Promise<string> {
  if (config.disabled) return 'disabled'
  let runtime
  try {
    runtime = await createMcpRuntime({ cwd, servers: { [name]: config } })
  } catch (error) {
    return `failed: ${error instanceof Error ? error.message : String(error)}`
  }
  try {
    if (!runtime.failures.length) {
      const toolCount = runtime.getSchemas().filter(schema => schema.function.name.startsWith('mcp__')).length
      return `connected (${toolCount} tools)`
    }
    if (runtime.failures.some(failure => /需要 OAuth 认证/.test(failure))) return 'needs authentication'
    return `failed: ${runtime.failures.join('; ')}`
  } finally {
    await runtime.close()
  }
}

export async function runMcpCli(args: string[], cwd: string = process.cwd()): Promise<number> {
  const command = args[0]
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(HELP)
    return 0
  }

  try {
    if (command === 'list') {
      const loaded = loadMcpConfiguration(cwd)
      for (const error of loaded.errors) console.error(`! ${error}`)
      const entries = Object.entries(loaded.servers)
      if (!entries.length) {
        console.log('没有配置 MCP server。用 `ai mcp add ...` 添加。')
        return loaded.errors.length ? 1 : 0
      }
      console.log(`正在检查 ${entries.length} 个 MCP server：\n`)
      const statuses = await Promise.all(entries.map(([name, config]) => checkServerHealth(name, config, cwd)))
      for (let index = 0; index < entries.length; index++) {
        const [name, config] = entries[index]
        const source = loaded.sources[name]
        const disabled = config.disabled ? ' [disabled]' : ''
        const auth = config.type === 'http' || config.type === 'sse'
          ? `  [auth: ${getMcpOAuthStatus(name, config)}]`
          : ''
        console.log(`  ${name}${disabled}  ${summarizeMcpServer(config)}${auth}`)
        console.log(`    status: ${statuses[index]}`)
        console.log(`    ${source.scope}: ${source.file}`)
      }
      return loaded.errors.length ? 1 : 0
    }

    if (command === 'get') {
      const name = args[1]
      if (!name || args.length !== 2) throw new Error('用法: ai mcp get <名字>')
      const loaded = loadMcpConfiguration(cwd)
      const config = loaded.servers[name]
      if (!config) throw new Error(`没有找到 MCP server "${name}"`)
      console.log(`${name}:`)
      console.log(`  source: ${loaded.sources[name].scope} (${loaded.sources[name].file})`)
      console.log(`  status: ${await checkServerHealth(name, config, cwd)}`)
      if (config.type === 'http' || config.type === 'sse') {
        console.log(`  auth: ${getMcpOAuthStatus(name, config)}`)
      }
      console.log(JSON.stringify(redactedConfig(config), null, 2))
      return 0
    }

    if (command === 'add') {
      const options = parseAddArgs(args.slice(1))
      let config: McpServerConfig
      if (options.transport === 'http' || options.transport === 'sse' || options.transport === 'ws') {
        config = {
          type: options.transport,
          url: options.target,
          headers: Object.keys(options.headers).length ? options.headers : undefined,
          headersHelper: options.headersHelper,
          ...(options.transport !== 'ws' && (options.clientId || options.callbackPort)
            ? { oauth: { clientId: options.clientId, callbackPort: options.callbackPort } }
            : {}),
        }
        if (options.transport === 'ws' && (options.clientId || options.callbackPort || options.clientSecretRequested)) {
          throw new Error('ws transport 不支持 OAuth 参数；请使用 -H 或 --headers-helper 提供认证头')
        }
        if (Object.keys(options.env).length) throw new Error('-e/--env 只适用于 stdio server')
      } else {
        config = {
          type: 'stdio',
          command: options.target,
          args: options.serverArgs,
          env: Object.keys(options.env).length ? options.env : undefined,
        }
        if (Object.keys(options.headers).length) throw new Error('-H/--header 只适用于 http/sse/ws server')
        if (options.headersHelper || options.clientId || options.callbackPort || options.clientSecretRequested) {
          throw new Error('--headers-helper、--client-id、--client-secret、--callback-port 只适用于远程 server')
        }
      }
      const file = addMcpServerConfig(options.name, config, options.scope, cwd)
      console.log(`✓ 已添加 MCP server "${options.name}"（${options.transport}）`)
      console.log(`  配置: ${file}`)
      console.log(`  可运行 ai mcp test ${options.name} 验证连接。`)
      return 0
    }

    if (command === 'add-json') {
      let scope: McpConfigScope = 'local'
      const positional: string[] = []
      for (let index = 1; index < args.length; index++) {
        if (args[index] === '--scope' || args[index] === '-s') scope = parseScope(args[++index])
        else positional.push(args[index])
      }
      const [name, json] = positional
      if (!name || !json || positional.length !== 2) {
        throw new Error("用法: ai mcp add-json [--scope local|user|project] <名字> '<JSON>'")
      }
      let parsed: unknown
      try { parsed = JSON.parse(json) } catch (error) {
        throw new Error(`MCP JSON 无效: ${error instanceof Error ? error.message : String(error)}`)
      }
      const file = addMcpServerConfig(name, parsed as McpServerConfig, scope, cwd)
      console.log(`✓ 已添加 MCP server "${name}"`)
      console.log(`  配置: ${file}`)
      return 0
    }

    if (command === 'auth' || command === 'login') {
      const name = args[1]
      const extra = args.slice(2)
      if (!name || extra.some(arg => arg !== '--no-browser')) {
        throw new Error('用法: ai mcp auth|login <名字> [--no-browser]')
      }
      const loaded = loadMcpConfiguration(cwd)
      const config = loaded.servers[name]
      if (!config) throw new Error(`没有找到 MCP server "${name}"`)
      if (config.type !== 'http' && config.type !== 'sse') {
        throw new Error(`MCP server "${name}" 是 stdio transport，不使用 OAuth`)
      }
      const result = await authenticateMcpServer(name, config, {
        openBrowser: !extra.includes('--no-browser'),
      })
      console.log(result.alreadyAuthenticated
        ? `✓ ${name} 已通过认证，连接正常`
        : `✓ ${name} OAuth 认证成功，连接正常`)
      return 0
    }

    if (command === 'logout') {
      const name = args[1]
      if (!name || args.length !== 2) throw new Error('用法: ai mcp logout <名字>')
      const loaded = loadMcpConfiguration(cwd)
      const config = loaded.servers[name]
      if (!config) throw new Error(`没有找到 MCP server "${name}"`)
      if (config.type !== 'http' && config.type !== 'sse') {
        throw new Error(`MCP server "${name}" 是 stdio transport，没有 OAuth 凭据`)
      }
      clearMcpOAuth(name, config)
      console.log(`✓ 已清除 ${name} 的 OAuth 凭据`)
      return 0
    }

    if (command === 'prompts') {
      if (args.length > 2) throw new Error('用法: ai mcp prompts [server]')
      const serverName = args[1]
      const loaded = loadMcpConfiguration(cwd)
      const servers = serverName
        ? loaded.servers[serverName] ? { [serverName]: loaded.servers[serverName] } : undefined
        : loaded.servers
      if (!servers) throw new Error(`没有找到 MCP server "${serverName}"`)
      const runtime = await createMcpRuntime({ cwd, servers })
      try {
        if (runtime.failures.length) {
          for (const failure of runtime.failures) console.error(`✗ ${failure}`)
        }
        if (!runtime.getSchemas().some(schema => schema.function.name === 'list_mcp_prompts')) {
          console.log('没有已连接的 MCP server 提供 prompts。')
          return runtime.failures.length ? 1 : 0
        }
        const result = await runtime.run('list_mcp_prompts', serverName ? { server: serverName } : {})
        console.log(result.output)
        return result.ok ? 0 : 1
      } finally {
        await runtime.close()
      }
    }

    if (command === 'prompt') {
      const serverName = args[1]
      const promptName = args[2]
      if (!serverName || !promptName) {
        throw new Error('用法: ai mcp prompt <server> <prompt> [KEY=value...]')
      }
      const promptArgs: Record<string, string> = {}
      for (const raw of args.slice(3)) {
        const [key, value] = parseKeyValue(raw, 'prompt argument')
        promptArgs[key] = value
      }
      const loaded = loadMcpConfiguration(cwd)
      const config = loaded.servers[serverName]
      if (!config) throw new Error(`没有找到 MCP server "${serverName}"`)
      const runtime = await createMcpRuntime({ cwd, servers: { [serverName]: config } })
      try {
        if (runtime.failures.length) {
          for (const failure of runtime.failures) console.error(`✗ ${failure}`)
          return 1
        }
        const result = await runtime.run('get_mcp_prompt', {
          server: serverName,
          name: promptName,
          arguments: promptArgs,
        })
        console.log(result.output)
        return result.ok ? 0 : 1
      } finally {
        await runtime.close()
      }
    }

    if (command === 'remove' || command === 'rm') {
      const name = args[1]
      if (!name) throw new Error('用法: ai mcp remove <名字> [--scope local|user|project]')
      const configBeforeRemoval = loadMcpConfiguration(cwd).servers[name]
      const explicitScope = parseOptionalScope(args.slice(2))
      let scope = explicitScope
      let projectCwd = cwd
      if (!scope) {
        const loaded = loadMcpConfiguration(cwd)
        const source = loaded.sources[name]
        if (!source) throw new Error(`没有找到 MCP server "${name}"`)
        scope = source.scope
        if (scope === 'project') projectCwd = dirname(source.file)
      }
      const file = removeMcpServerConfig(name, scope, projectCwd)
      if (configBeforeRemoval?.type === 'http' || configBeforeRemoval?.type === 'sse') {
        clearMcpOAuth(name, configBeforeRemoval as McpRemoteServerConfig)
      }
      console.log(`✓ 已从 ${scope} 配置移除 MCP server "${name}"`)
      console.log(`  配置: ${file}`)
      return 0
    }

    if (command === 'test') {
      const name = args[1]
      if (!name || args.length !== 2) throw new Error('用法: ai mcp test <名字>')
      const loaded = loadMcpConfiguration(cwd)
      const config = loaded.servers[name]
      if (!config) throw new Error(`没有找到 MCP server "${name}"`)
      if (config.disabled) throw new Error(`MCP server "${name}" 已 disabled`)
      const runtime = await createMcpRuntime({ cwd, servers: { [name]: config } })
      try {
        if (runtime.failures.length) {
          for (const failure of runtime.failures) console.error(`✗ ${failure}`)
          return 1
        }
        const tools = runtime.getSchemas().filter(schema => schema.function.name.startsWith('mcp__'))
        console.log(`✓ ${name} 连接成功，发现 ${tools.length} 个工具`)
        for (const schema of tools) console.log(`  - ${schema.function.name}`)
        if (runtime.getSchemas().some(schema => schema.function.name === 'list_mcp_resources')) {
          console.log('  capabilities: resources')
        }
        if (runtime.getSchemas().some(schema => schema.function.name === 'list_mcp_prompts')) {
          console.log('  capabilities: prompts')
        }
        return 0
      } finally {
        await runtime.close()
      }
    }

    throw new Error(`未知 MCP 命令: ${command}\n\n${HELP}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}
