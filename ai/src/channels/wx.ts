// 个人微信 channel：对接微信官方「ilink 机器人」协议（ilinkai.weixin.qq.com）。
// 该域名在 weixin.qq.com 官方域下（由腾讯 DNS 直接解析到 aewebpodproxy.weixin.qq.com），
// 走 Bearer token + 长轮询，是官方渠道，不是模拟个人号协议，不存在被判定异常登录的风险。
// 与终端/QQ/企业微信共用同一个 agent 引擎。
//
// 协议要点（从 https://github.com/Wechat-ggGitHub/wechat-claude-code 源码整理）：
//   绑定    GET  ilink/bot/get_bot_qrcode?bot_type=3 → {ret, qrcode(id), qrcode_img_content}
//           轮询 GET ilink/bot/get_qrcode_status?qrcode=xx，每 3s 一次
//                → status: wait/scaned/confirmed/expired；confirmed 时带
//                  {bot_token, ilink_bot_id, ilink_user_id, baseurl?}
//   鉴权    每个请求头都要带：
//             Authorization: Bearer {bot_token}
//             AuthorizationType: ilink_bot_token
//             X-WECHAT-UIN: {随机 base64，进程内固定即可}
//   收消息  POST ilink/bot/getupdates {get_updates_buf?}（长轮询，服务端超时 35s）
//           → {ret, retmsg, get_updates_buf, msgs:[{from_user_id, message_type(1=用户/2=机器人),
//              item_list:[{type, text_item/voice_item/image_item/file_item}], context_token, message_id}]}
//           游标 get_updates_buf 要存下来，下次请求原样带上（断点续传）
//   发消息  POST ilink/bot/sendmessage {msg:{from_user_id(botId), to_user_id, client_id,
//           message_type:2(BOT), message_state:2(FINISH), context_token, item_list}}
//           文本: item_list=[{type:1, text_item:{text}}]
//   输入中  POST ilink/bot/getconfig {ilink_user_id, context_token} → {typing_ticket}
//           POST ilink/bot/sendtyping {ilink_user_id, typing_ticket, status:1(TYPING)/2(CANCEL)}
//   发图/文件  先 POST ilink/bot/getuploadurl 拿 upload_full_url/upload_param，本地文件用随机
//           16 字节 key 做 AES-128-ECB 加密（无 IV）后 POST 到该地址；响应头 x-encrypted-param
//           即媒体标识，连同 aes_key(hex 转 base64) 一起放进 item_list 的 image_item/file_item.media 发出去。
//
// 依赖：Node 内置 http/crypto/fetch；额外只加了 qrcode-terminal（纯 JS 终端二维码渲染，无原生依赖）。

import { randomBytes, createHash, createCipheriv } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve, basename, extname } from 'node:path'
import { runAgent } from '../agent/engine.js'
import { isStopCommand } from './stopwords.js'
import { SessionStore, buildSystemPrompt } from '../agent/session.js'
import { logChat, resetTopic, writeLogBanner } from '../agent/chatlog.js'
import { loadConfig, loadWxConfig, saveWxConfig } from '../config.js'
import { keepAwake } from '../keepawake.js'

const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'
const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'
const MAX_FILE_SIZE = 25 * 1024 * 1024
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])
const MAX_MSG_LEN = 3500

// —— AES-128-ECB（微信 CDN 媒体加密用，固定无 IV） ——
function encryptAesEcb(key: Buffer, plaintext: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null)
  return Buffer.concat([cipher.update(plaintext), cipher.final()])
}
const aesEcbPaddedSize = (size: number) => Math.ceil(size / 16) * 16

// 长回复分段：按行边界切，避免破坏 markdown。
function splitMessage(text: string): string[] {
  if (text.length <= MAX_MSG_LEN) return [text]
  const chunks: string[] = []
  let rest = text
  while (rest.length > MAX_MSG_LEN) {
    let cut = rest.lastIndexOf('\n', MAX_MSG_LEN)
    if (cut < MAX_MSG_LEN * 0.3) cut = MAX_MSG_LEN
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) chunks.push(rest)
  return chunks
}

// 一条 item 取文本：文字直接取，语音取微信侧已做好的 ASR 转写。
function extractText(item: any): string {
  return item?.text_item?.text || item?.voice_item?.text || ''
}

// ————————————————————————————————————————————————————————————
// ilink 客户端：鉴权头 + 各端点
// ————————————————————————————————————————————————————————————
class IlinkApi {
  private uin = randomBytes(4).toString('base64')
  constructor(private token: string, private baseUrl: string) {}

  private headers() {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.token}`,
      AuthorizationType: 'ilink_bot_token',
      'X-WECHAT-UIN': this.uin,
    }
  }

  private async post<T = any>(path: string, body: unknown, timeoutMs = 15_000): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(`${this.baseUrl}/${path}`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
      return (await res.json()) as T
    } finally {
      clearTimeout(timer)
    }
  }

  getUpdates(buf?: string) {
    return this.post<{ ret?: number; retmsg?: string; get_updates_buf: string; msgs?: any[] }>(
      'ilink/bot/getupdates',
      buf ? { get_updates_buf: buf } : {},
      35_000,
    )
  }
  sendMessage(msg: Record<string, unknown>) {
    return this.post<{ ret?: number; errmsg?: string }>('ilink/bot/sendmessage', { msg })
  }
  getConfig(ilinkUserId: string, contextToken?: string) {
    return this.post<{ ret?: number; typing_ticket?: string }>(
      'ilink/bot/getconfig',
      { ilink_user_id: ilinkUserId, context_token: contextToken },
      10_000,
    )
  }
  sendTyping(ilinkUserId: string, ticket: string, status: 1 | 2) {
    return this.post('ilink/bot/sendtyping', { ilink_user_id: ilinkUserId, typing_ticket: ticket, status }, 10_000)
  }
  getUploadUrl(req: Record<string, unknown>) {
    return this.post<{ ret?: number; upload_param?: string; upload_full_url?: string }>(
      'ilink/bot/getuploadurl',
      req,
    )
  }
}

// ————————————————————————————————————————————————————————————
// 绑定：扫码登录
// ————————————————————————————————————————————————————————————
export async function setupWx(): Promise<void> {
  while (true) {
    console.log('正在获取绑定二维码…')
    const res = await fetch(`${DEFAULT_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`)
    const data: any = await res.json().catch(() => ({}))
    if (data.ret !== 0 || !data.qrcode || !data.qrcode_img_content) {
      console.error(`获取二维码失败: ${JSON.stringify(data).slice(0, 200)}`)
      process.exit(1)
    }
    console.log('请用微信扫描下方二维码完成绑定：\n')
    const qrcodeTerminal = await import('qrcode-terminal')
    qrcodeTerminal.default.generate(data.qrcode_img_content, { small: true })
    console.log('\n等待扫码确认…（二维码有效期较短，过期会自动刷新重来）')

    const qrcodeId = data.qrcode as string
    let status: any = null
    while (true) {
      await new Promise(r => setTimeout(r, 3_000))
      const sres = await fetch(`${DEFAULT_BASE_URL}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcodeId)}`)
      status = await sres.json().catch(() => ({}))
      if (status.status === 'confirmed' || status.status === 'expired') break
      // wait / scaned：继续轮询
    }
    if (status.status === 'expired') {
      console.log('二维码已过期，重新生成…\n')
      continue
    }
    if (!status.bot_token || !status.ilink_bot_id || !status.ilink_user_id) {
      console.error(`绑定返回缺少必要字段: ${JSON.stringify(status).slice(0, 200)}`)
      process.exit(1)
    }
    saveWxConfig({
      botToken: status.bot_token,
      botId: status.ilink_bot_id,
      userId: status.ilink_user_id,
      baseUrl: status.baseurl || DEFAULT_BASE_URL,
      whitelist: [status.ilink_user_id],
      buf: undefined,
    })
    console.log('✅ 绑定成功！已保存凭据。运行 ai wx 启动服务。')
    return
  }
}

// ————————————————————————————————————————————————————————————
// 服务主体
// ————————————————————————————————————————————————————————————
export function startWx(): void {
  const cfg = loadConfig()
  const wx = loadWxConfig()

  if (!cfg.apiKey) {
    console.error('缺少 API key。先运行: ai --set-key <KEY>')
    process.exit(1)
  }
  if (!wx.botToken || !wx.botId || !wx.userId) {
    console.error('尚未绑定个人微信。先运行: ai wx-login 扫码绑定。')
    process.exit(1)
  }

  writeLogBanner('wx', '个人微信（ilink）服务启动')
  keepAwake() // 阻止系统空闲休眠，否则人一离开机器休眠 → 长轮询挂起 → 手机端连不上

  const api = new IlinkApi(wx.botToken, wx.baseUrl || DEFAULT_BASE_URL)
  const whitelist = new Set((wx.whitelist?.length ? wx.whitelist : [wx.userId]).map(String))
  const sessions = new SessionStore(buildSystemPrompt(process.cwd(), 'wx'))
  const busy = new Set<string>()
  const busyNotified = new Set<string>() // 忙碌期间已经提醒过一次「还在处理中」的会话，避免逐条刷屏
  const controllers = new Map<string, AbortController>()
  const nextSendTime = new Map<string, number>() // 每个收件人的下次可发送时刻，避免触发平台限频
  const typingTicket = new Map<string, string>()
  const seenMsgIds = new Set<number>() // 长轮询偶发重投的去重
  const warnedUnauthorized = new Map<string, number>() // 未授权用户上次被提醒的时刻，避免连发多条时刷屏
  // 短时间内连发的多条消息（如粘贴/转发一段聊天记录）先攒在这里，安静下来再合并成一条丢给 agent。
  const batches = new Map<string, { texts: string[]; contextToken: string; timer: ReturnType<typeof setTimeout> }>()
  const BATCH_DEBOUNCE_MS = 1_200
  let clientCounter = 0
  const genClientId = () => `ai-${Date.now()}-${++clientCounter}`

  async function throttle(userId: string) {
    const now = Date.now()
    const prev = nextSendTime.get(userId) ?? 0
    const sendAt = Math.max(now, prev) + 2_500
    nextSendTime.set(userId, sendAt)
    const wait = sendAt - 2_500 - now
    if (wait > 0) await new Promise(r => setTimeout(r, wait))
  }

  async function sendText(toUserId: string, contextToken: string, text: string) {
    if (!text) return
    for (const chunk of splitMessage(text)) {
      await throttle(toUserId)
      const msg = {
        from_user_id: wx.botId,
        to_user_id: toUserId,
        client_id: genClientId(),
        message_type: 2, // BOT
        message_state: 2, // FINISH
        context_token: contextToken,
        item_list: [{ type: 1, text_item: { text: chunk } }],
      }
      let res = await api.sendMessage(msg).catch((e: any) => ({ ret: -1, errmsg: e?.message }))
      if (res.ret === -2) {
        // 限频：等 3s 重试一次
        await new Promise(r => setTimeout(r, 3_000))
        res = await api.sendMessage({ ...msg, client_id: genClientId() }).catch((e: any) => ({ ret: -1, errmsg: e?.message }))
      }
      if (res.ret) console.error(`发送失败: ${JSON.stringify(res).slice(0, 200)}`)
    }
  }

  // 输入中提示：拿一次 typing_ticket，每 5s 续期，任务结束发 CANCEL。拿不到 ticket 就静默跳过。
  function startTyping(userId: string, contextToken: string): () => void {
    let stopped = false
    ;(async () => {
      let ticket = typingTicket.get(userId)
      if (!ticket) {
        const res = await api.getConfig(userId, contextToken).catch(() => ({}) as any)
        if (!res.typing_ticket) return
        ticket = res.typing_ticket
        typingTicket.set(userId, ticket)
      }
      while (!stopped) {
        await api.sendTyping(userId, ticket, 1).catch(() => {})
        await new Promise(r => setTimeout(r, 5_000))
      }
      await api.sendTyping(userId, ticket, 2).catch(() => {})
    })()
    return () => {
      stopped = true
    }
  }

  // 上传本地文件/URL 到微信 CDN（AES-128-ECB 加密），返回可放进 item_list 的 media item。
  async function uploadMedia(
    toUserId: string,
    source: string,
  ): Promise<{ ok: true; item: Record<string, unknown>; fileName: string } | { ok: false; error: string }> {
    try {
      const isUrl = /^https?:\/\//i.test(source)
      let plaintext: Buffer
      let fileName: string
      if (isUrl) {
        const res = await fetch(source)
        if (!res.ok) return { ok: false, error: `下载源文件失败 HTTP ${res.status}` }
        plaintext = Buffer.from(await res.arrayBuffer())
        fileName = decodeURIComponent(source.split('/').pop() || 'file')
      } else {
        const path = resolve(source)
        plaintext = readFileSync(path)
        fileName = basename(path)
      }
      if (plaintext.length > MAX_FILE_SIZE) return { ok: false, error: '文件过大（最大 25MB）' }

      const isImage = IMAGE_EXT.has(extname(fileName).toLowerCase())
      const rawSize = plaintext.length
      const rawFileMd5 = createHash('md5').update(plaintext).digest('hex')
      const fileSize = aesEcbPaddedSize(rawSize)
      const fileKey = randomBytes(16).toString('hex')
      const aesKey = randomBytes(16)

      const up = await api.getUploadUrl({
        filekey: fileKey,
        media_type: isImage ? 1 : 3, // ilink: IMAGE=1, FILE=3
        to_user_id: toUserId,
        rawsize: rawSize,
        rawfilemd5: rawFileMd5,
        filesize: fileSize,
        no_need_thumb: true,
        aeskey: aesKey.toString('hex'),
        base_info: { channel_version: '1.0.0', bot_agent: 'ai-cli' },
      })
      if (!up.upload_full_url && !up.upload_param) {
        return { ok: false, error: `获取上传地址失败: ${JSON.stringify(up).slice(0, 200)}` }
      }

      const encrypted = encryptAesEcb(aesKey, plaintext)
      const uploadUrl =
        up.upload_full_url ||
        `${CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(up.upload_param!)}&filekey=${fileKey}`
      const cdnRes = await fetch(uploadUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(encrypted),
      })
      if (!cdnRes.ok) return { ok: false, error: `CDN 上传失败 HTTP ${cdnRes.status}` }
      const encryptQueryParam = cdnRes.headers.get('x-encrypted-param')
      if (!encryptQueryParam) return { ok: false, error: 'CDN 上传成功但未返回媒体标识' }

      // 与官方参考实现一致：把 hex key 字符串本身当 UTF-8 再 base64（不是把 16 字节直接 base64）。
      const aesKeyBase64 = Buffer.from(aesKey.toString('hex')).toString('base64')
      const media = { encrypt_query_param: encryptQueryParam, aes_key: aesKeyBase64, encrypt_type: 1 }
      const item = isImage
        ? { type: 2, image_item: { media, mid_size: fileSize } }
        : { type: 4, file_item: { media, file_name: fileName, len: String(rawSize) } }
      return { ok: true, item, fileName }
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) }
    }
  }

  async function sendMedia(toUserId: string, contextToken: string, source: string): Promise<string> {
    const result = await uploadMedia(toUserId, source)
    if (!result.ok) return `发送失败: ${result.error}`
    await throttle(toUserId)
    const msg = {
      from_user_id: wx.botId,
      to_user_id: toUserId,
      client_id: genClientId(),
      message_type: 2,
      message_state: 2,
      context_token: contextToken,
      item_list: [result.item],
    }
    const res = await api.sendMessage(msg).catch((e: any) => ({ ret: -1, errmsg: e?.message }))
    if (res.ret) return `发送失败: ${JSON.stringify(res).slice(0, 200)}`
    return `已通过微信发送：${result.fileName}`
  }

  const SEND_IMAGE_SCHEMA = {
    type: 'function',
    function: {
      name: 'send_image',
      description: '通过微信给当前用户发送一张图片（png/jpg 等）。用于用户要求"发图/截图/把某张图发过来"等。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '本地图片文件路径，或以 http(s):// 开头的图片 URL' } },
        required: ['path'],
      },
    },
  } as const

  const SEND_FILE_SCHEMA = {
    type: 'function',
    function: {
      name: 'send_file',
      description: '通过微信给当前用户发送一个文件（如 PDF）。用于用户要求"发送PDF/发文件/把某份文档发过来"等。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '本地文件路径，或以 http(s):// 开头的文件 URL' } },
        required: ['path'],
      },
    },
  } as const

  // 入口：鉴权/指令/忙碌判断都在这一层做，正常消息进「攒批」而不立刻起 agent。
  function queueMessage(fromUserId: string, contextToken: string, text: string) {
    if (!whitelist.has(fromUserId)) {
      // 未授权用户如果连发多条（比如误粘贴一大段），只提醒一次，不逐条刷屏。
      const last = warnedUnauthorized.get(fromUserId) ?? 0
      if (Date.now() - last > 10_000) {
        warnedUnauthorized.set(fromUserId, Date.now())
        sendText(fromUserId, contextToken, `⛔ 未授权。你的标识(ilink_user_id)：\n${fromUserId}\n授权请在机器上运行：\nai --wx-allow ${fromUserId}`).catch(() => {})
      }
      return
    }
    if (!text) return

    const sessionId = `u:${fromUserId}`

    // /clear /help：立即处理，不进攒批；顺带撤掉该会话尚未触发的待合并批次。
    if (text === '/clear' || text === '/help') {
      const pending = batches.get(sessionId)
      if (pending) {
        clearTimeout(pending.timer)
        batches.delete(sessionId)
      }
      if (text === '/clear') {
        sessions.reset(sessionId)
        resetTopic(sessionId)
        sendText(fromUserId, contextToken, '🧹 已清空本会话上下文。').catch(() => {})
      } else {
        sendText(fromUserId, contextToken, 'ai · 微信\n直接发消息即可让我建文件/读写/跑命令。\n/clear 清空上下文').catch(() => {})
      }
      return
    }

    if (busy.has(sessionId)) {
      if (isStopCommand(text)) {
        controllers.get(sessionId)?.abort()
        sendText(fromUserId, contextToken, '🛑 已停止当前任务。').catch(() => {})
      } else if (!busyNotified.has(sessionId)) {
        // 忙碌期间只提醒一次，后续消息静默排除在外，避免「还在处理中」逐条刷屏。
        busyNotified.add(sessionId)
        sendText(fromUserId, contextToken, '上一条还在处理中，稍等…（发「停」可中断）').catch(() => {})
      }
      return
    }

    // 攒批：短时间内连发的多条消息（典型场景：粘贴/转发一段聊天记录会被微信拆成多条）
    // 先合并，等 BATCH_DEBOUNCE_MS 内没有新消息再一起交给 agent，既不刷屏也让 agent 看到完整上下文。
    let batch = batches.get(sessionId)
    if (!batch) {
      batch = { texts: [], contextToken, timer: null as unknown as ReturnType<typeof setTimeout> }
      batches.set(sessionId, batch)
    }
    batch.texts.push(text)
    batch.contextToken = contextToken
    clearTimeout(batch.timer)
    batch.timer = setTimeout(() => {
      batches.delete(sessionId)
      dispatchToAgent(fromUserId, batch!.contextToken, batch!.texts.join('\n')).catch(e =>
        console.error('处理消息出错:', e),
      )
    }, BATCH_DEBOUNCE_MS)
  }

  async function dispatchToAgent(fromUserId: string, contextToken: string, text: string) {
    const sessionId = `u:${fromUserId}`
    busy.add(sessionId)
    const controller = new AbortController()
    controllers.set(sessionId, controller)
    const stopTyping = startTyping(fromUserId, contextToken)
    const history = sessions.get(sessionId)
    history.push({ role: 'user', content: text })
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
          schemas: [SEND_IMAGE_SCHEMA, SEND_FILE_SCHEMA],
          run: (_name, args) => sendMedia(fromUserId, contextToken, String(args.path ?? '')),
        },
      })) {
        if (out.type === 'text' && out.content.trim()) {
          await sendText(fromUserId, contextToken, out.content)
          answers.push(out.content)
          said = true
        } else if (out.type === 'limit') {
          await sendText(fromUserId, contextToken, `⏸ 已连续执行 ${out.steps} 步仍未结束。回复「继续」可接着跑。`)
          said = true
        }
      }
      if (!said) await sendText(fromUserId, contextToken, '(已完成，无文字输出)')
      logChat({ channel: 'wx', sessionId, question: text, answer: answers.join('\n') })
      sessions.trim(sessionId)
    } catch (err: any) {
      if (controller.signal.aborted) {
        logChat({ channel: 'wx', sessionId, question: text, answer: '[已中断]' })
      } else {
        await sendText(fromUserId, contextToken, '⚠ 出错了: ' + (err?.message ?? String(err)))
        logChat({ channel: 'wx', sessionId, question: text, answer: `[错误] ${err?.message ?? String(err)}` })
      }
    } finally {
      busy.delete(sessionId)
      busyNotified.delete(sessionId)
      controllers.delete(sessionId)
      stopTyping()
    }
  }

  // —— 长轮询主循环 ——
  async function poll(): Promise<void> {
    let backoff = 3_000
    while (true) {
      try {
        const resp = await api.getUpdates(wx.buf || undefined)
        if (resp.get_updates_buf) {
          wx.buf = resp.get_updates_buf
          saveWxConfig({ buf: resp.get_updates_buf })
        }
        if (resp.ret === -14) {
          console.error('⚠ 微信会话已过期，请重新运行 ai wx-login 扫码绑定。1 小时后自动重试…')
          await new Promise(r => setTimeout(r, 60 * 60 * 1000))
          continue
        }
        if (resp.ret && resp.ret !== 0) {
          console.error(`getupdates 返回异常: ret=${resp.ret} ${resp.retmsg ?? ''}`)
        }
        for (const msg of resp.msgs ?? []) {
          if (msg.message_type !== 1 /* USER */) continue
          if (!msg.from_user_id || !msg.item_list) continue
          if (msg.message_id) {
            if (seenMsgIds.has(msg.message_id)) continue
            seenMsgIds.add(msg.message_id)
            if (seenMsgIds.size > 1000) seenMsgIds.clear()
          }
          const contextToken = msg.context_token ?? ''
          const text = (msg.item_list as any[]).map(extractText).filter(Boolean).join('\n').trim()
          if (!text) {
            sendText(msg.from_user_id, contextToken, '暂不支持图片/文件类型的输入，发文字或语音就好～').catch(() => {})
            continue
          }
          queueMessage(msg.from_user_id, contextToken, text)
        }
        backoff = 3_000
      } catch (e: any) {
        console.error(`长轮询出错: ${e?.message ?? e}，${backoff / 1000}s 后重试…`)
        await new Promise(r => setTimeout(r, backoff))
        backoff = Math.min(backoff * 2, 30_000)
      }
    }
  }

  console.log('✦ ai · 个人微信（ilink）已启动')
  console.log(`  绑定账号 userId: ${wx.userId}`)
  console.log(`  白名单: ${[...whitelist].join(', ')}`)
  console.log(`  工作目录: ${process.cwd()}`)
  poll()
}
