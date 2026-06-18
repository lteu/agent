// 聊天历史日志：把每一轮「问→答」追加记录下来，并标注
//   · 话题（topic）——同一会话的第一条用户消息，整段对话沿用
//   · 渠道（channel）——消息从哪来：PC 终端 / QQ / 企业微信
// 终端、QQ、企业微信三个 channel 共用本模块。
//
// 落地两份文件（都在 ~/.ai/ 下）：
//   chat-history.jsonl  每行一个 JSON，机器可读，便于检索/统计
//   chat-history.md     人类可读，按「[渠道] 话题」分节，方便直接翻看

import { homedir } from 'node:os'
import { join } from 'node:path'
import { appendFileSync, mkdirSync } from 'node:fs'

const LOG_DIR = join(homedir(), '.ai')
export const CHATLOG_JSONL = join(LOG_DIR, 'chat-history.jsonl')
export const CHATLOG_MD = join(LOG_DIR, 'chat-history.md')

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

/** 记录一轮问答。日志失败绝不影响主流程。 */
export function logChat(turn: LogTurn): void {
  const topic = topicFor(turn.sessionId, turn.question)
  const time = new Date().toISOString()
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    appendFileSync(
      CHATLOG_JSONL,
      JSON.stringify({ time, channel: turn.channel, topic, ...turn }) + '\n',
    )
    const md =
      `\n## [${CHANNEL_LABEL[turn.channel]}] ${topic}\n` +
      `- 时间：${new Date().toLocaleString()}\n` +
      `- 会话：${turn.sessionId}\n\n` +
      `**问：** ${turn.question}\n\n` +
      `**答：** ${turn.answer}\n`
    appendFileSync(CHATLOG_MD, md)
  } catch {
    /* 写日志失败时静默，不打断对话 */
  }
}
