import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { containerWorkspacePath, hostStatePath } from './ai-cc-workspace.js'

type ExtraMount = { source: string; target: string; readOnly: boolean }

const sourceRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const dockerfile = join(sourceRoot, 'deploy', 'ai-cc.Dockerfile')
const imageBuildInputs = [
  dockerfile,
  join(sourceRoot, 'deploy', 'ai-cc-apt-packages.txt'),
  join(sourceRoot, 'deploy', 'ai-cc-python-packages.txt'),
  join(sourceRoot, 'deploy', 'ai-cc-proxy.sh'),
  join(sourceRoot, 'deploy', 'ai-cc-privoxy.conf'),
]
const image = process.env.AI_CC_IMAGE ?? 'ai-cc:local'
const stateDir = hostStatePath(homedir(), process.env.AI_CC_HOME_DIR)
const sshHost = process.env.AI_CC_SSH_HOST ?? 'remote'
const defaultHostMountNames = ['Desktop', 'Downloads', 'Documents', 'Sites'] as const
const managedLabel = 'ai-cc.managed=true'
const buildFingerprintLabel = 'ai-cc.build-fingerprint'

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

function help(): void {
  console.log(`ai-cc — 在 Docker 中运行官方 Claude Code，全部网络经 SSH remote 出口

用法:
  ai-cc                              在当前目录启动 Claude Code
  ai-cc --probe                      验证直连阻断、代理出口和浏览器渲染
  ai-cc --mount <路径>               额外挂载可写文件/目录（可重复）
  ai-cc --mount-ro <路径>            额外挂载只读文件/目录（可重复）
  ai-cc -- <Claude Code 参数...>     参数原样传给 Claude Code

首次启动按 Claude Code 提示登录。登录凭据、配置和会话保存在宿主目录：${stateDir}
当前目录按 HOME 相对路径映射到 /workspace 下；Desktop、Downloads、Documents 和 Sites
默认分别挂载到 /mnt 下并可读写。
额外挂载映射为 /mnt/1-name、/mnt/2-name 等。

环境变量:
  AI_CC_SSH_HOST       SSH 主机或别名（默认 remote）
  AI_CC_IMAGE          Docker 镜像名（默认 ai-cc:local）
  AI_CC_HOME_DIR       持久化 HOME 的宿主目录（默认 ~/.ai-cc）
  AI_CC_REBUILD=1      强制重建镜像`)
}

function ensureStateDir(): void {
  if (existsSync(stateDir)) {
    if (!statSync(stateDir).isDirectory()) throw new Error(`HOME 路径不是目录：${stateDir}`)
    return
  }
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
}

function parseArgs(raw: string[]): { claudeArgs: string[]; mounts: ExtraMount[]; probe: boolean } {
  const claudeArgs: string[] = []
  const mounts: ExtraMount[] = []
  let probe = false
  for (let index = 0; index < raw.length; index += 1) {
    const arg = raw[index]
    if (arg === '--') {
      claudeArgs.push(...raw.slice(index + 1))
      break
    }
    if (arg === '--probe') {
      probe = true
      continue
    }
    if (arg !== '--mount' && arg !== '--mount-ro') {
      claudeArgs.push(arg)
      continue
    }
    const value = raw[index + 1]
    if (!value) throw new Error(`${arg} 后必须提供文件或目录路径`)
    index += 1
    const source = resolve(value)
    if (!existsSync(source)) throw new Error(`挂载路径不存在：${source}`)
    const label = basename(source).replace(/[^a-zA-Z0-9._-]+/g, '-') || 'data'
    mounts.push({ source, target: `/mnt/${mounts.length + 1}-${label}`, readOnly: arg === '--mount-ro' })
  }
  return { claudeArgs, mounts, probe }
}

function ensureImage(): void {
  docker(['version'], { capture: true })
  const fingerprint = createHash('sha256')
  for (const path of imageBuildInputs) {
    if (!existsSync(path)) throw new Error(`找不到镜像构建文件：${path}`)
    fingerprint.update(path.slice(sourceRoot.length)).update('\0').update(readFileSync(path)).update('\0')
  }
  const expectedFingerprint = fingerprint.digest('hex')
  const exists = docker(['image', 'inspect', image], { capture: true, ignoreError: true }).trim()
  const currentFingerprint = exists
    ? docker([
      'image', 'inspect', '--format', `{{ index .Config.Labels "${buildFingerprintLabel}" }}`, image,
    ], { capture: true, ignoreError: true }).trim()
    : ''
  const forced = process.env.AI_CC_REBUILD === '1'
  if (exists && currentFingerprint === expectedFingerprint && !forced) return
  if (exists && !forced) console.error('ai-cc: 镜像构建文件已更新，自动重建…')
  else console.error('ai-cc: 构建 Claude Code 镜像…')
  docker([
    'build', '--file', dockerfile,
    '--label', `${buildFingerprintLabel}=${expectedFingerprint}`,
    '--tag', image, sourceRoot,
  ])
}

function wait(ms: number): Promise<void> {
  return new Promise(resolveWait => setTimeout(resolveWait, ms))
}

function terminalEnvArgs(): string[] {
  const args = ['--env', `TERM=${process.env.TERM ?? 'xterm-256color'}`]
  for (const name of ['COLORTERM', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'COLORFGBG']) {
    const value = process.env[name]
    if (value) args.push('--env', `${name}=${value}`)
  }
  return args
}

async function waitForProxy(proxyName: string): Promise<string> {
  const check = 'curl -4fsS --max-time 8 --proxy http://127.0.0.1:8118 https://api.ipify.org'
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const ip = docker(['exec', proxyName, '/bin/sh', '-lc', check], {
      capture: true,
      ignoreError: true,
    }).trim()
    if (ip) return ip
    await wait(300)
  }
  docker(['logs', proxyName], { ignoreError: true })
  throw new Error('remote 出口代理未就绪；请检查 SSH 配置、密钥和 remote 网络')
}

function proxyContainerArgs(proxyName: string): string[] {
  const sshDir = join(homedir(), '.ssh')
  if (!existsSync(sshDir)) throw new Error(`找不到 SSH 配置目录：${sshDir}`)
  const args = [
    'run', '--detach', '--name', proxyName, '--network', 'bridge',
    '--hostname', 'egress-proxy', '--user', '0:0', '--read-only',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m',
    '--mount', `type=bind,src=${sshDir},dst=/root/.ssh,readonly`,
  ]
  const authSock = process.env.SSH_AUTH_SOCK
  if (authSock && existsSync(authSock)) {
    args.push(
      '--mount', `type=bind,src=${authSock},dst=/run/host-ssh-agent`,
      '--env', 'SSH_AUTH_SOCK=/run/host-ssh-agent',
    )
  }
  args.push('--entrypoint', '/usr/local/bin/ai-cc-proxy', image)
  if (authSock && existsSync(authSock)) args.push('-o', 'IdentityAgent=/run/host-ssh-agent')
  args.push(sshHost)
  return args
}

async function main(): Promise<void> {
  const raw = process.argv.slice(2)
  if (raw[0] === '--help' || raw[0] === '-h') {
    help()
    return
  }
  const { claudeArgs, mounts, probe } = parseArgs(raw)
  ensureImage()
  ensureStateDir()

  const hostWorkspace = resolve(process.cwd())
  const workspaceDir = containerWorkspacePath(hostWorkspace, homedir())

  const suffix = `${process.pid}-${randomBytes(4).toString('hex')}`
  const networkName = `ai-cc-private-${suffix}`
  const proxyName = `ai-cc-proxy-${suffix}`
  const claudeName = `ai-cc-${suffix}`
  let child: ChildProcess | undefined
  let cleaned = false

  const cleanup = (): void => {
    if (cleaned) return
    cleaned = true
    docker(['rm', '--force', claudeName], { capture: true, ignoreError: true })
    docker(['rm', '--force', proxyName], { capture: true, ignoreError: true })
    docker(['network', 'rm', networkName], { capture: true, ignoreError: true })
  }

  // `finally` covers normal exits; this synchronously handles terminal-close
  // exits that reach Node before its asynchronous cleanup has completed.
  process.once('exit', cleanup)

  docker(['network', 'create', '--label', managedLabel, '--internal', networkName], { capture: true })
  try {
    const proxyArgs = proxyContainerArgs(proxyName)
    proxyArgs.splice(1, 0, '--label', managedLabel)
    docker(proxyArgs, { capture: true })
    docker(['network', 'connect', '--alias', 'egress-proxy', networkName, proxyName])
    const exitIp = await waitForProxy(proxyName)
    console.error(`ai-cc: remote 出口已就绪 (${exitIp})`)

    const common = [
      '--network', networkName,
      '--hostname', 'claude-workspace',
      '--read-only', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges:true', '--pids-limit', '512',
      '--tmpfs', '/tmp:rw,nosuid,size=512m,uid=10001,gid=10001',
      '--tmpfs', '/dev/shm:rw,nosuid,nodev,size=512m,uid=10001,gid=10001',
      '--mount', `type=bind,src=${stateDir},dst=/home/agent`,
      '--mount', `type=bind,src=${hostWorkspace},dst=${workspaceDir}`,
      '--workdir', workspaceDir, '--user', '10001:10001',
      '--env', 'HOME=/home/agent', '--env', 'USER=agent', '--env', 'LOGNAME=agent',
      '--env', 'TZ=Etc/UTC', '--env', 'LANG=C.UTF-8', '--env', 'LC_ALL=C.UTF-8',
      ...terminalEnvArgs(),
      '--env', 'HTTP_PROXY=http://egress-proxy:8118',
      '--env', 'HTTPS_PROXY=http://egress-proxy:8118',
      '--env', 'http_proxy=http://egress-proxy:8118',
      '--env', 'https_proxy=http://egress-proxy:8118',
      '--env', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1',
      '--env', 'CLAUDE_CODE_MAX_RETRIES=3',
      '--env', 'CLAUDE_ENABLE_STREAM_WATCHDOG=1',
      '--env', 'DISABLE_TELEMETRY=1', '--env', 'DISABLE_ERROR_REPORTING=1',
      '--env', 'DISABLE_BUG_COMMAND=1', '--env', 'DISABLE_AUTOUPDATER=1',
    ]
    console.error(`ai-cc: ${workspaceDir} <= ${hostWorkspace} (可写工作区)`)
    for (const name of defaultHostMountNames) {
      const source = join(homedir(), name)
      const target = `/mnt/${name}`
      if (existsSync(source)) {
        common.push('--mount', `type=bind,src=${source},dst=${target}`)
        console.error(`ai-cc: ${target} <= ${source} (可写，默认)`)
      } else {
        console.error(`ai-cc: 未找到 ${name}，跳过默认挂载：${source}`)
      }
    }
    for (const mount of mounts) {
      common.push('--mount', `type=bind,src=${mount.source},dst=${mount.target}${mount.readOnly ? ',readonly' : ''}`)
      console.error(`ai-cc: ${mount.target} <= ${mount.source} (${mount.readOnly ? '只读' : '可写'})`)
    }

    if (probe) {
      const directCheck = docker([
        'run', '--rm', ...common, '--entrypoint', '/bin/sh', image, '-lc',
        "if curl -4fsS --noproxy '*' --max-time 4 https://api.ipify.org; then exit 9; else echo direct_egress=blocked; fi",
      ], { capture: true }).trim()
      const proxiedIp = docker([
        'run', '--rm', ...common, '--entrypoint', 'curl', image,
        '-4fsS', '--max-time', '10', 'https://api.ipify.org',
      ], { capture: true }).trim()
      const browserCheck = docker([
        'run', '--rm', ...common, '--entrypoint', 'python3', image, '-c', [
          'from playwright.sync_api import sync_playwright',
          'with sync_playwright() as playwright:',
          '    browser = playwright.chromium.launch(headless=True)',
          '    page = browser.new_page(viewport={"width": 640, "height": 480})',
          '    page.set_content("<main>ai-cc 浏览器探针</main>")',
          '    assert page.locator("main").inner_text() == "ai-cc 浏览器探针"',
          '    page.screenshot(path="/tmp/ai-cc-browser-probe.png")',
          '    browser.close()',
          'print("browser_render=ok")',
        ].join('\n'),
      ], { capture: true }).trim()
      console.log(directCheck)
      console.log(`proxy_egress_ip=${proxiedIp}`)
      console.log(browserCheck)
      console.log('timezone=Etc/UTC')
      console.log(`home_dir=${stateDir}`)
      return
    }

    const runArgs = ['run', '--rm', '--interactive', '--label', managedLabel, '--name', claudeName, ...common]
    if (process.stdin.isTTY && process.stdout.isTTY) runArgs.push('--tty')
    runArgs.push(image, ...claudeArgs)
    child = spawn('docker', runArgs, { stdio: 'inherit' })
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
      process.once(signal, () => child?.kill(signal))
    }
    process.exitCode = await new Promise<number>(resolveExit => {
      child!.once('exit', code => resolveExit(code ?? 1))
      child!.once('error', () => resolveExit(1))
    })
  } finally {
    if (child && child.exitCode == null && child.signalCode == null) child.kill('SIGTERM')
    cleanup()
  }
}

main().catch(error => {
  console.error(`ai-cc: ${error?.message ?? String(error)}`)
  process.exitCode = 1
})
