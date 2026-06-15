// 配置：API key 与模型的读取/保存。
// 优先级：环境变量 > ~/.ai/config.json

import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'

export type Config = {
  apiKey?: string
  model?: string
  baseURL?: string
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

export function saveApiKey(apiKey: string): void {
  mkdirSync(CONFIG_DIR, { recursive: true })
  const current = readFile()
  writeFileSync(CONFIG_PATH, JSON.stringify({ ...current, apiKey }, null, 2))
  try {
    chmodSync(CONFIG_PATH, 0o600) // key 只对自己可读
  } catch {
    /* 平台不支持时忽略 */
  }
}
