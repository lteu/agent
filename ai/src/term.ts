// 常驻终端：用 tmux 维护「跨多条消息存活」的交互式会话。
// 让 QQ/终端两端的 agent 能：开一个会话里跑 claude code 等交互程序、读它的屏幕日志、
// 再把下一条指令当按键敲进去——这是 run_bash（一次性、60s、新 shell）做不到的。
//
// 设计要点：
//   · 会话名一律加前缀 ai_，避免和你自己开的 tmux 会话撞名/误杀。
//   · 启动时固定 200x50 的窗口，让 claude code 这类 TUI 能正常渲染。
//   · 读屏用 capture-pane -p（纯文本，不含 ANSI 转义），TUI 抓到的就是当前可见画面。
//   · 写入用 send-keys：默认按字面文本敲（再补一个回车）；literal=false 时按「键名」敲
//     （如 C-c 中断、Up 上一条历史），用于发控制键。

import { execFile } from 'node:child_process'

const PREFIX = 'ai_'

// 会话名清洗：只留字母数字和 _-，其余替换成 _（tmux 名字里 . : 有特殊含义）。
function sessionName(name: string): string {
  const clean = String(name || 'main').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40)
  return PREFIX + (clean || 'main')
}

// 去掉展示用名字里的前缀。
function displayName(full: string): string {
  return full.startsWith(PREFIX) ? full.slice(PREFIX.length) : full
}

type TmuxResult = { ok: boolean; out: string; missing?: boolean }

// 跑一条 tmux 命令。tmux 没装时 missing=true，让上层给出 brew 安装提示。
function tmux(args: string[]): Promise<TmuxResult> {
  return new Promise(res => {
    execFile('tmux', args, { timeout: 15_000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = [stdout, stderr].filter(Boolean).join('\n').replace(/\s+$/, '')
      if (err && (err as any).code === 'ENOENT') {
        res({ ok: false, out: '', missing: true })
      } else if (err) {
        res({ ok: false, out: out || (err as Error).message })
      } else {
        res({ ok: true, out })
      }
    })
  })
}

const NEED_TMUX =
  '本机未安装 tmux（常驻终端依赖它）。请先安装：brew install tmux'

async function hasSession(full: string): Promise<TmuxResult> {
  return tmux(['has-session', '-t', `=${full}`])
}

/** 开一个常驻会话；可选地在里面启动一条命令（如 claude）。 */
export async function termOpen(name: string, command?: string): Promise<string> {
  const full = sessionName(name)
  const exists = await hasSession(full)
  if (exists.missing) return NEED_TMUX
  if (exists.ok) {
    // 已存在：不重开，避免把正在跑的东西冲掉。
    return `会话「${displayName(full)}」已存在（未重开）。如需在其中执行命令，用 term_send。`
  }
  // 固定窗口尺寸，让 TUI 有足够宽高渲染。
  const created = await tmux(['new-session', '-d', '-s', full, '-x', '200', '-y', '50'])
  if (created.missing) return NEED_TMUX
  if (!created.ok) return `开会话失败：${created.out}`
  if (command && command.trim()) {
    const sent = await sendText(full, command.trim(), true, true)
    if (!sent.ok) return `会话已建，但启动命令失败：${sent.out}`
    return `已开会话「${displayName(full)}」并启动：${command.trim()}\n（稍候用 term_read 看输出；再发指令用 term_send）`
  }
  return `已开会话「${displayName(full)}」（一个空 shell，等待 term_send 输入）`
}

// send-keys 的薄封装：literal=true 按字面文本敲，false 按 tmux 键名敲。
async function sendText(full: string, input: string, enter: boolean, literal: boolean): Promise<TmuxResult> {
  const base = ['send-keys', '-t', full]
  const r = literal ? await tmux([...base, '-l', '--', input]) : await tmux([...base, '--', input])
  if (!r.ok) return r
  if (enter) return tmux([...base, 'Enter'])
  return r
}

/**
 * 给会话发输入。
 * literal=true（默认）：把 input 当字面文本敲进去，enter=true 时再补一个回车。
 * literal=false：把 input 当 tmux 键名（如 C-c 中断、Up 历史、Enter）发，用于控制键。
 */
export async function termSend(
  name: string,
  input: string,
  enter = true,
  literal = true,
): Promise<string> {
  const full = sessionName(name)
  const exists = await hasSession(full)
  if (exists.missing) return NEED_TMUX
  if (!exists.ok) return `会话「${displayName(full)}」不存在。先用 term_open 开一个。`
  const r = await sendText(full, input, enter, literal)
  if (!r.ok) return `发送失败：${r.out}`
  return `已向会话「${displayName(full)}」发送：${literal ? input : `[键] ${input}`}${enter ? ' ⏎' : ''}`
}

/** 读会话当前屏幕 + 最近 lines 行历史（纯文本）。可选先等 waitMs 毫秒再抓，给程序留出输出时间。 */
export async function termRead(name: string, lines = 200, waitMs = 0): Promise<string> {
  const full = sessionName(name)
  const exists = await hasSession(full)
  if (exists.missing) return NEED_TMUX
  if (!exists.ok) return `会话「${displayName(full)}」不存在。先用 term_open 开一个。`
  const wait = Math.min(Math.max(0, waitMs), 10_000)
  if (wait) await new Promise(r => setTimeout(r, wait))
  const start = Math.min(Math.max(1, lines), 5000)
  const cap = await tmux(['capture-pane', '-t', full, '-p', '-S', `-${start}`])
  if (cap.missing) return NEED_TMUX
  if (!cap.ok) return `读屏失败：${cap.out}`
  const text = cap.out.replace(/\n+$/, '') // 去掉末尾空行
  return text || '(会话当前没有可见输出)'
}

/** 列出所有 ai_ 前缀的常驻会话。 */
export async function termList(): Promise<string> {
  const r = await tmux(['list-sessions', '-F', '#{session_name}\t#{windows} 窗口\t#{?session_attached,已连接,空闲}'])
  if (r.missing) return NEED_TMUX
  // tmux 在没有任何会话时 list-sessions 会非 0 退出并报 "no server running"。
  if (!r.ok) return '当前没有常驻会话。'
  const rows = r.out
    .split('\n')
    .filter(line => line.startsWith(PREFIX))
    .map(line => {
      const [n, ...rest] = line.split('\t')
      return `· ${displayName(n)}\t${rest.join('\t')}`
    })
  return rows.length ? rows.join('\n') : '当前没有常驻会话。'
}

/** 结束一个常驻会话（会杀掉里面在跑的程序）。 */
export async function termKill(name: string): Promise<string> {
  const full = sessionName(name)
  const exists = await hasSession(full)
  if (exists.missing) return NEED_TMUX
  if (!exists.ok) return `会话「${displayName(full)}」不存在（无需结束）。`
  const r = await tmux(['kill-session', '-t', full])
  if (!r.ok) return `结束失败：${r.out}`
  return `已结束会话「${displayName(full)}」。`
}
