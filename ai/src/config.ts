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

export type Config = {
  apiKey?: string
  model?: string
  baseURL?: string
  qq?: QQConfig
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
