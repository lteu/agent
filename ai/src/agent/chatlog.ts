// 聊天历史日志：把每一轮「问→答」追加记录下来，并标注
//   · 话题（topic）——同一会话的第一条用户消息，整段对话沿用
//   · 渠道（channel）——消息从哪来：PC 终端 / QQ / 企业微信
// 终端、QQ、企业微信三个 channel 共用本模块。
//
// 落地两份文件（在项目 log/ 目录下）：
//   chat-history.jsonl  每行一个 JSON，机器可读，便于检索/统计
//   chat-history.md     人类可读，按「[渠道] 话题」分节，方便直接翻看

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'

/**
 * 返回日志目录路径。
 * 用函数而非顶层常量，是为了防止 esbuild --bundle 在构建时内联
 * fileURLToPath(import.meta.url) 算出错误的路径——
 * 构建时的 __dirname 是源码目录，不是最终产物 dist/ 的目录。
 * 放到函数里运行时才计算，esbuild 就无法常量折叠。
 */
function getLogDir(): string {
  // 注意：此处的 import.meta.url 是调用时所在模块的 URL。
  // 当 chatlog.ts 被 esbuild 内联到 dist/cli.js 后，
  // import.meta.url 对应的是 dist/cli.js 的路径。
  // 因此 dirname -> dist/，join('..') -> 项目根目录。
  const selfPath = fileURLToPath(import.meta.url)
  const selfDir = dirname(selfPath)
  // 如果从 dist/cli.js 运行，selfDir = .../dist/，取上级 = 项目根
  // 如果从 src/agent/chatlog.ts 直接运行（如 tsx），selfDir = .../src/agent/，取上两级 = 项目根
  const projectRoot =
    selfDir.endsWith('/dist') || selfDir.endsWith('/dist/')
      ? dirname(selfDir)
      : join(selfDir, '..', '..')
  return join(projectRoot, 'log')
}

export type LogChannel = 'terminal' | 'qq' | 'wechat'

const CHANNEL_LABEL: Record<LogChannel, string> = {
  terminal: 'PC（终端）',
  qq: 'QQ',
  wechat: '企业微信',
}

// 每个会话第一条用户消息作为该会话「话题」，后续轮次沿用，直到 /clear 重置。
const topics = new Map<string, string>()

function deriveTopic(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > 30 ? oneLine.slice(0, 30) + '…' : oneLine
}

/** 取（必要时确立）某会话的话题。 */
export function topicFor(sessionId: string, question: string): string {
  let t = topics.get(sessionId)
  if (!t) {
    t = deriveTopic(question)
    topics.set(sessionId, t)
  }
  return t
}

/** 清空某会话的话题（配合 /clear：下一条消息会开启新话题）。 */
export function resetTopic(sessionId: string): void {
  topics.delete(sessionId)
}

export type LogTurn = {
  channel: LogChannel
  /** 会话标识：终端用 'terminal'，QQ 群 'g:xxx'/单聊 'c:xxx'，企业微信 'u:xxx'。 */
  sessionId: string
  question: string
  answer: string
}

// 确保 log 目录存在（同步创建，抛出异常以便调用者知晓）
function ensureLogDir(): void {
  mkdirSync(getLogDir(), { recursive: true })
}

/**
 * 在 log 目录写入一个 banner 文件，方便快速确认日志系统是否工作。
 * 应用启动时调用一次即可。
 */
export function writeLogBanner(channel: LogChannel, info: string): void {
  try {
    ensureLogDir()
    const time = new Date().toISOString()
    const bannerFile = join(getLogDir(), `startup-${channel}.log`)
    writeFileSync(bannerFile, `[${time}] ${info}\n`)
  } catch (e) {
    console.error(`[chatlog] 无法写入启动 banner: ${e}`)
  }
}

/** 记录一轮问答。日志失败时写入一条错误标记，但绝不影响主流程。 */
export function logChat(turn: LogTurn): void {
  const topic = topicFor(turn.sessionId, turn.question)
  const time = new Date().toISOString()
  const logDir = getLogDir()
  const jsonlPath = join(logDir, 'chat-history.jsonl')
  const mdPath = join(logDir, 'chat-history.md')
  try {
    ensureLogDir()
    appendFileSync(
      jsonlPath,
      JSON.stringify({ time, channel: turn.channel, topic, ...turn }) + '\n',
    )
    const md =
      `\n## [${CHANNEL_LABEL[turn.channel]}] ${topic}\n` +
      `- 时间：${new Date().toLocaleString()}\n` +
      `- 会话：${turn.sessionId}\n\n` +
      `**问：** ${turn.question}\n\n` +
      `**答：** ${turn.answer}\n`
    appendFileSync(mdPath, md)
  } catch (e) {
    // 日志失败时不打断对话，但写入一个错误标记以便排查
    try {
      ensureLogDir()
      appendFileSync(
        join(logDir, 'chatlog-errors.log'),
        `[${time}] logChat 失败: ${e}\n`,
      )
    } catch {
      // 实在写不了就算了
    }
  }
}
