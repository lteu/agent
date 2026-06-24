// 企业微信 channel：自建应用「接收消息」回调服务 + 主动调 API 回复。
// 与终端/QQ 共用同一个 agent 引擎。
//
// 收消息靠回调（入站），所以本机要起一个 HTTP 服务，再用 cloudflared 隧道把它暴露到公网，
// 把隧道地址填进企业微信后台「接收消息」的 URL。验证与收消息都要做企业微信那套验签+AES解密。
//
// 协议要点（企业微信开发者文档）：
//   验证URL(GET)  query: msg_signature,timestamp,nonce,echostr
//                 sig = sha1(sort(token,timestamp,nonce,echostr)) 比对；解密 echostr 原样返回
//   收消息(POST)  query 同上(用 encrypt 代替 echostr)；body 是含 <Encrypt> 的 XML
//                 验签后解密得到明文 XML（FromUserName/Content/MsgType...）
//   回复          企业微信推荐异步：回调先回空 200，再调 message/send 主动发
//   发消息        gettoken(corpid+secret) → POST /cgi-bin/message/send {touser,msgtype,agentid,text}
//
// 加解密：AESKey=Base64(EncodingAESKey+"=")(32字节)，IV=AESKey前16字节，AES-256-CBC，
//        明文 = 16字节随机 + 4字节大端长度 + msg + receiveid(corpid)。
//
// 依赖：Node 内置 http / crypto / fetch，无额外依赖。

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createHash, createDecipheriv } from 'node:crypto'
import { runAgent } from '../agent/engine.js'
import { isStopCommand } from './stopwords.js'
import { SessionStore, buildSystemPrompt } from '../agent/session.js'
import { logChat, resetTopic, writeLogBanner } from '../agent/chatlog.js'
import { loadConfig, loadWechatConfig } from '../config.js'

// —— 验签：sha1(sort(token,timestamp,nonce,data)) ——
function signature(token: string, timestamp: string, nonce: string, data: string): string {
  const sorted = [token, timestamp, nonce, data].sort().join('')
  return createHash('sha1').update(sorted).digest('hex')
}

// —— 解密企业微信密文，返回明文 msg 与其中携带的 receiveid ——
function decrypt(encrypted: string, encodingAesKey: string): { msg: string; receiveId: string } {
  const aesKey = Buffer.from(encodingAesKey + '=', 'base64') // 32 字节
  const iv = aesKey.subarray(0, 16)
  const decipher = createDecipheriv('aes-256-cbc', aesKey, iv)
  decipher.setAutoPadding(false) // 自己去 PKCS7
  let decoded = Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64')), decipher.final()])
  // 去 PKCS7 填充
  const pad = decoded[decoded.length - 1]
  decoded = decoded.subarray(0, decoded.length - pad)
  // 16 随机 + 4 长度(大端) + msg + receiveid
  const msgLen = decoded.readUInt32BE(16)
  const msg = decoded.subarray(20, 20 + msgLen).toString('utf8')
  const receiveId = decoded.subarray(20 + msgLen).toString('utf8')
  return { msg, receiveId }
}

// 从 XML 取某个标签的文本（兼容 CDATA）。
function xmlField(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`))
  return m ? m[1] : ''
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise(resolve => {
    let data = ''
    req.on('data', c => (data += c))
    req.on('end', () => resolve(data))
  })
}

// access_token 管理（gettoken，缓存到过期前续）。
class TokenManager {
  private token = ''
  private expireAt = 0
  constructor(private corpId: string, private secret: string) {}
  async get(): Promise<string> {
    if (this.token && Date.now() < this.expireAt - 60_000) return this.token
    const res = await fetch(
      `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${this.corpId}&corpsecret=${this.secret}`,
    )
    const j: any = await res.json().catch(() => ({}))
    if (j.errcode !== 0 || !j.access_token) {
      throw new Error(`gettoken 失败: ${JSON.stringify(j).slice(0, 200)}`)
    }
    this.token = j.access_token
    this.expireAt = Date.now() + Number(j.expires_in ?? 7200) * 1000
    return this.token
  }
}

export function startWechat(): void {
  const cfg = loadConfig()
  const wx = loadWechatConfig()

  if (!cfg.apiKey) {
    console.error('缺少 API key。先运行: ai --set-key <KEY>')
    process.exit(1)
  }
  for (const [k, label] of [
    ['corpId', 'CorpID'],
    ['agentId', 'AgentId'],
    ['secret', 'Secret'],
    ['token', 'Token'],
    ['aesKey', 'EncodingAESKey'],
  ] as const) {
    if (!wx[k]) {
      console.error(
        `缺少企业微信 ${label}。先运行:\n  ai --set-wechat <CorpID> <AgentId> <Secret> <Token> <EncodingAESKey>`,
      )
      process.exit(1)
    }
  }

  writeLogBanner('wechat', '企业微信回调服务启动')

  const tokens = new TokenManager(wx.corpId!, wx.secret!)
  const sessions = new SessionStore(buildSystemPrompt(process.cwd(), 'wechat'))
  const busy = new Set<string>()
  const controllers = new Map<string, AbortController>() // 每个在跑会话的中断句柄，供「叫停」用
  const whitelist = new Set((wx.whitelist ?? []).map(String))

  // 主动调 API 给某成员发文本。
  async function sendText(userid: string, content: string) {
    if (!content) return
    const token = await tokens.get()
    const res = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ touser: userid, msgtype: 'text', agentid: Number(wx.agentId), text: { content } }),
    })
    const j: any = await res.json().catch(() => ({}))
    if (j.errcode !== 0) console.error(`发送失败: ${JSON.stringify(j).slice(0, 200)}`)
  }

  async function handleMessage(fromUser: string, text: string) {
    if (whitelist.size && !whitelist.has(fromUser)) {
      await sendText(fromUser, `⛔ 未授权。你的成员标识(userid)：${fromUser}\n授权请运行：ai --wechat-allow ${fromUser}`)
      return
    }
    if (!text) return
    const sessionId = `u:${fromUser}`
    if (text === '/clear') {
      sessions.reset(sessionId)
      resetTopic(sessionId)
      await sendText(fromUser, '🧹 已清空本会话上下文。')
      return
    }
    if (text === '/help') {
      await sendText(fromUser, 'ai · 企业微信\n直接发消息即可让我建文件/读写/跑命令。\n/clear 清空上下文')
      return
    }
    if (busy.has(sessionId)) {
      // 任务进行中又收到消息：若是「等一下/停/暂停/stop」之类，中断当前任务并反馈；否则照旧提示稍等。
      if (isStopCommand(text)) {
        controllers.get(sessionId)?.abort()
        await sendText(fromUser, '🛑 已停止当前任务。')
      } else {
        await sendText(fromUser, '上一条还在处理中，稍等…（发「停」可中断）')
      }
      return
    }
    busy.add(sessionId)
    const controller = new AbortController()
    controllers.set(sessionId, controller)
    const history = sessions.get(sessionId)
    history.push({ role: 'user', content: text })
    try {
      let said = false
      const answers: string[] = []
      for await (const out of runAgent(history, { apiKey: cfg.apiKey!, model: cfg.model, baseURL: cfg.baseURL, provider: cfg.provider, signal: controller.signal })) {
        if (out.type === 'text' && out.content.trim()) {
          await sendText(fromUser, out.content)
          answers.push(out.content)
          said = true
        }
      }
      if (!said) await sendText(fromUser, '(已完成，无文字输出)')
      logChat({ channel: 'wechat', sessionId, question: text, answer: answers.join('\n') })
      sessions.trim(sessionId)
    } catch (err: any) {
      // 用户主动叫停：已在叫停时反馈过「已停止」，这里只记日志，不再回报“出错”。
      if (controller.signal.aborted) {
        logChat({ channel: 'wechat', sessionId, question: text, answer: '[已中断]' })
      } else {
        await sendText(fromUser, '⚠ 出错了: ' + (err?.message ?? String(err)))
        logChat({ channel: 'wechat', sessionId, question: text, answer: `[错误] ${err?.message ?? String(err)}` })
      }
    } finally {
      busy.delete(sessionId)
      controllers.delete(sessionId)
    }
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const msgSig = url.searchParams.get('msg_signature') ?? ''
    const timestamp = url.searchParams.get('timestamp') ?? ''
    const nonce = url.searchParams.get('nonce') ?? ''

    try {
      if (req.method === 'GET') {
        // URL 验证：解密 echostr 原样返回
        const echostr = url.searchParams.get('echostr') ?? ''
        if (signature(wx.token!, timestamp, nonce, echostr) !== msgSig) {
          res.writeHead(401).end('signature mismatch')
          return
        }
        const { msg } = decrypt(echostr, wx.aesKey!)
        res.writeHead(200, { 'Content-Type': 'text/plain' }).end(msg)
        return
      }
      if (req.method === 'POST') {
        const body = await readBody(req)
        const encrypt = xmlField(body, 'Encrypt')
        if (signature(wx.token!, timestamp, nonce, encrypt) !== msgSig) {
          res.writeHead(401).end('signature mismatch')
          return
        }
        // 先立刻回空 200（企业微信要求 5s 内响应），再异步处理+主动回复。
        res.writeHead(200).end('')
        const { msg } = decrypt(encrypt, wx.aesKey!)
        if (xmlField(msg, 'MsgType') === 'text') {
          const fromUser = xmlField(msg, 'FromUserName')
          const content = xmlField(msg, 'Content').trim()
          handleMessage(fromUser, content).catch(e => console.error('处理消息出错:', e))
        }
        return
      }
      res.writeHead(405).end('method not allowed')
    } catch (e: any) {
      console.error('回调处理异常:', e?.message ?? e)
      if (!res.headersSent) res.writeHead(500).end('error')
    }
  })

  server.listen(wx.port, () => {
    console.log(`✦ ai · 企业微信回调服务已启动 http://localhost:${wx.port}`)
    console.log(`  下一步：cloudflared tunnel --url http://localhost:${wx.port}`)
    console.log(`  把得到的公网地址填到企业微信后台「接收消息」的 URL，点保存即可验证通过。`)
    console.log(`  白名单成员: ${whitelist.size ? [...whitelist].join(', ') : '(空——放行本企业所有成员)'}`)
  })
}
