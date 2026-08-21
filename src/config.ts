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

/** 一个已保存的模型预设：切换时把这几项整体写进顶层 apiKey/model/baseURL/provider。 */
export type ModelProfile = {
  /** 自定义名字，/models 或 --use-model 用它来选（大小写不敏感） */
  name: string
  model: string
  baseURL: string
  /** 不传则切换时沿用当前已保存的 apiKey（多个预设共用同一个 key 时可省略） */
  apiKey?: string
  /** 服务商显示名，仅用于界面/报错（如 "OpenAI"、"通义千问"） */
  provider?: string
}

/** MCP stdio server. Omitting type is accepted for Claude Code compatibility. */
export type McpStdioServerConfig = {
  type?: 'stdio'
  command: string
  args?: string[]
  env?: Record<string, string>
  /** Working directory for the spawned server; relative paths resolve from the active project. */
  cwd?: string
  disabled?: boolean
}

/** Remote MCP server using Streamable HTTP or the legacy SSE transport. */
export type McpOAuthConfig = {
  /** Pre-registered OAuth client ID. Omit to use Dynamic Client Registration. */
  clientId?: string
  /** Fixed localhost callback port for providers with a pre-registered redirect URI. */
  callbackPort?: number
  /** Optional authorization-server metadata endpoint override. */
  authServerMetadataUrl?: string
}

export type McpRemoteServerConfig = {
  type: 'http' | 'sse'
  url: string
  headers?: Record<string, string>
  /** Shell command returning a JSON object of dynamic request headers. */
  headersHelper?: string
  /** OAuth Authorization Code + PKCE settings. OAuth also works via discovery when omitted. */
  oauth?: McpOAuthConfig
  disabled?: boolean
}

/** Remote MCP server using JSON-RPC messages over WebSocket. */
export type McpWebSocketServerConfig = {
  type: 'ws'
  url: string
  headers?: Record<string, string>
  /** Shell command returning a JSON object of dynamic connection headers. */
  headersHelper?: string
  disabled?: boolean
}

export type McpServerConfig = McpStdioServerConfig | McpRemoteServerConfig | McpWebSocketServerConfig

export const CODEX_SUBSCRIPTION_PROVIDER = 'Codex Subscription'
export const CODEX_SUBSCRIPTION_BASE_URL = 'codex://chatgpt-subscription'

/** Built-in profiles are always available and do not need an API key. */
export const BUILTIN_MODEL_PROFILES: readonly ModelProfile[] = [
  {
    name: '5.6-sol',
    model: 'gpt-5.6-sol',
    baseURL: CODEX_SUBSCRIPTION_BASE_URL,
    provider: CODEX_SUBSCRIPTION_PROVIDER,
  },
]

export function isCodexSubscriptionProvider(provider?: string, baseURL?: string): boolean {
  return provider === CODEX_SUBSCRIPTION_PROVIDER || baseURL === CODEX_SUBSCRIPTION_BASE_URL
}

export function modelNeedsApiKey(config: Pick<EffectiveModelConfig, 'provider' | 'baseURL'>): boolean {
  return !isCodexSubscriptionProvider(config.provider, config.baseURL)
}

export type ModelChannel = 'qq' | 'wx' | 'wechat'

export type Config = {
  apiKey?: string
  model?: string
  baseURL?: string
  /** 服务商显示名，仅用于界面/报错（如 "OpenAI"、"通义千问"）。不影响连接。 */
  provider?: string
  /** 已保存的模型预设列表，供 /models（对话框内）或 --use-model 切换。 */
  models?: ModelProfile[]
  /** 当前生效的预设名（仅用于 /models 列表里标注「当前」，不影响实际连接参数）。 */
  activeModel?: string
  /** 长驻消息渠道各自使用的模型预设名。未设置的渠道继承顶层 activeModel / 模型配置。 */
  channelModels?: Partial<Record<ModelChannel, string>>
  qq?: QQConfig
  wechat?: WechatConfig
  wx?: WxConfig
  smtp?: SmtpConfig
  stocks?: StocksConfig
  doubaoTts?: DoubaoTtsConfig
  /** User-wide MCP servers. Project .mcp.json entries override servers with the same name. */
  mcpServers?: Record<string, McpServerConfig>
  /** Machine-local MCP overrides keyed by canonical project root; never written to .mcp.json. */
  mcpProjects?: Record<string, { mcpServers?: Record<string, McpServerConfig> }>
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
export type EffectiveModelConfig = Required<Pick<Config, 'model' | 'baseURL'>> & {
  apiKey?: string
  provider?: string
  activeModel?: string
}

/**
 * 读取模型调用参数。传 channel 时优先使用该渠道绑定的模型预设，并在每次调用时重新读文件，
 * 因而长驻的 QQ / 微信进程无需重启即可切换模型。
 *
 * 渠道专用环境变量（如 AI_QQ_API_KEY）优先级最高；未绑定渠道预设时继承全局配置。
 */
export function loadConfig(channel?: ModelChannel): EffectiveModelConfig {
  const file = readFile()
  const global: EffectiveModelConfig = {
    apiKey: process.env.AI_API_KEY || process.env.DEEPSEEK_API_KEY || file.apiKey,
    model: process.env.AI_MODEL || file.model || DEFAULT_MODEL,
    baseURL:
      process.env.AI_BASE_URL ||
      process.env.DEEPSEEK_BASE_URL ||
      file.baseURL ||
      DEFAULT_BASE_URL,
    provider: process.env.AI_PROVIDER || file.provider,
    activeModel: file.activeModel,
  }
  if (!channel) return global

  const envPrefix = `AI_${channel.toUpperCase()}_`
  const profileName = file.channelModels?.[channel]
  const profile = profileName
    ? findModelProfile(file, profileName)
    : undefined

  return {
    apiKey: process.env[`${envPrefix}API_KEY`] || profile?.apiKey || global.apiKey,
    model: process.env[`${envPrefix}MODEL`] || profile?.model || global.model,
    baseURL: process.env[`${envPrefix}BASE_URL`] || profile?.baseURL || global.baseURL,
    provider: process.env[`${envPrefix}PROVIDER`] || (profile ? profile.provider : global.provider),
    activeModel: profile?.name || global.activeModel,
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

/** Replace the user-wide MCP server map while preserving every other config section. */
export function saveUserMcpServers(mcpServers: Record<string, McpServerConfig>): void {
  writeConfig({ ...readFile(), mcpServers })
}

/** Replace one project's machine-local MCP map while preserving global configuration. */
export function saveLocalMcpServers(projectRoot: string, mcpServers: Record<string, McpServerConfig>): void {
  const current = readFile()
  writeConfig({
    ...current,
    mcpProjects: {
      ...(current.mcpProjects ?? {}),
      [projectRoot]: { mcpServers },
    },
  })
}

// ———————————————————————————————————————————————
// 模型预设（多套 model/baseURL/apiKey 组合，按名字切换）
// ———————————————————————————————————————————————

/** 读取所有已保存的模型预设。 */
export function loadModels(): ModelProfile[] {
  const saved = readFile().models ?? []
  const builtInNames = new Set(BUILTIN_MODEL_PROFILES.map(model => model.name.toLowerCase()))
  return [
    ...BUILTIN_MODEL_PROFILES,
    ...saved.filter(model => !builtInNames.has(model.name.toLowerCase())),
  ]
}

function findModelProfile(config: Config, name: string): ModelProfile | undefined {
  const normalized = name.toLowerCase()
  return (
    BUILTIN_MODEL_PROFILES.find(model => model.name.toLowerCase() === normalized) ??
    (config.models ?? []).find(model => model.name.toLowerCase() === normalized)
  )
}

/** 新增或更新一个模型预设（按 name 大小写不敏感去重，字段增量合并）。 */
export function saveModelProfile(profile: ModelProfile): ModelProfile[] {
  const current = readFile()
  const list = (current.models ?? []).slice()
  const idx = list.findIndex(m => m.name.toLowerCase() === profile.name.toLowerCase())
  if (idx >= 0) list[idx] = { ...list[idx], ...profile }
  else list.push(profile)
  writeConfig({ ...current, models: list })
  return list
}

/** 删除一个模型预设，返回更新后的列表。 */
export function removeModelProfile(name: string): ModelProfile[] {
  if (BUILTIN_MODEL_PROFILES.some(model => model.name.toLowerCase() === name.toLowerCase())) {
    return loadModels()
  }
  const current = readFile()
  const list = (current.models ?? []).filter(m => m.name.toLowerCase() !== name.toLowerCase())
  const channelModels = { ...current.channelModels }
  for (const channel of ['qq', 'wx', 'wechat'] as const) {
    if (channelModels[channel]?.toLowerCase() === name.toLowerCase()) delete channelModels[channel]
  }
  writeConfig({ ...current, models: list, channelModels })
  return list
}

/**
 * 按名字切换当前生效模型：把该预设的 model/baseURL/provider（以及 apiKey，若预设带了）
 * 写进顶层配置，并记下 activeModel 名字（仅用于 /models 列表标注「当前」）。
 * 找不到该名字则返回 undefined，调用方据此提示用户。
 */
export function switchModel(name: string, channel?: ModelChannel): ModelProfile | undefined {
  const current = readFile()
  const profile = findModelProfile(current, name)
  if (!profile) return undefined
  if (channel) {
    writeConfig({
      ...current,
      channelModels: { ...current.channelModels, [channel]: profile.name },
    })
    return profile
  }
  writeConfig({
    ...current,
    apiKey: profile.apiKey ?? current.apiKey,
    model: profile.model,
    baseURL: profile.baseURL,
    provider: profile.provider,
    activeModel: profile.name,
  })
  return profile
}

/** 将同一个预设绑定到全部长驻消息渠道。 */
export function switchAllChannelModels(name: string): ModelProfile | undefined {
  const current = readFile()
  const profile = findModelProfile(current, name)
  if (!profile) return undefined
  writeConfig({
    ...current,
    channelModels: { qq: profile.name, wx: profile.name, wechat: profile.name },
  })
  return profile
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
