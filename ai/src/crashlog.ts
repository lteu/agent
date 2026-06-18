// 崩溃日志：进程意外退出时，把错误、运行环境、以及「最近的按键序列」一并落盘，
// 方便事后复现究竟是哪种输入触发的。日志追加写到 ~/.ai/crash.log。

import { homedir } from 'node:os'
import { join } from 'node:path'
import { appendFileSync, mkdirSync } from 'node:fs'

const LOG_DIR = join(homedir(), '.ai')
export const CRASH_LOG = join(LOG_DIR, 'crash.log')

// 最近输入事件的环形缓冲。崩溃多半发生在敲键的当下，这段序列就是最好的线索。
const MAX_RECENT = 60
const recent: string[] = []

/** 在每次按键时调用，记录这次输入（字符 + 命中的特殊键）。 */
export function recordInput(input: string, key: Record<string, unknown>): void {
  const flags = Object.keys(key).filter(k => key[k])
  const stamp = new Date().toISOString().slice(11, 23) // 只留 时:分:秒.毫秒
  recent.push(`${stamp} ${JSON.stringify(input)}${flags.length ? ' +' + flags.join(',') : ''}`)
  if (recent.length > MAX_RECENT) recent.shift()
}

/** 落盘一条崩溃记录，返回日志文件路径。 */
export function writeCrash(label: string, err: unknown): string {
  const time = new Date().toISOString()
  const stack = err instanceof Error ? err.stack ?? err.message : String(err)
  const block =
    `\n===== ${time} [${label}] =====\n` +
    `node ${process.version} · ${process.platform} · argv: ${process.argv.slice(2).join(' ') || '(none)'}\n` +
    `tty ${process.stdout.columns ?? '?'}x${process.stdout.rows ?? '?'} · TERM=${process.env.TERM ?? ''}\n` +
    `最近 ${recent.length} 次按键（旧→新）:\n` +
    (recent.length ? recent.map(l => '  ' + l).join('\n') : '  (无)') +
    `\n错误:\n${stack}\n`
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    appendFileSync(CRASH_LOG, block)
  } catch {
    /* 写日志失败也不能再抛，否则套娃崩溃 */
  }
  return CRASH_LOG
}
