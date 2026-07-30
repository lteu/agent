import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { get as httpGet } from 'node:http'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const sshHost = process.env.AI_CLAUDE_SSH_HOST ?? 'remote'
const remoteGatewayPort = Number(process.env.AI_CLAUDE_REMOTE_GATEWAY_PORT ?? 8791)
const model = process.env.AI_CLAUDE_MODEL ?? 'sonnet'

type SandboxNetworkMode = 'egress' | 'isolated'

type Tunnel = {
  localPort: number
  controlPath: string
  controlDir: string
}

function printHelp(): void {
  console.log(`ai-claude — 本地 AI Agent，模型推理由 remote 上的 Claude 提供

用法:
  ai-claude                    在当前本地目录启动 AI Agent
  ai-claude ask <问题>         本地 Agent 非交互执行任务
  ai-claude ask --file <文件>  从本地文件读取任务
  ai-claude --probe            检查 SSH 隧道与远端 Claude 网关
  ai-claude --sandbox [命令]   在隔离容器中运行本地 Agent
  ai-claude --help             显示帮助

环境变量:
  AI_CLAUDE_SSH_HOST            SSH 主机或别名（默认 remote）
  AI_CLAUDE_REMOTE_GATEWAY_PORT 远端网关端口（默认 8791）
  AI_CLAUDE_MODEL               Claude 模型（默认 sonnet）
  AI_CLAUDE_SANDBOX_IMAGE       sandbox 镜像名（默认 ai-claude-sandbox:local）
  AI_CLAUDE_SANDBOX_NETWORK     egress（默认，可访问公网）或 isolated（禁用公网）
  AI_CLAUDE_SANDBOX_DNS         egress DNS，逗号分隔（默认 1.1.1.1；system 表示跟随 Docker）

Agent、工作目录、Read/Edit/Bash 全部在本机；remote 使用自己的 ~/.claude
认证完成模型推理，只返回文本或工具调用。

sandbox 模式把当前目录挂载为 /workspace。Agent 容器看不到宿主机 HOME、
SSH 密钥和 SSH Agent；独立的隧道容器只负责连接 remote。`)
}

function sandboxNetworkMode(): SandboxNetworkMode {
  const value = (process.env.AI_CLAUDE_SANDBOX_NETWORK ?? 'egress').trim().toLowerCase()
  if (value === 'egress' || value === 'online' || value === 'internet') return 'egress'
  if (value === 'isolated' || value === 'offline' || value === 'internal') return 'isolated'
  throw new Error(
    `AI_CLAUDE_SANDBOX_NETWORK=${JSON.stringify(value)} 无效；只能使用 egress 或 isolated`,
  )
}

function sandboxDnsServers(): string[] {
  const value = (process.env.AI_CLAUDE_SANDBOX_DNS ?? '1.1.1.1').trim()
  if (!value || value.toLowerCase() === 'system') return []
  return value.split(',').map(item => item.trim()).filter(Boolean)
}

function freeLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(error => (error ? reject(error) : resolve(port)))
    })
  })
}

async function openTunnel(): Promise<Tunnel> {
  const localPort = await freeLocalPort()
  const controlDir = mkdtempSync(join(tmpdir(), 'ai-claude-ssh-'))
  const controlPath = join(controlDir, 'control.sock')
  try {
    execFileSync(
      'ssh',
      [
        '-o',
        'BatchMode=yes',
        '-o',
        'ExitOnForwardFailure=yes',
        '-o',
        'ForwardAgent=no',
        '-o',
        'ControlMaster=yes',
        '-o',
        `ControlPath=${controlPath}`,
        '-f',
        '-N',
        '-L',
        `${localPort}:127.0.0.1:${remoteGatewayPort}`,
        sshHost,
      ],
      { stdio: 'inherit' },
    )
    return { localPort, controlPath, controlDir }
  } catch (error) {
    rmSync(controlDir, { recursive: true, force: true })
    throw error
  }
}

function closeTunnel(tunnel: Tunnel): void {
  try {
    execFileSync('ssh', ['-S', tunnel.controlPath, '-O', 'exit', sshHost], { stdio: 'ignore' })
  } catch {
    // SSH may already have exited.
  }
  rmSync(tunnel.controlDir, { recursive: true, force: true })
}

function gatewayGet(localPort: number, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = httpGet(`http://127.0.0.1:${localPort}${path}`, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.once('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        if (response.statusCode !== 200) reject(new Error(`远端网关检查失败（HTTP ${response.statusCode}）`))
        else resolve(body)
      })
    })
    request.setTimeout(3_000, () => request.destroy(new Error('远端网关检查超时')))
    request.once('error', reject)
  })
}

function forwardSignal(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.exitCode == null && child.signalCode == null) child.kill(signal)
}

function docker(args: string[], options: { capture?: boolean; ignoreError?: boolean } = {}): string {
  try {
    return execFileSync('docker', args, {
      encoding: options.capture ? 'utf8' : undefined,
      stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    })?.toString() ?? ''
  } catch (error) {
    if (options.ignoreError) return ''
    throw error
  }
}

function ensureDocker(): void {
  try {
    docker(['version'], { capture: true })
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      throw new Error('未找到 docker；请先安装并启动 Docker Desktop、OrbStack 或 Docker Engine')
    }
    throw new Error('无法连接 Docker；请确认 Docker Desktop、OrbStack 或 Docker Engine 已启动')
  }
}

function sandboxEnv(): Record<string, string> {
  return {
    AI_API_KEY: 'ssh-local-only',
    AI_MODEL: model,
    AI_BASE_URL: 'http://claude-gateway:8791/v1',
    AI_PROVIDER: 'Claude via remote (sandbox)',
    AI_LOG_DIR: '/workspace/log',
    HOME: '/home/agent',
    TERM: process.env.TERM ?? 'xterm-256color',
  }
}

function sanitizedLocalEnv(baseURL: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AI_API_KEY: 'ssh-local-only',
    AI_MODEL: model,
    AI_BASE_URL: baseURL,
    AI_PROVIDER: 'Claude via remote',
  }
  for (const name of [
    'SSH_AUTH_SOCK',
    'SSH_AGENT_PID',
    'SSH_CLIENT',
    'SSH_CONNECTION',
    'SSH_TTY',
  ]) {
    delete env[name]
  }
  return env
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitForSandboxGateway(tunnelName: string): Promise<string> {
  const probeScript =
    "fetch('http://127.0.0.1:8791/health',{signal:AbortSignal.timeout(3000)})" +
    ".then(async r=>{if(!r.ok)process.exit(2);console.log(await r.text())})" +
    '.catch(()=>process.exit(1))'
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = docker(['exec', tunnelName, 'node', '-e', probeScript], {
      capture: true,
      ignoreError: true,
    }).trim()
    if (result) return result
    await wait(250)
  }
  console.error('ai-claude: sandbox SSH 隧道日志：')
  docker(['logs', tunnelName], { ignoreError: true })
  throw new Error('sandbox SSH 隧道未就绪；请检查上面的 SSH 日志')
}

async function runSandbox(argv: string[]): Promise<void> {
  const dockerfile = join(dirname(dirname(fileURLToPath(import.meta.url))), 'deploy', 'ai-claude-sandbox.Dockerfile')
  const sourceRoot = dirname(dirname(fileURLToPath(import.meta.url)))
  const image = process.env.AI_CLAUDE_SANDBOX_IMAGE ?? 'ai-claude-sandbox:local'
  const networkMode = sandboxNetworkMode()
  const dnsServers = networkMode === 'egress' ? sandboxDnsServers() : []
  const dnsArgs = dnsServers.flatMap(server => ['--dns', server])
  const suffix = `${process.pid}-${randomBytes(4).toString('hex')}`
  const networkName = `ai-claude-private-${suffix}`
  const tunnelName = `ai-claude-tunnel-${suffix}`
  const agentName = `ai-claude-agent-${suffix}`
  let child: ChildProcess | undefined

  if (!existsSync(dockerfile)) {
    throw new Error(`找不到 sandbox 镜像定义：${dockerfile}；请先运行 npm run build`)
  }

  ensureDocker()
  console.error(
    `ai-claude: 准备 sandbox 镜像（已有层会复用缓存，网络=${networkMode}）…`,
  )
  docker(['build', '--file', dockerfile, '--tag', image, sourceRoot])
  docker(
    [
      'network',
      'create',
      ...(networkMode === 'isolated' ? ['--internal'] : []),
      networkName,
    ],
    { capture: true },
  )

  try {
    const sshDir = join(homedir(), '.ssh')
    if (!existsSync(sshDir)) throw new Error(`找不到 SSH 配置目录：${sshDir}`)

    const tunnelArgs = [
      'run',
      '--detach',
      '--name',
      tunnelName,
      '--network',
      'bridge',
      '--user',
      '0:0',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges:true',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,size=16m',
      '--mount',
      `type=bind,src=${sshDir},dst=/root/.ssh,readonly`,
    ]
    const authSock = process.env.SSH_AUTH_SOCK
    if (authSock && existsSync(authSock)) {
      tunnelArgs.push(
        '--mount',
        `type=bind,src=${authSock},dst=/run/host-ssh-agent`,
        '--env',
        'SSH_AUTH_SOCK=/run/host-ssh-agent',
      )
    }
    tunnelArgs.push(
      '--entrypoint',
      'ssh',
      image,
      '-o',
      'BatchMode=yes',
      '-o',
      'IgnoreUnknown=UseKeychain',
      '-o',
      'ExitOnForwardFailure=yes',
      '-o',
      'ForwardAgent=no',
      '-o',
      'ServerAliveInterval=30',
      '-N',
      '-L',
      `0.0.0.0:8791:127.0.0.1:${remoteGatewayPort}`,
      sshHost,
    )
    if (authSock && existsSync(authSock)) {
      const imageIndex = tunnelArgs.indexOf(image)
      tunnelArgs.splice(imageIndex + 1, 0, '-o', 'IdentityAgent=/run/host-ssh-agent')
    }
    docker(tunnelArgs, { capture: true })
    docker(['network', 'connect', '--alias', 'claude-gateway', networkName, tunnelName])
    const health = await waitForSandboxGateway(tunnelName)

    if (argv[0] === '--probe') {
      console.log(`gateway_remote=${health}`)
      console.log(`model=${model}`)
      console.log('sandbox=filesystem-and-credential-isolated')
      console.log(`sandbox_network=${networkMode}`)
      console.log(`sandbox_dns=${dnsServers.join(',') || 'docker-default'}`)
      if (networkMode === 'egress') {
        docker([
          'run',
          '--rm',
          '--network',
          networkName,
          ...dnsArgs,
          '--entrypoint',
          '/bin/sh',
          image,
          '-lc',
          [
            'set -eu',
            'command -v curl',
            'command -v python3',
            'command -v jq',
            'command -v rg',
            'getent hosts en.wikipedia.org >/dev/null',
            "curl -4 -L -fsS --max-time 20 -o /dev/null -w 'wikipedia_https=%{http_code}\\n' https://en.wikipedia.org/wiki/Main_Page",
          ].join('; '),
        ])
      } else {
        console.log('internet=disabled')
      }
      return
    }

    const runArgs = [
      'run',
      '--rm',
      '--interactive',
      '--name',
      agentName,
      '--network',
      networkName,
      ...dnsArgs,
      '--workdir',
      '/workspace',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges:true',
      '--pids-limit',
      '256',
      '--tmpfs',
      '/tmp:rw,nosuid,size=256m,uid=10001,gid=10001',
      '--tmpfs',
      '/home/agent:rw,noexec,nosuid,size=64m,uid=10001,gid=10001',
      '--mount',
      `type=bind,src=${resolve(process.cwd())},dst=/workspace`,
    ]
    if (process.stdin.isTTY && process.stdout.isTTY) runArgs.push('--tty')
    for (const [name, value] of Object.entries(sandboxEnv())) {
      runArgs.push('--env', `${name}=${value}`)
    }
    runArgs.push(image, ...argv)

    child = spawn('docker', runArgs, { stdio: 'inherit' })
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
      process.once(signal, () => forwardSignal(child!, signal))
    }
    const exitCode = await new Promise<number>(resolveExit => {
      child!.once('exit', code => resolveExit(code ?? 1))
      child!.once('error', error => {
        console.error(`ai-claude: 无法启动 sandbox Agent：${error.message}`)
        resolveExit(1)
      })
    })
    process.exitCode = exitCode
  } finally {
    if (child && child.exitCode == null && child.signalCode == null) child.kill('SIGTERM')
    docker(['rm', '--force', agentName], { capture: true, ignoreError: true })
    docker(['rm', '--force', tunnelName], { capture: true, ignoreError: true })
    docker(['network', 'rm', networkName], { capture: true, ignoreError: true })
  }
}

async function main(): Promise<void> {
  const rawArgv = process.argv.slice(2)
  const sandbox = rawArgv.includes('--sandbox')
  const argv = rawArgv.filter(arg => arg !== '--sandbox')
  if (argv[0] === '--help' || argv[0] === '-h') {
    printHelp()
    return
  }
  if (sandbox) {
    await runSandbox(argv)
    return
  }

  const tunnel = await openTunnel()
  let child: ChildProcess | undefined
  try {
    const baseURL = `http://127.0.0.1:${tunnel.localPort}/v1`
    if (argv[0] === '--probe') {
      console.log(`gateway_remote=${(await gatewayGet(tunnel.localPort, '/health')).trim()}`)
      console.log(`model=${model}`)
      return
    }

    const cliPath = join(dirname(fileURLToPath(import.meta.url)), 'cli.js')
    child = spawn(process.execPath, [cliPath, ...argv], {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: sanitizedLocalEnv(baseURL),
    })
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
      process.once(signal, () => forwardSignal(child!, signal))
    }
    const exitCode = await new Promise<number>(resolve => {
      child!.once('exit', code => resolve(code ?? 1))
      child!.once('error', error => {
        console.error(`ai-claude: 无法启动本地 Agent：${error.message}`)
        resolve(1)
      })
    })
    process.exitCode = exitCode
  } finally {
    closeTunnel(tunnel)
  }
}

main().catch(error => {
  console.error(`ai-claude: ${error?.message ?? String(error)}`)
  process.exitCode = 1
})
