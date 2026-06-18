// 配置：API key 与模型的读取/保存。
// 优先级：环境变量 > ~/.ai/config.json

import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'

export type QQConfig = {
  /** QQ 开放平台（q.qq.com）应用的 AppID */
  appId?: string
  /** 应用的 AppSecret（clientSecret），用于换 access_token */
  secret?: string
  /** 白名单 openid：只有这些标识能操控 agent。注意 openid 同一人在单聊/各群里不同。 */
  whitelist?: string[]
  /** 是否用沙箱环境（默认 false，走正式环境 api.sgroup.qq.com） */
  sandbox?: boolean
}

export type WechatConfig = {
  /** 企业 ID（CorpID，「我的企业」页底部） */
  corpId?: string
  /** 自建应用的 AgentId */
  agentId?: string
  /** 自建应用的 Secret，用于换 access_token */
  secret?: string
  /** 接收消息配置里你设的 Token，用于回调验签 */
  token?: string
  /** 接收消息配置里的 EncodingAESKey（43 位），用于回调解密 */
  aesKey?: string
  /** 白名单成员 userid：留空则放行本企业所有成员 */
  whitelist?: string[]
  /** 本地回调服务监听端口，默认 8788 */
  port?: number
}

export type SmtpConfig = {
  /** SMTP 服务器，默认 smtp.gmail.com */
  host?: string
  /** 端口，默认 465 */
  port?: number
  /** 是否隐式 TLS（465 用 true；587 用 false 走 STARTTLS），默认 true */
  secure?: boolean
  /** 登录用户名，一般是完整邮箱地址 */
  user?: string
  /** 登录密码：Gmail/QQ 邮箱要用「应用专用密码 / 授权码」，不是账号登录密码 */
  pass?: string
  /** 发件人地址，留空则用 user */
  from?: string
}

export type Config = {
  apiKey?: string
  model?: string
  baseURL?: string
  qq?: QQConfig
  wechat?: WechatConfig
  smtp?: SmtpConfig
}

const CONFIG_DIR = join(homedir(), '.ai')
export const CONFIG_PATH = join(CONFIG_DIR, 'config.json')

export const DEFAULT_MODEL = 'deepseek-chat'

function readFile(): Config {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as Config
  } catch {
    return {}
  }
}

export function loadConfig(): Required<Pick<Config, 'model' | 'baseURL'>> & {
  apiKey?: string
} {
  const file = readFile()
  return {
    apiKey: process.env.DEEPSEEK_API_KEY || file.apiKey,
    model: process.env.AI_MODEL || file.model || DEFAULT_MODEL,
    baseURL: process.env.DEEPSEEK_BASE_URL || file.baseURL || 'https://api.deepseek.com',
  }
}

function writeConfig(next: Config): void {
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2))
  try {
    chmodSync(CONFIG_PATH, 0o600) // 含 key / token，只对自己可读
  } catch {
    /* 平台不支持时忽略 */
  }
}

export function saveApiKey(apiKey: string): void {
  writeConfig({ ...readFile(), apiKey })
}

/** 读取 QQ 配置：环境变量优先，其次 config.json。 */
export function loadQQConfig(): QQConfig {
  const file = readFile().qq ?? {}
  const envWhitelist = process.env.AI_QQ_WHITELIST
    ? process.env.AI_QQ_WHITELIST.split(',').map(s => s.trim()).filter(Boolean)
    : undefined
  return {
    appId: process.env.AI_QQ_APPID || file.appId,
    secret: process.env.AI_QQ_SECRET || file.secret,
    whitelist: envWhitelist ?? file.whitelist ?? [],
    sandbox: process.env.AI_QQ_SANDBOX === '1' || file.sandbox || false,
  }
}

/** 合并并保存 QQ 配置（传入字段覆盖，其余保留原值）。 */
export function saveQQConfig(patch: Partial<QQConfig>): void {
  const current = readFile()
  writeConfig({ ...current, qq: { ...current.qq, ...patch } })
}

/** 往白名单追加一个 openid（去重），返回更新后的白名单。 */
export function addQQAllow(openid: string): string[] {
  const current = readFile()
  const list = (current.qq?.whitelist ?? []).map(String)
  if (!list.includes(openid)) list.push(openid)
  writeConfig({ ...current, qq: { ...current.qq, whitelist: list } })
  return list
}

/** 读取企业微信配置：环境变量优先，其次 config.json。 */
export function loadWechatConfig(): WechatConfig {
  const file = readFile().wechat ?? {}
  const envWhitelist = process.env.AI_WECHAT_WHITELIST
    ? process.env.AI_WECHAT_WHITELIST.split(',').map(s => s.trim()).filter(Boolean)
    : undefined
  return {
    corpId: process.env.AI_WECHAT_CORPID || file.corpId,
    agentId: process.env.AI_WECHAT_AGENTID || file.agentId,
    secret: process.env.AI_WECHAT_SECRET || file.secret,
    token: process.env.AI_WECHAT_TOKEN || file.token,
    aesKey: process.env.AI_WECHAT_AESKEY || file.aesKey,
    whitelist: envWhitelist ?? file.whitelist ?? [],
    port: Number(process.env.AI_WECHAT_PORT) || file.port || 8788,
  }
}

/** 合并并保存企业微信配置（传入字段覆盖，其余保留原值）。 */
export function saveWechatConfig(patch: Partial<WechatConfig>): void {
  const current = readFile()
  writeConfig({ ...current, wechat: { ...current.wechat, ...patch } })
}

/** 读取 SMTP 配置：环境变量优先，其次 config.json，再套用 Gmail 默认值。 */
export function loadSmtpConfig(): Required<Pick<SmtpConfig, 'host' | 'port' | 'secure'>> &
  SmtpConfig {
  const file = readFile().smtp ?? {}
  const user = process.env.AI_SMTP_USER || file.user
  const port = Number(process.env.AI_SMTP_PORT) || file.port || 465
  // secure 默认随端口推断：465→隐式 TLS，其余→STARTTLS。
  const secureEnv = process.env.AI_SMTP_SECURE
  const secure = secureEnv ? secureEnv === '1' : file.secure ?? port === 465
  return {
    host: process.env.AI_SMTP_HOST || file.host || 'smtp.gmail.com',
    port,
    secure,
    user,
    pass: process.env.AI_SMTP_PASS || file.pass,
    from: process.env.AI_SMTP_FROM || file.from || user,
  }
}

/** 合并并保存 SMTP 配置（传入字段覆盖，其余保留原值）。 */
export function saveSmtpConfig(patch: Partial<SmtpConfig>): void {
  const current = readFile()
  writeConfig({ ...current, smtp: { ...current.smtp, ...patch } })
}
