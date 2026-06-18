// QQ channel：对接「QQ 官方机器人」开放平台（q.qq.com）的 v2 API。
// 官方、合规、不登录个人号、不会封号——通过 AppID/AppSecret 连官方 WebSocket 网关。
//
// 思路（与终端共用同一个 agent 引擎）：
//   群@消息 / 单聊消息 → openid 白名单校验 → 取该会话历史 → 跑 runAgent → 用「被动回复」发回。
//
// 协议要点（来自官方文档 bot.q.qq.com/wiki/develop/api-v2）：
//   鉴权    POST https://bots.qq.com/app/getAppAccessToken {appId, clientSecret} → access_token(7200s)
//           其余请求头一律带 Authorization: QQBot {access_token}
//   网关    GET /v2/gateway → wss 地址；连上收 op:10 Hello，发 op:2 Identify(intents)，定时 op:1 心跳
//   事件    intents=1<<25(群+单聊)：GROUP_AT_MESSAGE_CREATE / C2C_MESSAGE_CREATE
//   发消息  POST /v2/groups/{group_openid}/messages 或 /v2/users/{openid}/messages
//           带 msg_id 即「被动回复」（免费、不占主动消息额度）
//
// 依赖：Node 内置的 fetch 与全局 WebSocket（本项目内置 Node v24，无需额外安装）。

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runAgent } from '../agent/engine.js'
import { SessionStore, buildSystemPrompt } from '../agent/session.js'
import { loadConfig, loadQQConfig } from '../config.js'

type Target = { kind: 'group'; id: string } | { kind: 'c2c'; id: string }

const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'
const GROUP_AND_C2C_INTENT = 1 << 25 // 33554432：群@消息 + 单聊消息

// access_token 管理：带缓存，过期前自动续。
class TokenManager {
  private token = ''
  private expireAt = 0
  constructor(private appId: string, private secret: string) {}

  async get(): Promise<string> {
    // 提前 60s 续期（官方在过期前 60s 内新旧 token 都有效）。
    if (this.token && Date.now() < this.expireAt - 60_000) return this.token
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: this.appId, clientSecret: this.secret }),
    })
    const json: any = await res.json().catch(() => ({}))
    if (!res.ok || !json.access_token) {
      throw new Error(`换取 access_token 失败 (HTTP ${res.status}): ${JSON.stringify(json).slice(0, 200)}`)
    }
    this.token = json.access_token
    this.expireAt = Date.now() + Number(json.expires_in ?? 7200) * 1000
    return this.token
  }
}

/**
 * 主动给白名单里的「单聊用户」发一条消息（不带 msg_id，用 is_wakeup 走「互动召回」）。
 * ⚠️ 官方限制：单聊主动消息每月仅 4 条/人；需用户 30 天内主动与 bot 对话过；
 *    用户若关闭「接收主动消息」则失败。真正的冷启动主动推送已于 2025-04-21 停用。
 */
export async function qqPush(text: string): Promise<void> {
  const qq = loadQQConfig()
  if (!qq.appId || !qq.secret) {
    console.error('缺少 QQ 凭据。先运行: ai --set-qq-app <AppID> <AppSecret>')
    process.exit(1)
  }
  const targets = (qq.whitelist ?? []).map(String)
  if (!targets.length) {
    console.error('白名单为空，没有可推送的 openid。先运行: ai --qq-allow <openid>')
    process.exit(1)
  }
  const apiBase = qq.sandbox ? 'https://sandbox.api.sgroup.qq.com' : 'https://api.sgroup.qq.com'
  const token = await new TokenManager(qq.appId, qq.secret).get()
  const headers = { Authorization: `QQBot ${token}`, 'Content-Type': 'application/json' }
  for (const openid of targets) {
    const res = await fetch(`${apiBase}/v2/users/${openid}/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ content: text, msg_type: 0, is_wakeup: true }),
    })
    const body = await res.text().catch(() => '')
    console.log(`→ ${openid}: HTTP ${res.status} ${res.ok ? '已发送(主动消息)' : body.slice(0, 200)}`)
  }
}

export function startQQ(): void {
  const cfg = loadConfig()
  const qq = loadQQConfig()

  if (!cfg.apiKey) {
    console.error('缺少 DeepSeek API key。先运行: ai --set-key sk-xxxx')
    process.exit(1)
  }
  if (!qq.appId || !qq.secret) {
    console.error(
      [
        '缺少 QQ 官方机器人凭据。先到 https://q.qq.com 创建机器人，拿到 AppID / AppSecret，然后：',
        '  ai --set-qq-app <AppID> <AppSecret>',
        '  ai serve',
        '首次未授权时，给机器人发消息会回显你的 openid，再 ai --qq-allow <openid> 即可。',
      ].join('\n'),
    )
    process.exit(1)
  }

  const apiBase = qq.sandbox ? 'https://sandbox.api.sgroup.qq.com' : 'https://api.sgroup.qq.com'
  const whitelist = new Set((qq.whitelist ?? []).map(String))
  const tokens = new TokenManager(qq.appId, qq.secret)
  const sessions = new SessionStore(buildSystemPrompt(process.cwd(), 'qq'))
  const busy = new Set<string>() // 正在处理的会话，避免并发
  const seqOf = new Map<string, number>() // 每个 msg_id 的回复序号（官方要求 msg_seq 唯一）

  const authHeader = async () => ({ Authorization: `QQBot ${await tokens.get()}`, 'Content-Type': 'application/json' })

  const msgUrl = (t: Target) =>
    t.kind === 'group' ? `${apiBase}/v2/groups/${t.id}/messages` : `${apiBase}/v2/users/${t.id}/messages`
  const filesUrl = (t: Target) =>
    t.kind === 'group' ? `${apiBase}/v2/groups/${t.id}/files` : `${apiBase}/v2/users/${t.id}/files`

  // 被动回复文本：群发到 /v2/groups/{gid}/messages，单聊发到 /v2/users/{uid}/messages。
  async function sendReply(target: Target, msgId: string, content: string) {
    if (!content) return
    const seq = (seqOf.get(msgId) ?? 0) + 1
    seqOf.set(msgId, seq)
    const res = await fetch(msgUrl(target), {
      method: 'POST',
      headers: await authHeader(),
      body: JSON.stringify({ content, msg_type: 0, msg_id: msgId, msg_seq: seq }),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      console.error(`发送失败 (HTTP ${res.status}): ${detail.slice(0, 200)}`)
    }
  }

  // 发图片：先把本地文件(base64)或 URL 上传到富媒体接口拿 file_info，再以 msg_type:7 被动回复。
  async function sendImage(target: Target, msgId: string, source: string): Promise<string> {
    const isUrl = /^https?:\/\//i.test(source)
    const uploadBody: Record<string, any> = { file_type: 1, srv_send_msg: false }
    if (isUrl) {
      uploadBody.url = source
    } else {
      // 本地文件走 base64 的 file_data；注意此时不能再带 url 字段（哪怕空串都会被判“格式不支持”）。
      const path = resolve(source)
      uploadBody.file_data = readFileSync(path).toString('base64')
    }
    const up = await fetch(filesUrl(target), {
      method: 'POST',
      headers: await authHeader(),
      body: JSON.stringify(uploadBody),
    })
    const upJson: any = await up.json().catch(() => ({}))
    if (!up.ok || !upJson.file_info) {
      return `发图失败（上传阶段 HTTP ${up.status}）: ${JSON.stringify(upJson).slice(0, 200)}`
    }
    const seq = (seqOf.get(msgId) ?? 0) + 1
    seqOf.set(msgId, seq)
    const res = await fetch(msgUrl(target), {
      method: 'POST',
      headers: await authHeader(),
      body: JSON.stringify({ msg_type: 7, media: { file_info: upJson.file_info }, msg_id: msgId, msg_seq: seq }),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      return `发图失败（发送阶段 HTTP ${res.status}）: ${detail.slice(0, 200)}`
    }
    return `已通过 QQ 发送图片：${source}`
  }

  const SEND_IMAGE_SCHEMA = {
    type: 'function',
    function: {
      name: 'send_image',
      description: '通过 QQ 给当前用户发送一张图片（png/jpg）。用于用户要求“发图/截图/把某张图发过来”等。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '本地图片文件路径，或以 http(s):// 开头的图片 URL' },
        },
        required: ['path'],
      },
    },
  } as const

  // 处理一条进来的消息（群@ 或 单聊）。
  async function handleMessage(target: Target, senderOpenid: string, msgId: string, rawContent: string) {
    const text = (rawContent ?? '').trim()

    // 未授权：回显 openid 引导加白名单，绝不执行任何 agent 动作。
    if (!whitelist.has(senderOpenid)) {
      await sendReply(target, msgId, `⛔ 未授权。你的标识(openid)：\n${senderOpenid}\n授权请在机器上运行：\nai --qq-allow ${senderOpenid}`)
      return
    }
    if (!text) return

    // 会话隔离：单聊按用户 openid，群聊按群 openid（同群共享上下文）。
    const sessionId = target.kind === 'group' ? `g:${target.id}` : `c:${target.id}`

    if (text === '/clear') {
      sessions.reset(sessionId)
      await sendReply(target, msgId, '🧹 已清空本会话上下文。')
      return
    }
    if (text === '/help') {
      await sendReply(target, msgId, 'ai · QQ\n直接发消息即可让我建文件/读写/跑命令。\n/clear 清空上下文')
      return
    }

    if (busy.has(sessionId)) {
      await sendReply(target, msgId, '上一条还在处理中，稍等…')
      return
    }
    busy.add(sessionId)

    const history = sessions.get(sessionId)
    history.push({ role: 'user', content: text })
    try {
      let said = false
      for await (const out of runAgent(history, {
        apiKey: cfg.apiKey!,
        model: cfg.model,
        baseURL: cfg.baseURL,
        extraTools: {
          schemas: [SEND_IMAGE_SCHEMA],
          run: (_name, args) => sendImage(target, msgId, String(args.path ?? '')),
        },
      })) {
        // 官方被动回复对单条 msg_id 的回复条数有限制，所以只回「文字结果」，跳过工具进度噪音。
        if (out.type === 'text' && out.content.trim()) {
          await sendReply(target, msgId, out.content)
          said = true
        }
      }
      if (!said) await sendReply(target, msgId, '(已完成，无文字输出)')
      sessions.trim(sessionId)
    } catch (err: any) {
      await sendReply(target, msgId, '⚠ 出错了: ' + (err?.message ?? String(err)))
    } finally {
      busy.delete(sessionId)
    }
  }

  // —— WebSocket 网关：连接 + 心跳 + 重连 ——
  let backoff = 1000
  const connect = async () => {
    let gatewayUrl: string
    try {
      // 注意：网关接口是 /gateway（不带 /v2），而发消息接口才是 /v2/...
      const res = await fetch(`${apiBase}/gateway`, { headers: await authHeader() })
      const json: any = await res.json()
      gatewayUrl = json.url
      if (!gatewayUrl) throw new Error('网关返回为空: ' + JSON.stringify(json).slice(0, 200))
    } catch (e: any) {
      console.error('获取网关失败，5s 后重试：', e?.message ?? e)
      setTimeout(connect, 5000)
      return
    }

    const ws = new WebSocket(gatewayUrl)
    let heartbeat: ReturnType<typeof setInterval> | null = null
    let lastSeq: number | null = null

    const stop = () => {
      if (heartbeat) clearInterval(heartbeat)
      heartbeat = null
    }

    ws.addEventListener('open', () => {
      backoff = 1000
    })

    ws.addEventListener('message', async (e: MessageEvent) => {
      let pkt: any
      try {
        pkt = JSON.parse(typeof e.data === 'string' ? e.data : String(e.data))
      } catch {
        return
      }
      if (typeof pkt.s === 'number') lastSeq = pkt.s

      // op:10 Hello → 发 Identify 并开始心跳
      if (pkt.op === 10) {
        const token = await tokens.get()
        ws.send(
          JSON.stringify({
            op: 2,
            d: { token: `QQBot ${token}`, intents: GROUP_AND_C2C_INTENT, shard: [0, 1] },
          }),
        )
        const interval = pkt.d?.heartbeat_interval ?? 30000
        heartbeat = setInterval(() => {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ op: 1, d: lastSeq }))
        }, interval)
        return
      }

      // op:0 Dispatch → 业务事件
      if (pkt.op === 0) {
        const t: string = pkt.t
        const d: any = pkt.d ?? {}
        if (t === 'READY') {
          const name = d?.user?.username ?? '(机器人)'
          console.log(`✦ ai · QQ 官方机器人已上线：${name}`)
          console.log(`  白名单 openid: ${whitelist.size ? [...whitelist].join(', ') : '(空——首条消息会回显 openid)'}`)
          console.log(`  环境: ${qq.sandbox ? '沙箱' : '正式'}  工作目录: ${process.cwd()}`)
          return
        }
        if (t === 'GROUP_AT_MESSAGE_CREATE') {
          await handleMessage(
            { kind: 'group', id: d.group_openid },
            d.author?.member_openid ?? '',
            d.id,
            d.content,
          )
        } else if (t === 'C2C_MESSAGE_CREATE') {
          await handleMessage(
            { kind: 'c2c', id: d.author?.user_openid ?? '' },
            d.author?.user_openid ?? '',
            d.id,
            d.content,
          )
        }
      }
    })

    ws.addEventListener('close', () => {
      stop()
      console.error(`QQ 网关断开，${backoff / 1000}s 后重连…`)
      setTimeout(connect, backoff)
      backoff = Math.min(backoff * 2, 30000)
    })
    ws.addEventListener('error', () => {
      try {
        ws.close()
      } catch {
        /* 触发 close 重连 */
      }
    })
  }

  connect()
}
