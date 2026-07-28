import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, hostname, networkInterfaces, platform, arch, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { get as httpGet } from 'node:http'
import { get as httpsGet } from 'node:https'
import { fileURLToPath } from 'node:url'

type RemoteConfig = {
  deviceId: string
  accessKey: string
  model: string
  hwid: string
  fingerprintVersion?: number
}

type Tunnel = {
  close: () => void
}

const configPath =
  process.env.AI_REMOTE_CONFIG ?? join(homedir(), '.ai-remote', 'config.json')
const directUrl = process.env.AI_REMOTE_URL
const localPort = Number(process.env.AI_REMOTE_LOCAL_PORT ?? 8790)
const remotePort = Number(process.env.AI_REMOTE_PORT ?? 8789)
const remoteHost = process.env.AI_REMOTE_SSH_HOST ?? 'remote'
const baseUrl = (directUrl ?? `http://127.0.0.1:${localPort}`).replace(/\/$/, '')

function machineIdentity(): string {
  const parts = [platform(), arch()]
  let stableMachineId = ''
  try {
    if (platform() === 'darwin') {
      const output = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8' })
      stableMachineId = output.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)?.[1] ?? ''
    } else if (platform() === 'win32') {
      stableMachineId = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_ComputerSystemProduct).UUID'],
        { encoding: 'utf8', windowsHide: true },
      ).trim()
    } else {
      try {
        stableMachineId = readFileSync('/sys/class/dmi/id/product_uuid', 'utf8').trim()
      } catch {
        stableMachineId = readFileSync('/etc/machine-id', 'utf8').trim()
      }
    }
  } catch {
    // Hostname and physical MACs remain as the fallback.
  }
  stableMachineId = stableMachineId.trim().toLowerCase()
  if (
    !stableMachineId ||
    /^0+$/.test(stableMachineId.replace(/-/g, '')) ||
    /^f+$/.test(stableMachineId.replace(/-/g, '')) ||
    /^(unknown|none|not specified|to be filled)/i.test(stableMachineId)
  ) {
    stableMachineId = ''
  }
  if (stableMachineId) {
    parts.push(stableMachineId)
  } else {
    const macs = Object.values(networkInterfaces())
      .flat()
      .filter((item): item is NonNullable<typeof item> => Boolean(item && !item.internal && item.mac !== '00:00:00:00:00:00'))
      .map(item => item.mac)
      .sort()
    parts.push(hostname(), ...macs)
  }
  return createHash('sha256').update(parts.join('\n')).digest('hex')
}

function loadRemoteConfig(): RemoteConfig | undefined {
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8'))
    if (parsed.deviceId && parsed.accessKey && parsed.model && parsed.hwid) return parsed
  } catch {
    // First launch binds below.
  }
  return
}

function saveRemoteConfig(config: RemoteConfig): void {
  mkdirSync(dirname(configPath), { recursive: true })
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  try {
    chmodSync(configPath, 0o600)
  } catch {
    // Some filesystems do not implement POSIX modes.
  }
}

function healthCheck(): Promise<boolean> {
  return new Promise(resolve => {
    const url = new URL(`${baseUrl}/health`)
    const get = url.protocol === 'https:' ? httpsGet : httpGet
    const req = get(url, { agent: false }, res => {
      res.resume()
      resolve(Boolean(res.statusCode && res.statusCode >= 200 && res.statusCode < 300))
    })
    req.setTimeout(500, () => req.destroy(new Error('health check timeout')))
    req.once('error', () => resolve(false))
  })
}

async function openTunnel(): Promise<Tunnel | undefined> {
  if (await healthCheck()) return
  if (directUrl) throw new Error(`无法连接 AI_REMOTE_URL=${directUrl}`)
  const controlDir = mkdtempSync(join(tmpdir(), 'ai-remote-ssh-'))
  const controlPath = join(controlDir, 'control.sock')
  try {
    // -f 只有在认证完成、端口转发成功后才返回；ControlPath 让启动器能可靠关闭后台隧道。
    execFileSync(
      'ssh',
      [
        '-o',
        'BatchMode=yes',
        '-o',
        'ExitOnForwardFailure=yes',
        '-o',
        'ControlMaster=yes',
        '-o',
        `ControlPath=${controlPath}`,
        '-f',
        '-N',
        '-L',
        `${localPort}:127.0.0.1:${remotePort}`,
        remoteHost,
      ],
      { stdio: 'inherit' },
    )
    return {
      close: () => {
        try {
          execFileSync('ssh', ['-S', controlPath, '-O', 'exit', remoteHost], { stdio: 'ignore' })
        } catch {
          // The tunnel may already have ended.
        }
        rmSync(controlDir, { recursive: true, force: true })
      },
    }
  } catch (error) {
    try {
      execFileSync('ssh', ['-S', controlPath, '-O', 'exit', remoteHost], { stdio: 'ignore' })
    } catch {
      // No control socket means SSH failed before reaching background mode.
    }
    rmSync(controlDir, { recursive: true, force: true })
    throw error
  }
}

async function bindOrLoad(): Promise<RemoteConfig> {
  const hwid = machineIdentity()
  const current = loadRemoteConfig()
  if (current) {
    if (current.hwid !== hwid) {
      if (current.fingerprintVersion === 3) {
        throw new Error(`本机设备指纹已变化；请检查 ${configPath}，不要复制其他设备的凭证`)
      }
      // 旧版指纹算法升级时，已有本地凭证可安全原地迁移。
      current.hwid = hwid
      current.fingerprintVersion = 3
      saveRemoteConfig(current)
    } else if (current.fingerprintVersion !== 3) {
      current.fingerprintVersion = 3
      saveRemoteConfig(current)
    }
    return current
  }
  const response = await fetch(`${baseUrl}/v1/devices/bind`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      hwid,
      device_meta: { hostname: hostname(), platform: platform(), arch: arch() },
      ...(process.env.AI_REMOTE_INVITE_CODE
        ? { invite_code: process.env.AI_REMOTE_INVITE_CODE }
        : {}),
    }),
  })
  const body = await response.json() as any
  if (!response.ok) {
    throw new Error(body?.error?.message ?? `设备绑定失败（HTTP ${response.status}）`)
  }
  const config = {
    deviceId: body.device_id,
    accessKey: body.access_key,
    model: body.model,
    hwid,
    fingerprintVersion: 3,
  }
  saveRemoteConfig(config)
  console.error(`✓ 已绑定当前设备，凭证保存到 ${configPath}`)
  return config
}

async function main(): Promise<void> {
  let tunnel: Tunnel | undefined
  let child: ChildProcess | undefined
  const cleanup = () => {
    if (child && child.exitCode == null) child.kill('SIGTERM')
    tunnel?.close()
  }
  try {
    tunnel = await openTunnel()
    const config = await bindOrLoad()
    if (process.argv[2] === 'usage') {
      const response = await fetch(`${baseUrl}/v1/usage/me`, {
        headers: {
          authorization: `Bearer ${config.accessKey}`,
          'x-ai-device-id': config.deviceId,
        },
      })
      const body = await response.json()
      if (!response.ok) throw new Error((body as any)?.error?.message ?? `HTTP ${response.status}`)
      console.log(JSON.stringify(body, null, 2))
      return
    }
    const cliPath = join(dirname(fileURLToPath(import.meta.url)), 'remote-cli.js')
    child = spawn(process.execPath, [cliPath, ...process.argv.slice(2)], {
      stdio: 'inherit',
      env: {
        ...process.env,
        AI_API_KEY: config.accessKey,
        AI_MODEL: config.model,
        AI_BASE_URL: `${baseUrl}/v1`,
        AI_PROVIDER: 'AI Remote',
        AI_REMOTE_DEVICE_ID: config.deviceId,
      },
    })
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => child?.kill(signal))
    }
    const exitCode = await new Promise<number>(resolve => {
      child!.once('exit', code => resolve(code ?? 1))
      child!.once('error', error => {
        console.error(error)
        resolve(1)
      })
    })
    process.exitCode = exitCode
  } finally {
    cleanup()
  }
}

main().catch(error => {
  console.error(`✗ ${error?.message ?? String(error)}`)
  process.exitCode = 1
})
