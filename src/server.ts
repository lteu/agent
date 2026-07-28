import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

type ServerOptions = {
  host?: string
  port?: number
  databasePath?: string
  upstreamApiKey?: string
  upstreamBaseUrl?: string
  upstreamModel?: string
  initialQuota?: number
  noticeThreshold?: number
  noticeMessage?: string
  inviteCode?: string
}

type Usage = {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

type Device = {
  device_id: string
  hwid_hash: string
  status: string
  plan: string
  quota_tokens: number
  used_tokens: number
}

const jsonHeaders = { 'content-type': 'application/json; charset=utf-8' }

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, jsonHeaders)
  res.end(JSON.stringify(body))
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = Buffer.from(chunk)
    size += buf.length
    if (size > 10 * 1024 * 1024) throw new Error('request body too large')
    chunks.push(buf)
  }
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function normalizeUsage(raw: any, fallbackPromptChars = 0, fallbackCompletionChars = 0): Usage {
  const prompt = Number(raw?.prompt_tokens)
  const completion = Number(raw?.completion_tokens)
  const total = Number(raw?.total_tokens)
  const estimatedPrompt = Math.max(1, Math.ceil(fallbackPromptChars / 4))
  const estimatedCompletion = Math.max(1, Math.ceil(fallbackCompletionChars / 4))
  return {
    prompt_tokens: Number.isFinite(prompt) ? prompt : estimatedPrompt,
    completion_tokens: Number.isFinite(completion) ? completion : estimatedCompletion,
    total_tokens: Number.isFinite(total)
      ? total
      : (Number.isFinite(prompt) ? prompt : estimatedPrompt) +
        (Number.isFinite(completion) ? completion : estimatedCompletion),
  }
}

function initDatabase(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL UNIQUE,
      hwid_hash TEXT NOT NULL UNIQUE,
      access_key_hash TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'active',
      plan TEXT NOT NULL DEFAULT 'free',
      quota_tokens INTEGER NOT NULL,
      used_tokens INTEGER NOT NULL DEFAULT 0,
      last_notice_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS usage_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL REFERENCES devices(device_id),
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      request_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_usage_logs_device_time
      ON usage_logs(device_id, created_at);
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL REFERENCES devices(device_id),
      type TEXT NOT NULL,
      channel TEXT NOT NULL,
      payload TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `)
  return db
}

export function createRemoteServer(options: ServerOptions = {}): {
  server: Server
  db: DatabaseSync
  listen: () => Promise<{ host: string; port: number }>
  close: () => Promise<void>
} {
  const host = options.host ?? process.env.AI_REMOTE_HOST ?? '127.0.0.1'
  const port = options.port ?? Number(process.env.AI_REMOTE_PORT ?? 8789)
  const databasePath =
    options.databasePath ?? process.env.AI_REMOTE_DB ?? '/var/lib/ai-remote/ai-remote.sqlite'
  const upstreamApiKey = options.upstreamApiKey ?? process.env.AI_REMOTE_UPSTREAM_API_KEY
  const upstreamBaseUrl = (
    options.upstreamBaseUrl ??
    process.env.AI_REMOTE_UPSTREAM_BASE_URL ??
    'https://api.deepseek.com'
  ).replace(/\/$/, '')
  const upstreamModel =
    options.upstreamModel ?? process.env.AI_REMOTE_UPSTREAM_MODEL ?? 'deepseek-chat'
  const initialQuota =
    options.initialQuota ?? Number(process.env.AI_REMOTE_INITIAL_QUOTA ?? 1000)
  const noticeThreshold =
    options.noticeThreshold ?? Number(process.env.AI_REMOTE_NOTICE_THRESHOLD ?? initialQuota)
  const noticeMessage =
    options.noticeMessage ??
    process.env.AI_REMOTE_NOTICE_MESSAGE ??
    `您的免费额度已用完 ${noticeThreshold} tokens，请充值后继续使用。`
  const inviteCode = options.inviteCode ?? process.env.AI_REMOTE_INVITE_CODE
  const db = initDatabase(databasePath)
  const rate = new Map<string, { minute: number; count: number }>()

  function lookupDevice(accessKey: string): Device | undefined {
    return db
      .prepare(
        `SELECT device_id, hwid_hash, status, plan, quota_tokens, used_tokens
         FROM devices WHERE access_key_hash = ?`,
      )
      .get(sha256(accessKey)) as Device | undefined
  }

  function authenticate(req: IncomingMessage, res: ServerResponse): Device | undefined {
    const auth = req.headers.authorization ?? ''
    const accessKey = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
    const device = accessKey ? lookupDevice(accessKey) : undefined
    if (!device) {
      sendJson(res, 401, { error: { message: '无效的设备访问凭证', type: 'authentication_error' } })
      return
    }
    if (req.headers['x-ai-device-id'] !== device.device_id) {
      sendJson(res, 403, { error: { message: '访问凭证与当前设备不匹配', type: 'device_mismatch' } })
      return
    }
    if (device.status !== 'active') {
      sendJson(res, 403, { error: { message: `设备状态为 ${device.status}`, type: 'device_inactive' } })
      return
    }
    const minute = Math.floor(Date.now() / 60_000)
    const item = rate.get(device.device_id)
    const current = item?.minute === minute ? item : { minute, count: 0 }
    current.count += 1
    rate.set(device.device_id, current)
    if (current.count > 60) {
      sendJson(res, 429, { error: { message: '请求过于频繁，请稍后再试', type: 'rate_limit' } })
      return
    }
    return device
  }

  function meter(device: Device, usage: Usage, requestId: string): string | undefined {
    const oldUsed = device.used_tokens
    const nextUsed = oldUsed + usage.total_tokens
    const nextQuota = Math.max(0, device.quota_tokens - usage.total_tokens)
    const crossed = oldUsed < noticeThreshold && nextUsed >= noticeThreshold
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare(
        `INSERT INTO usage_logs(
          device_id, provider, model, prompt_tokens, completion_tokens, total_tokens, request_id
        ) VALUES (?, 'deepseek', ?, ?, ?, ?, ?)`,
      ).run(
        device.device_id,
        upstreamModel,
        usage.prompt_tokens,
        usage.completion_tokens,
        usage.total_tokens,
        requestId,
      )
      db.prepare(
        `UPDATE devices SET quota_tokens = ?, used_tokens = ?,
          last_notice_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE last_notice_at END,
          updated_at = CURRENT_TIMESTAMP
         WHERE device_id = ?`,
      ).run(nextQuota, nextUsed, crossed ? 1 : 0, device.device_id)
      if (crossed) {
        db.prepare(
          `INSERT INTO notifications(device_id, type, channel, payload)
           VALUES (?, 'threshold_reached', 'inline', ?)`,
        ).run(device.device_id, JSON.stringify({ message: noticeMessage }))
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    return crossed || nextQuota === 0 ? noticeMessage : undefined
  }

  async function bind(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req)
    if (inviteCode && body.invite_code !== inviteCode) {
      sendJson(res, 403, { error: { message: '邀请码无效', type: 'invalid_invite' } })
      return
    }
    if (!/^[a-f0-9]{64}$/i.test(body.hwid ?? '')) {
      sendJson(res, 400, { error: { message: 'hwid 必须是 SHA-256 十六进制值', type: 'invalid_hwid' } })
      return
    }
    const existing = db
      .prepare('SELECT device_id, plan, quota_tokens, used_tokens FROM devices WHERE hwid_hash = ?')
      .get(body.hwid) as any
    const accessKey = `sk-svr-${randomBytes(32).toString('base64url')}`
    if (existing) {
      // 同一硬件重新安装：保留设备、用量和额度，只轮换访问凭证。
      db.prepare(
        `UPDATE devices
         SET access_key_hash = ?, status = 'active', updated_at = CURRENT_TIMESTAMP
         WHERE device_id = ?`,
      ).run(sha256(accessKey), existing.device_id)
      sendJson(res, 200, {
        device_id: existing.device_id,
        access_key: accessKey,
        plan: existing.plan,
        quota_tokens: existing.quota_tokens,
        used_tokens: existing.used_tokens,
        model: upstreamModel,
        rebound: true,
      })
      return
    }
    const deviceId = randomUUID()
    db.prepare(
      `INSERT INTO devices(device_id, hwid_hash, access_key_hash, quota_tokens)
       VALUES (?, ?, ?, ?)`,
    ).run(deviceId, body.hwid, sha256(accessKey), initialQuota)
    sendJson(res, 201, {
      device_id: deviceId,
      access_key: accessKey,
      plan: 'free',
      quota_tokens: initialQuota,
      model: upstreamModel,
    })
  }

  async function proxyChat(req: IncomingMessage, res: ServerResponse, device: Device): Promise<void> {
    if (!upstreamApiKey) {
      sendJson(res, 503, { error: { message: '服务端尚未配置模型密钥', type: 'server_not_configured' } })
      return
    }
    if (device.quota_tokens <= 0) {
      sendJson(res, 402, {
        error: { message: noticeMessage, type: 'quota_exhausted' },
        usage: { used_tokens: device.used_tokens, quota_tokens: 0 },
      })
      return
    }
    const body = await readJson(req)
    body.model = upstreamModel
    if (body.stream) body.stream_options = { ...(body.stream_options ?? {}), include_usage: true }
    const promptChars = JSON.stringify(body.messages ?? []).length
    const requestId = randomUUID()
    const upstream = await fetch(`${upstreamBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${upstreamApiKey}`,
      },
      body: JSON.stringify(body),
    })
    if (!upstream.ok || !upstream.body) {
      const detail = await upstream.text().catch(() => '')
      sendJson(res, upstream.status, {
        error: { message: `上游模型请求失败: ${detail.slice(0, 500)}`, type: 'upstream_error' },
      })
      return
    }

    if (!body.stream) {
      const json = await upstream.json() as any
      const usage = normalizeUsage(json.usage, promptChars, JSON.stringify(json.choices ?? []).length)
      const notice = meter(device, usage, requestId)
      json.ai_remote = {
        usage,
        quota_tokens: Math.max(0, device.quota_tokens - usage.total_tokens),
        ...(notice ? { notice: { type: 'threshold_reached', message: notice } } : {}),
      }
      sendJson(res, 200, json)
      return
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const reader = upstream.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let rawUsage: any
    let completionChars = 0
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let end: number
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).trim()
        buffer = buffer.slice(end + 1)
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        try {
          const event = JSON.parse(payload)
          if (event.usage) rawUsage = event.usage
          const delta = event?.choices?.[0]?.delta?.content
          if (typeof delta === 'string') completionChars += delta.length
        } catch {
          // Keep forwarding a provider event even if it contains an extension we do not parse.
        }
        res.write(`data: ${payload}\n\n`)
      }
    }
    const usage = normalizeUsage(rawUsage, promptChars, completionChars)
    const notice = meter(device, usage, requestId)
    if (notice) {
      res.write(
        `data: ${JSON.stringify({
          id: `notice-${requestId}`,
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { content: `\n\n⚠ ${notice}` }, finish_reason: null }],
        })}\n\n`,
      )
    }
    res.end('data: [DONE]\n\n')
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (req.method === 'GET' && url.pathname === '/health') {
        sendJson(res, 200, { status: 'ok', model: upstreamModel })
        return
      }
      if (req.method === 'POST' && url.pathname === '/v1/devices/bind') {
        await bind(req, res)
        return
      }
      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
        const device = authenticate(req, res)
        if (device) await proxyChat(req, res, device)
        return
      }
      if (req.method === 'GET' && url.pathname === '/v1/usage/me') {
        const device = authenticate(req, res)
        if (device) {
          sendJson(res, 200, {
            device_id: device.device_id,
            plan: device.plan,
            used_tokens: device.used_tokens,
            quota_tokens: device.quota_tokens,
          })
        }
        return
      }
      sendJson(res, 404, { error: { message: '接口不存在', type: 'not_found' } })
    } catch (error: any) {
      if (!res.headersSent) {
        sendJson(res, 500, { error: { message: error?.message ?? String(error), type: 'server_error' } })
      } else {
        res.end()
      }
    }
  })

  return {
    server,
    db,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => {
          const address = server.address()
          resolve({ host, port: typeof address === 'object' && address ? address.port : port })
        })
      }),
    close: () =>
      new Promise((resolve, reject) => {
        server.close(error => {
          db.close()
          if (error) reject(error)
          else resolve()
        })
      }),
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const app = createRemoteServer()
  app.listen()
    .then(({ host, port }) => console.log(`ai-remote server listening on http://${host}:${port}`))
    .catch(error => {
      console.error(error)
      process.exit(1)
    })
}
