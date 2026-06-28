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
import { isStopCommand } from './stopwords.js'
import { SessionStore, buildSystemPrompt } from '../agent/session.js'
import { logChat, resetTopic, writeLogBanner } from '../agent/chatlog.js'
import { loadConfig, loadQQConfig } from '../config.js'
import { synthesizeWav } from '../tts.js'

type Target = { kind: 'group'; id: string } | { kind: 'c2c'; id: string }

const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'
const GROUP_AND_C2C_INTENT = 1 << 25 // 33554432：群@消息 + 单聊消息

// QQ 富媒体语音附件：QQ 侧已做好 ASR(asr_refer_text)，并给出 wav 链接(voice_wav_url)。
type Attachment = { content_type?: string; asr_refer_text?: string; voice_wav_url?: string; url?: string }
const isVoiceAtt = (x: Attachment): boolean =>
  x.asr_refer_text != null || x.voice_wav_url != null || /voice|audio|silk|amr/i.test(x.content_type ?? '')
const pickVoice = (attachments?: Attachment[]): Attachment | undefined => attachments?.find(isVoiceAtt)

// 用户「明确要求用语音回复」的触发词：命中才合成语音回，否则一律文字回。
const VOICE_REPLY_RE =
  /语音(回复|回答|播报|说|讲)|用(语音|声音)(回|说|讲|答|播)|读给我听|念给我听|说给我听|voice\s*reply/i
const wantsVoiceReply = (text: string): boolean => VOICE_REPLY_RE.test(text)

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
    console.error('缺少 API key。先运行: ai --set-key <KEY>')
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

  writeLogBanner('qq', 'QQ 机器人启动')

  const apiBase = qq.sandbox ? 'https://sandbox.api.sgroup.qq.com' : 'https://api.sgroup.qq.com'
  const whitelist = new Set((qq.whitelist ?? []).map(String))
  const tokens = new TokenManager(qq.appId, qq.secret)
  const sessions = new SessionStore(buildSystemPrompt(process.cwd(), 'qq'))
  const busy = new Set<string>() // 正在处理的会话，避免并发
  const controllers = new Map<string, AbortController>() // 每个在跑会话的中断句柄，供「叫停」用
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
      // 本地文件走 base64 的 file_data；注意此时不能再带 url 字段（哪怕空串都会被判"格式不支持"）。
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

  // 发语音：把 WAV 字节以 base64 上传富媒体(file_type:3)拿 file_info，再以 msg_type:3 被动回复。
  // 与 sendImage 同一套「先传后发」流程，区别只在 file_type 和 msg_type。
  async function sendVoice(target: Target, msgId: string, wav: Buffer): Promise<boolean> {
    const up = await fetch(filesUrl(target), {
      method: 'POST',
      headers: await authHeader(),
      body: JSON.stringify({ file_type: 3, file_data: wav.toString('base64'), srv_send_msg: false }),
    })
    const upJson: any = await up.json().catch(() => ({}))
    if (!up.ok || !upJson.file_info) {
      console.error(`发语音失败(上传阶段 HTTP ${up.status}): ${JSON.stringify(upJson).slice(0, 200)}`)
      return false
    }
    const seq = (seqOf.get(msgId) ?? 0) + 1
    seqOf.set(msgId, seq)
    // 富媒体消息 msg_type 一律为 7（图片/语音/视频通用），用上传时的 file_type 区分类型。
    const res = await fetch(msgUrl(target), {
      method: 'POST',
      headers: await authHeader(),
      body: JSON.stringify({ msg_type: 7, media: { file_info: upJson.file_info }, msg_id: msgId, msg_seq: seq }),
    })
    const body = await res.text().catch(() => '')
    if (!res.ok) {
      console.error(`发语音失败(发送阶段 HTTP ${res.status}): ${body.slice(0, 200)}`)
      return false
    }
    console.log(`🔊 已发送语音(${wav.length}B)`)
    return true
  }

  const SEND_IMAGE_SCHEMA = {
    type: 'function',
    function: {
      name: 'send_image',
      description: '通过 QQ 给当前用户发送一张图片（png/jpg）。用于用户要求"发图/截图/把某张图发过来"等。',
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
  async function handleMessage(
    target: Target,
    senderOpenid: string,
    msgId: string,
    rawContent: string,
    attachments?: Attachment[],
  ) {
    // 语音消息：QQ 已把转写放在 asr_refer_text，文本为空时用它作为输入。
    const voiceAtt = pickVoice(attachments)
    const asr = voiceAtt?.asr_refer_text?.trim()
    let text = (rawContent ?? '').trim()
    if (!text && asr) text = asr

    // 未授权：回显 openid 引导加白名单，绝不执行任何 agent 动作。
    if (!whitelist.has(senderOpenid)) {
      await sendReply(target, msgId, `⛔ 未授权。你的标识(openid)：\n${senderOpenid}\n授权请在机器上运行：\nai --qq-allow ${senderOpenid}`)
      return
    }
    if (!text) {
      // 收到语音但 QQ 没给出转写：提示重试，避免静默吞掉。
      if (voiceAtt) await sendReply(target, msgId, '🎤 没太听清这条语音，能再说一遍或直接打字吗？')
      return
    }

    // 会话隔离：单聊按用户 openid，群聊按群 openid（同群共享上下文）。
    const sessionId = target.kind === 'group' ? `g:${target.id}` : `c:${target.id}`

    if (text === '/clear') {
      sessions.reset(sessionId)
      resetTopic(sessionId)
      await sendReply(target, msgId, '🧹 已清空本会话上下文。')
      return
    }
    if (text === '/help') {
      await sendReply(target, msgId, 'ai · QQ\n直接发消息即可让我建文件/读写/跑命令。\n/clear 清空上下文')
      return
    }

    if (busy.has(sessionId)) {
      // 任务进行中又收到消息：若是「等一下/停/暂停/stop」之类，中断当前任务并反馈；否则照旧提示稍等。
      if (isStopCommand(text)) {
        controllers.get(sessionId)?.abort()
        await sendReply(target, msgId, '🛑 已停止当前任务。')
      } else {
        await sendReply(target, msgId, '上一条还在处理中，稍等…（发「停」可中断）')
      }
      return
    }
    busy.add(sessionId)
    const controller = new AbortController()
    controllers.set(sessionId, controller)

    // 仅当用户在(语音/文字)消息里明确要求「用语音回复」时，才合成语音回；否则照常文字回。
    const voiceReply = wantsVoiceReply(text)
    console.log(`← [${target.kind}] ${voiceAtt ? '🎤语音' : '文字'} | 语音回复=${voiceReply} | "${text.slice(0, 40)}"`)

    const history = sessions.get(sessionId)
    // 语音回复模式：模型本是纯文本助手，被要求「语音回复」会老实答「我不能语音」，
    // 这句话再被合成成语音发出去就很荒诞。给它一句提示：文字会被自动转语音，
    // 它具备语音能力，直接回答问题本身即可，别声称不能语音。
    const agentInput = voiceReply
      ? `${text}\n\n[系统提示：请直接、简洁地回答上面的问题本身。你的文字回答会被系统自动合成为语音发送给用户，因此你具备语音回复能力，切勿回复“没有语音能力/不能语音”之类的话。]`
      : text
    history.push({ role: 'user', content: agentInput })
    try {
      let said = false
      const answers: string[] = []
      for await (const out of runAgent(history, {
        apiKey: cfg.apiKey!,
        model: cfg.model,
        baseURL: cfg.baseURL,
        provider: cfg.provider,
        signal: controller.signal,
        extraTools: {
          schemas: [SEND_IMAGE_SCHEMA],
          run: (_name, args) => sendImage(target, msgId, String(args.path ?? '')),
        },
      })) {
        // 官方被动回复对单条 msg_id 的回复条数有限制，所以只回「文字结果」，跳过工具进度噪音。
        if (out.type === 'text' && out.content.trim()) {
          // 语音模式：先攒着，循环结束再合成整段语音发一次（逐段合成会发出一串碎语音）。
          if (!voiceReply) await sendReply(target, msgId, out.content)
          answers.push(out.content)
          said = true
        } else if (out.type === 'limit') {
          await sendReply(target, msgId, `⏸ 已连续执行 ${out.steps} 步仍未结束。回复「继续」可接着跑。`)
          said = true
        }
      }
      // 语音回复：把整段答案合成语音发出；TTS/发送失败或被截断时回退/补发文字，保证用户拿得到内容。
      if (voiceReply && answers.length) {
        const full = answers.join('\n')
        try {
          const { wav, truncated } = await synthesizeWav(full, qq.voice)
          const ok = await sendVoice(target, msgId, wav)
          if (!ok || truncated) await sendReply(target, msgId, full)
        } catch (e: any) {
          console.error('TTS 合成失败，回退文字:', e?.message ?? e)
          await sendReply(target, msgId, full)
        }
      }
      if (!said) await sendReply(target, msgId, '(已完成，无文字输出)')
      logChat({ channel: 'qq', sessionId, question: text, answer: answers.join('\n') })
      sessions.trim(sessionId)
    } catch (err: any) {
      // 用户主动叫停：已在叫停时反馈过「已停止」，这里只记日志，不再回报“出错”。
      if (controller.signal.aborted) {
        logChat({ channel: 'qq', sessionId, question: text, answer: '[已中断]' })
      } else {
        await sendReply(target, msgId, '⚠ 出错了: ' + (err?.message ?? String(err)))
        logChat({ channel: 'qq', sessionId, question: text, answer: `[错误] ${err?.message ?? String(err)}` })
      }
    } finally {
      busy.delete(sessionId)
      controllers.delete(sessionId)
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
    let awaitingAck = false // 已发心跳但还没等到 op:11 ACK
    let lastInbound = Date.now() // 最后一次收到任何网关报文的时刻
    let hbInterval = 30000
    let reconnected = false // 防止 watchdog 与 close 事件重复重连

    const stop = () => {
      if (heartbeat) clearInterval(heartbeat)
      heartbeat = null
    }

    // 统一的「判定连接已死 → 重连」入口，幂等。close 事件与 watchdog 都走这里。
    const reconnect = (why: string) => {
      if (reconnected) return
      reconnected = true
      stop()
      console.error(`QQ 网关${why}，${backoff / 1000}s 后重连…`)
      setTimeout(connect, backoff)
      backoff = Math.min(backoff * 2, 30000)
      try {
        ws.close()
      } catch {
        /* 已经断了就忽略 */
      }
    }

    ws.addEventListener('open', () => {
      backoff = 1000
    })

    ws.addEventListener('message', async (e: MessageEvent) => {
      lastInbound = Date.now()
      let pkt: any
      try {
        pkt = JSON.parse(typeof e.data === 'string' ? e.data : String(e.data))
      } catch {
        return
      }
      if (typeof pkt.s === 'number') lastSeq = pkt.s

      // op:11 心跳 ACK：收到才算这一拍连接是活的。
      if (pkt.op === 11) {
        awaitingAck = false
        return
      }
      // op:7 服务端要求重连 / op:9 会话失效：都直接重连。
      if (pkt.op === 7 || pkt.op === 9) {
        reconnect(pkt.op === 7 ? '收到 op:7 要求重连' : '收到 op:9 会话失效')
        return
      }

      // op:10 Hello → 发 Identify 并开始心跳 + 看门狗
      if (pkt.op === 10) {
        const token = await tokens.get()
        ws.send(
          JSON.stringify({
            op: 2,
            d: { token: `QQBot ${token}`, intents: GROUP_AND_C2C_INTENT, shard: [0, 1] },
          }),
        )
        hbInterval = pkt.d?.heartbeat_interval ?? 30000
        awaitingAck = false
        heartbeat = setInterval(() => {
          // 上一拍心跳没等到 ACK，或长时间没收到任何报文（PC 休眠/网络半开导致的「僵尸连接」，
          // close 事件不会触发）→ 主动判死并重连，否则手机端会一直连不上。
          if (awaitingAck || Date.now() - lastInbound > hbInterval * 2) {
            reconnect('心跳无响应(疑似僵尸连接)')
            return
          }
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ op: 1, d: lastSeq }))
            awaitingAck = true
          }
        }, hbInterval)
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
            d.attachments,
          )
        } else if (t === 'C2C_MESSAGE_CREATE') {
          await handleMessage(
            { kind: 'c2c', id: d.author?.user_openid ?? '' },
            d.author?.user_openid ?? '',
            d.id,
            d.content,
            d.attachments,
          )
        }
      }
    })

    ws.addEventListener('close', () => {
      reconnect('断开')
    })
    ws.addEventListener('error', () => {
      reconnect('出错')
    })
  }

  connect()
}
