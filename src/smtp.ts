// 零依赖 SMTP 客户端：用 node:net + node:tls 手写，发一封纯文本邮件。
// 走 AUTH LOGIN 鉴权，支持两种加密：
//   secure=true  → 直连 TLS（隐式加密，Gmail/QQ 邮箱的 465 端口）
//   secure=false → 先明文连，再 STARTTLS 升级（587 端口）
// 依赖：仅 Node 内置模块，无需 npm 安装——与 QQ 渠道「Node 内置」的风格一致。

import { connect as netConnect } from 'node:net'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import type { Socket } from 'node:net'

export type SmtpOptions = {
  host: string
  port: number
  secure: boolean // true=隐式 TLS(465)，false=STARTTLS(587)
  user: string
  pass: string
  from: string // 发件人邮箱（一般等于 user）
}

export type Attachment = {
  filename: string
  content: Buffer
  contentType?: string // 默认 application/octet-stream
}

export type Mail = {
  to: string | string[]
  subject: string
  text: string
  attachments?: Attachment[]
}

// 一问一答地读 SMTP 响应：服务端可能返回多行（"250-xxx" 续行，"250 xxx" 末行）。
// 这里把同一次响应的所有行攒齐，校验状态码首位是否落在期望区间。
class SmtpConn {
  private buf = ''
  private waiters: { resolve: (lines: string[]) => void; reject: (e: Error) => void }[] = []
  private pending: string[] = []

  constructor(private sock: Socket | TLSSocket) {
    sock.setEncoding('utf8')
    sock.on('data', (chunk: string) => this.onData(chunk))
    sock.on('error', e => this.failAll(e instanceof Error ? e : new Error(String(e))))
  }

  private onData(chunk: string) {
    this.buf += chunk
    let idx: number
    while ((idx = this.buf.indexOf('\r\n')) >= 0) {
      const line = this.buf.slice(0, idx)
      this.buf = this.buf.slice(idx + 2)
      this.pending.push(line)
      // 形如 "250 xxx"（第 4 个字符是空格）表示这一次响应结束。
      if (/^\d{3} /.test(line)) {
        const lines = this.pending
        this.pending = []
        this.waiters.shift()?.resolve(lines)
      }
    }
  }

  private failAll(e: Error) {
    while (this.waiters.length) this.waiters.shift()!.reject(e)
  }

  /** 等服务端的一次响应，并断言状态码首字符在 expect 集合内（如 ['2','3']）。 */
  expect(expect: string[]): Promise<string[]> {
    return new Promise((resolve, reject) => {
      this.waiters.push({
        resolve: lines => {
          const code = lines[lines.length - 1]?.slice(0, 3) ?? ''
          if (expect.includes(code[0])) resolve(lines)
          else reject(new Error(`SMTP 期望 ${expect.join('/')}xx，实际收到: ${lines.join(' | ')}`))
        },
        reject,
      })
    })
  }

  send(line: string): void {
    this.sock.write(line + '\r\n')
  }

  /** 发一条命令并等响应。 */
  async cmd(line: string, expect: string[]): Promise<string[]> {
    const p = this.expect(expect)
    this.send(line)
    return p
  }

  raw(): Socket | TLSSocket {
    return this.sock
  }

  end(): void {
    try {
      this.sock.end()
    } catch {
      /* 关闭失败无所谓 */
    }
  }
}

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')

// 非 ASCII 主题按 RFC 2047 编码，否则原样。
function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  return /^[\x00-\x7F]*$/.test(value) ? value : `=?UTF-8?B?${b64(value)}?=`
}

// 正文/附件都用 base64 传输：彻底回避 UTF-8/行首点(.)等转义问题，每 76 字符折行。
const b64Wrap = (buf: Buffer | string) => (Buffer.isBuffer(buf) ? buf.toString('base64') : b64(buf)).replace(/(.{76})/g, '$1\r\n')

function buildMimePart(headers: string[], body: string): string {
  return headers.join('\r\n') + '\r\n\r\n' + body
}

// 无附件：单段 text/plain。有附件：multipart/mixed，正文 + 每个附件各一个子段。
function buildMessage(opt: SmtpOptions, mail: Mail, recipients: string[]): string {
  const date = new Date().toUTCString()
  const baseHeaders = [
    `From: ${opt.from}`,
    `To: ${recipients.join(', ')}`,
    `Subject: ${encodeHeader(mail.subject)}`,
    `Date: ${date}`,
    `MIME-Version: 1.0`,
  ]
  const textBody = b64Wrap(mail.text)

  if (!mail.attachments?.length) {
    const headers = [...baseHeaders, `Content-Type: text/plain; charset=UTF-8`, `Content-Transfer-Encoding: base64`]
    return headers.join('\r\n') + '\r\n\r\n' + textBody + '\r\n'
  }

  const boundary = `----ai-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`
  const textPart = buildMimePart(
    [`Content-Type: text/plain; charset=UTF-8`, `Content-Transfer-Encoding: base64`],
    textBody,
  )
  const attachmentParts = mail.attachments.map(att => {
    const name = encodeHeader(att.filename)
    const type = att.contentType || 'application/octet-stream'
    return buildMimePart(
      [
        `Content-Type: ${type}; name="${name}"`,
        `Content-Transfer-Encoding: base64`,
        `Content-Disposition: attachment; filename="${name}"`,
      ],
      b64Wrap(att.content),
    )
  })
  const parts = [textPart, ...attachmentParts]
  const body = parts.map(p => `--${boundary}\r\n${p}`).join('\r\n') + `\r\n--${boundary}--\r\n`
  const headers = [...baseHeaders, `Content-Type: multipart/mixed; boundary="${boundary}"`]
  return headers.join('\r\n') + '\r\n\r\n' + body
}

// 升级为 TLS（STARTTLS 之后），在已有 socket 上套一层。
function upgradeTls(sock: Socket, host: string): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const tls = tlsConnect({ socket: sock, servername: host }, () => resolve(tls))
    tls.once('error', reject)
  })
}

async function rawConnect(opt: SmtpOptions): Promise<Socket | TLSSocket> {
  return new Promise((resolve, reject) => {
    const sock = opt.secure
      ? tlsConnect({ host: opt.host, port: opt.port, servername: opt.host }, () => resolve(sock))
      : netConnect({ host: opt.host, port: opt.port }, () => resolve(sock))
    sock.once('error', reject)
    sock.setTimeout(30_000, () => {
      sock.destroy(new Error('SMTP 连接超时'))
    })
  })
}

/** 发送一封纯文本邮件。成功返回收件人列表，失败抛错。 */
export async function sendMail(opt: SmtpOptions, mail: Mail): Promise<string[]> {
  const recipients = (Array.isArray(mail.to) ? mail.to : [mail.to])
    .map(s => s.trim())
    .filter(Boolean)
  if (!recipients.length) throw new Error('收件人为空')

  let socket = await rawConnect(opt)
  let conn = new SmtpConn(socket)
  const ehloName = 'localhost'

  await conn.expect(['2']) // 220 greeting
  await conn.cmd(`EHLO ${ehloName}`, ['2'])

  // STARTTLS 路径：升级后必须重连 SmtpConn 并重新 EHLO。
  if (!opt.secure) {
    await conn.cmd('STARTTLS', ['2'])
    socket = await upgradeTls(socket as Socket, opt.host)
    conn = new SmtpConn(socket)
    await conn.cmd(`EHLO ${ehloName}`, ['2'])
  }

  await conn.cmd('AUTH LOGIN', ['3'])
  await conn.cmd(b64(opt.user), ['3'])
  await conn.cmd(b64(opt.pass), ['2']) // 235 鉴权通过

  await conn.cmd(`MAIL FROM:<${opt.from}>`, ['2'])
  for (const rcpt of recipients) await conn.cmd(`RCPT TO:<${rcpt}>`, ['2'])

  await conn.cmd('DATA', ['3']) // 354 开始输入正文
  const message = buildMessage(opt, mail, recipients)
  // 正文是 base64，不会出现以 "." 开头的行，无需额外做点填充(dot-stuffing)。
  conn.send(message + '.')
  await conn.expect(['2']) // 250 已接收

  await conn.cmd('QUIT', ['2']).catch(() => {}) // QUIT 失败不影响已发成功
  conn.end()
  return recipients
}
