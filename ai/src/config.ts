// 配置：API key / model / baseURL 的读取与保存。
// 优先级（从上到下覆盖）：环境变量 > ~/.ai/config.json > 代码默认值

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
  /** 语音回复用的本机 macOS `say` 音色名（如 Meijia / Flo / Tingting）。留空用系统默认。 */
  voice?: string
}

export type DoubaoTtsConfig = {
  /** 火山引擎「语音技术」应用的 appid */
  appId?: string
  /** 该应用的 access token（控制台「服务接口认证信息」里获取），对应请求头 X-Api-Access-Key */
  token?: string
  /** 默认音色(speaker/voice_type)，如 zh_female_linjianvhai_moon_bigtts；未按语种细分时用这个兜底 */
  voiceType?: string
  /** 文本含中文字符时用的音色 */
  voiceTypeZh?: string
  /** 文本基本是纯 ASCII(英文)时用的音色 */
  voiceTypeEn?: string
  /** 其他语种(非中文、非纯 ASCII)时用的音色 */
  voiceTypeOther?: string
  /** 请求头 X-Api-Resource-Id，一般按 voiceType 后缀自动推断，填了则覆盖自动推断结果 */
  resourceId?: string
  /** 控制台给的 secret key；当前版本 API 未用到（认证只需 appid+token），先存着以防以后要签名 */
  secretKey?: string
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

export type WxConfig = {
  /** ilink 机器人 token（扫码绑定后获得），用于 Authorization: Bearer */
  botToken?: string
  /** 绑定的机器人账号 id（ilink_bot_id），发消息时作为 from_user_id */
  botId?: string
  /** 绑定的本人微信在 ilink 里的 user id（ilink_user_id），也是默认白名单 */
  userId?: string
  /** ilink 服务 baseURL，一般不用改，默认 https://ilinkai.weixin.qq.com */
  baseUrl?: string
  /** 白名单 ilink 用户 id：留空则只放行绑定账号本人（userId） */
  whitelist?: string[]
  /** 长轮询游标（get_updates_buf），程序自动维护，无需手填 */
  buf?: string
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

/** 一条美股监控规则：满足任一设定条件即触发告警。 */
export type StockRule = {
  /** 股票代码，如 AAPL */
  symbol: string
  /** 价格涨到 >= above 时告警 */
  above?: number
  /** 价格跌到 <= below 时告警 */
  below?: number
  /** 当日涨跌幅绝对值 >= chgPct(%) 时告警 */
  chgPct?: number
  /** 该规则的邮件收件人（逗号分隔），不设则用全局 emailTo */
  emailTo?: string
}

export type StocksConfig = {
  /** 自选监控规则 */
  watch?: StockRule[]
  /** 轮询间隔（秒），默认 60 */
  pollSeconds?: number
  /** 告警渠道，默认 ['email','terminal'] */
  notify?: ('email' | 'terminal')[]
  /** 邮件告警收件人，留空则用 SMTP 的发件邮箱（发给自己） */
  emailTo?: string
}

export type Config = {
  apiKey?: string
  model?: string
  baseURL?: string
  /** 服务商显示名，仅用于界面/报错（如 "OpenAI"、"通义千问"）。不影响连接。 */
  provider?: string
  qq?: QQConfig
  wechat?: WechatConfig
  wx?: WxConfig
  smtp?: SmtpConfig
  stocks?: StocksConfig
  doubaoTts?: DoubaoTtsConfig
}

const CONFIG_DIR = join(homedir(), '.ai')
export const CONFIG_PATH = join(CONFIG_DIR, 'config.json')

export const DEFAULT_MODEL = 'deepseek-chat'
export const DEFAULT_BASE_URL = 'https://api.deepseek.com'

// ———————————————————————————————————————————————
// 底层读写
// ———————————————————————————————————————————————

function readFile(): Config {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as Config
  } catch {
    return {}
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

// ———————————————————————————————————————————————
// 公共读取方法
// ———————————————————————————————————————————————

/** 返回文件中的原始配置（不含环境变量覆盖）。 */
export function loadRawConfig(): Config {
  return readFile()
}

/**
 * 返回最终生效的模型调用参数（与服务商无关）：
 *   环境变量 > 配置文件 > 代码默认值
 *
 * 环境变量：AI_API_KEY / AI_MODEL / AI_BASE_URL / AI_PROVIDER。
 * 为兼容旧配置，仍接受 DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL 作为后备。
 */
export function loadConfig(): Required<Pick<Config, 'model' | 'baseURL'>> & {
  apiKey?: string
  provider?: string
} {
  const file = readFile()
  return {
    apiKey: process.env.AI_API_KEY || process.env.DEEPSEEK_API_KEY || file.apiKey,
    model: process.env.AI_MODEL || file.model || DEFAULT_MODEL,
    baseURL:
      process.env.AI_BASE_URL ||
      process.env.DEEPSEEK_BASE_URL ||
      file.baseURL ||
      DEFAULT_BASE_URL,
    provider: process.env.AI_PROVIDER || file.provider,
  }
}

// ———————————————————————————————————————————————
// 保存方法（写入 config.json）
// ———————————————————————————————————————————————

export function saveApiKey(apiKey: string): void {
  writeConfig({ ...readFile(), apiKey })
}

export function saveModel(model: string): void {
  writeConfig({ ...readFile(), model })
}

export function saveBaseURL(baseURL: string): void {
  writeConfig({ ...readFile(), baseURL })
}

export function saveProvider(provider: string): void {
  writeConfig({ ...readFile(), provider })
}

// ———————————————————————————————————————————————
// 子模块配置读取 / 保存
// ———————————————————————————————————————————————

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
    voice: process.env.AI_QQ_VOICE || file.voice,
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

/** 读取个人微信（ilink）配置：环境变量优先，其次 config.json。 */
export function loadWxConfig(): WxConfig {
  const file = readFile().wx ?? {}
  const envWhitelist = process.env.AI_WX_WHITELIST
    ? process.env.AI_WX_WHITELIST.split(',').map(s => s.trim()).filter(Boolean)
    : undefined
  return {
    botToken: process.env.AI_WX_TOKEN || file.botToken,
    botId: process.env.AI_WX_BOTID || file.botId,
    userId: process.env.AI_WX_USERID || file.userId,
    baseUrl: process.env.AI_WX_BASEURL || file.baseUrl || 'https://ilinkai.weixin.qq.com',
    whitelist: envWhitelist ?? file.whitelist ?? [],
    buf: file.buf,
  }
}

/** 合并并保存个人微信配置（传入字段覆盖，其余保留原值）。 */
export function saveWxConfig(patch: Partial<WxConfig>): void {
  const current = readFile()
  writeConfig({ ...current, wx: { ...current.wx, ...patch } })
}

/** 往个人微信白名单追加一个 ilink 用户 id（去重），返回更新后的白名单。 */
export function addWxAllow(userId: string): string[] {
  const current = readFile()
  const list = (current.wx?.whitelist ?? []).map(String)
  if (!list.includes(userId)) list.push(userId)
  writeConfig({ ...current, wx: { ...current.wx, whitelist: list } })
  return list
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

/** 读取豆包(火山引擎)语音合成配置：环境变量优先，其次 config.json，再套用默认集群名。 */
export function loadDoubaoTtsConfig(): DoubaoTtsConfig {
  const file = readFile().doubaoTts ?? {}
  return {
    appId: process.env.AI_DOUBAO_TTS_APPID || file.appId,
    token: process.env.AI_DOUBAO_TTS_TOKEN || file.token,
    voiceType: process.env.AI_DOUBAO_TTS_VOICE || file.voiceType,
    voiceTypeZh: process.env.AI_DOUBAO_TTS_VOICE_ZH || file.voiceTypeZh,
    voiceTypeEn: process.env.AI_DOUBAO_TTS_VOICE_EN || file.voiceTypeEn,
    voiceTypeOther: process.env.AI_DOUBAO_TTS_VOICE_OTHER || file.voiceTypeOther,
    resourceId: process.env.AI_DOUBAO_TTS_RESOURCE_ID || file.resourceId,
    secretKey: process.env.AI_DOUBAO_TTS_SECRET || file.secretKey,
  }
}

/** 合并并保存豆包 TTS 配置（传入字段覆盖，其余保留原值）。 */
export function saveDoubaoTtsConfig(patch: Partial<DoubaoTtsConfig>): void {
  const current = readFile()
  writeConfig({ ...current, doubaoTts: { ...current.doubaoTts, ...patch } })
}

/** 读取美股监控配置（套用默认值）。 */
export function loadStocksConfig(): Required<Pick<StocksConfig, 'pollSeconds' | 'notify'>> &
  StocksConfig {
  const file = readFile().stocks ?? {}
  return {
    watch: file.watch ?? [],
    pollSeconds: Number(process.env.AI_STOCK_POLL) || file.pollSeconds || 60,
    notify: file.notify ?? ['email', 'terminal'],
    emailTo: process.env.AI_STOCK_EMAIL || file.emailTo,
  }
}

/** 合并并保存美股监控配置（传入字段覆盖，其余保留原值）。 */
export function saveStocksConfig(patch: Partial<StocksConfig>): void {
  const current = readFile()
  writeConfig({ ...current, stocks: { ...current.stocks, ...patch } })
}

/** 新增或更新一条监控规则（按 symbol 去重，合并字段），返回更新后的全部规则。 */
export function upsertStockRule(rule: StockRule): StockRule[] {
  const current = readFile()
  const list = (current.stocks?.watch ?? []).slice()
  const sym = rule.symbol.toUpperCase()
  const idx = list.findIndex(r => r.symbol.toUpperCase() === sym)
  const next: StockRule = { ...(idx >= 0 ? list[idx] : {}), ...rule, symbol: sym }
  if (idx >= 0) list[idx] = next
  else list.push(next)
  writeConfig({ ...current, stocks: { ...current.stocks, watch: list } })
  return list
}

/** 删除某只股票的监控规则，返回更新后的全部规则。 */
export function removeStockRule(symbol: string): StockRule[] {
  const current = readFile()
  const sym = symbol.toUpperCase()
  const list = (current.stocks?.watch ?? []).filter(r => r.symbol.toUpperCase() !== sym)
  writeConfig({ ...current, stocks: { ...current.stocks, watch: list } })
  return list
}
