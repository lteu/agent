export type ActivityCounts = {
  reads: number
  directories: number
  commands: number
  searches: number
  edits: number
  browser: number
  other: number
}

export const EMPTY_ACTIVITY_COUNTS: ActivityCounts = {
  reads: 0,
  directories: 0,
  commands: 0,
  searches: 0,
  edits: 0,
  browser: 0,
  other: 0,
}

export function activityCategory(
  name: string,
): keyof ActivityCounts | 'remote-web' | 'subagent' {
  if (name === 'WebSearch' || name === 'WebFetch') return 'remote-web'
  if (name === 'run_agent') return 'subagent'
  if (['read_file', 'view_image', 'excel_read', 'pdf_read', 'powerpoint_read', 'term_read'].includes(name)) {
    return 'reads'
  }
  if (name === 'list_dir' || name === 'term_list') return 'directories'
  if (name === 'run_bash' || name === 'run_admin') return 'commands'
  if (name === 'grep' || name === 'glob' || name === 'web_fetch') return 'searches'
  if (name === 'write_file' || name === 'edit_file') return 'edits'
  if (name.startsWith('browser_')) return 'browser'
  return 'other'
}

export function addActivity(counts: ActivityCounts, toolName: string): ActivityCounts {
  const category = activityCategory(toolName)
  if (category === 'remote-web' || category === 'subagent') return counts
  return { ...counts, [category]: counts[category] + 1 }
}

function item(count: number, active: string, completed: string, singular: string, plural: string, busy: boolean) {
  if (!count) return ''
  return `${busy ? active : completed} ${count} ${count === 1 ? singular : plural}`
}

export function formatActivity(counts: ActivityCounts, busy: boolean): string {
  return [
    item(counts.reads, 'Reading', 'Read', 'file', 'files', busy),
    item(counts.directories, 'listing', 'listed', 'directory', 'directories', busy),
    item(counts.commands, 'running', 'ran', 'shell command', 'shell commands', busy),
    item(counts.searches, 'searching', 'searched', 'source', 'sources', busy),
    item(counts.edits, 'editing', 'edited', 'file', 'files', busy),
    item(counts.browser, 'using', 'used', 'browser action', 'browser actions', busy),
    item(counts.other, 'running', 'ran', 'tool', 'tools', busy),
  ].filter(Boolean).join(', ') + (busy ? '…' : '')
}

export function hasActivity(counts: ActivityCounts): boolean {
  return Object.values(counts).some(value => value > 0)
}

export type ActiveToolPresentation = {
  label: string
  detail?: string
}

export function activeToolPresentation(
  name: string,
  summary: string,
  detail?: string,
  columns = 80,
): ActiveToolPresentation {
  if (name === 'run_bash' || name === 'run_admin') {
    const command = detail?.trim() ? singleRow(`$ ${detail.trim()}`, columns - 6) : ''
    return {
      label: 'Running 1 shell command…',
      ...(command ? { detail: command } : {}),
    }
  }
  if (['read_file', 'view_image', 'excel_read', 'pdf_read', 'powerpoint_read', 'term_read'].includes(name)) {
    return { label: 'Reading 1 file…' }
  }
  return { label: summary }
}

export function conciseToolCardResult(
  title: string,
  result: string | undefined,
  failed: boolean,
): string {
  if (!result) return failed ? 'Failed' : 'Completed'
  const withoutStatus = result.replace(/^[✓✗]\s*/, '')
  if (withoutStatus === title) return failed ? 'Failed' : 'Completed'
  if (withoutStatus.startsWith(`${title} · `)) return withoutStatus.slice(title.length + 3)
  return withoutStatus
}

/**
 * Keep failed shell commands useful without turning a traceback into the main UI.
 * The complete output remains available in the transcript; the normal view gets
 * the exit status plus the most actionable error line.
 */
export function conciseShellFailure(result: string, detail?: string): string {
  if (!detail) return result
  const lines = detail
    .replace(/\0/g, '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => !/^(?:\^+|~+|\.{3}|命令退出码\s+\d+|exit code\s+\d+)$/i.test(line))

  const diagnostic = [...lines].reverse().find(line =>
    /error|exception|failed|failure|not found|no such|denied|refused|timed?\s*out|cannot|unable|invalid/i.test(line),
  )
  if (!diagnostic) return result

  const clipped = diagnostic.length > 180 ? `${diagnostic.slice(0, 177)}…` : diagnostic
  return result.includes(clipped) ? result : `${result} · ${clipped}`
}

export type RecoverableToolFailurePresentation = {
  result: string
  quiet: true
}

/** Expected coordination errors stay in the timeline, but only need one calm,
 * actionable sentence in the normal view. Raw payloads remain in transcript. */
export function recoverableToolFailure(
  name: string,
  result: string | undefined,
  detail?: string,
): RecoverableToolFailurePresentation | undefined {
  if (name !== 'write_file' && name !== 'edit_file') return undefined
  const message = `${result ?? ''}\n${detail ?? ''}`
  if (/修改已有文件前必须先用\s+read_file\s+读取/.test(message)) {
    return { result: '修改前需要先读取文件', quiet: true }
  }
  if (/文件在读取后已被其他进程修改|重新\s+read_file\s+后再编辑/.test(message)) {
    return { result: '文件已发生变化，需要重新读取', quiet: true }
  }
  return undefined
}

/** Local web_fetch titles already contain the URL, so keep its result to status
 * metadata only. The response body belongs in the Ctrl+O transcript. */
export function conciseWebFetchResult(result: string | undefined, detail?: string): string {
  const plain = result?.replace(/^[✓✗]\s*/, '') ?? ''
  const status = plain.match(/HTTP\s+\d{3}/i)?.[0]
    ?? detail?.match(/^HTTP\s+\d{3}/im)?.[0]
  const attempts = plain.match(/\d+\s*次尝试/)?.[0]
  const contentType = detail
    ?.match(/^HTTP\s+\d{3}\s+([^;\s]+)/im)?.[1]
  const parts = [status, attempts, contentType].filter(Boolean)
  return parts.length ? parts.join(' · ') : (plain || 'Completed')
}

export type BrowserToolCardPresentation = {
  result: string
  preview?: string
  finalUrl?: string
}

/** Turn a browser snapshot into the small amount of information useful in the
 * normal conversation. The full snapshot remains in the transcript ledger. */
export function conciseBrowserToolCard(
  name: string,
  detail: string | undefined,
): BrowserToolCardPresentation | undefined {
  if (!name.startsWith('browser_') || !detail) return undefined

  const title = detail.match(/^标题:\s*(.*)$/m)?.[1]?.trim()
  const finalUrl = detail.match(/^地址:\s*(https?:\/\/\S+)$/m)?.[1]
  if (!title && !finalUrl) return undefined

  let target = title
  if (!target && finalUrl) {
    try {
      const parsed = new URL(finalUrl)
      target = `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`
    } catch {
      target = finalUrl
    }
  }

  const verb = name === 'browser_goto'
    ? '已跳转到'
    : name === 'browser_open'
      ? '已打开'
      : name === 'browser_snapshot'
        ? '已读取'
        : '已更新'

  const snapshotBody = detail
    .replace(/[\s\S]*?^标题:.*\n地址:.*\n?/m, '')
    .trim()

  return {
    result: `${verb} ${target || '当前页面'}`,
    ...(snapshotBody ? { preview: snapshotBody } : {}),
    ...(finalUrl ? { finalUrl } : {}),
  }
}

export function terminalWidth(text: string): number {
  return [...text].reduce((width, char) => {
    const code = char.codePointAt(0) ?? 0
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      code === 0x2329 ||
      code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1faff)
    return width + (wide ? 2 : 1)
  }, 0)
}

function truncateToWidth(text: string, width: number): string {
  if (terminalWidth(text) <= width) return text
  let out = ''
  let used = 0
  for (const char of text) {
    const charWidth = terminalWidth(char)
    if (used + charWidth > width - 1) break
    out += char
    used += charWidth
  }
  return `${out.trimEnd()}…`
}

/** Keep the last `cells` display columns of a single line, marking the cut. */
export function tailToWidth(text: string, cells: number): string {
  const limit = Math.max(2, cells)
  if (terminalWidth(text) <= limit) return text
  const chars = [...text]
  let out = ''
  let used = 0
  for (let i = chars.length - 1; i >= 0; i--) {
    const charWidth = terminalWidth(chars[i])
    if (used + charWidth > limit - 1) break
    out = chars[i] + out
    used += charWidth
  }
  return `…${out}`
}

/**
 * Collapse a value into exactly one terminal row.
 *
 * Nothing in the live footer may grow with its content. Ink erases the previous
 * frame by moving the cursor up as many rows as that frame had; once a frame is
 * taller than the physical screen those rows have already scrolled away, the
 * erase silently does nothing, and every repaint appends another full copy of the
 * footer instead of replacing it — a multi-line heredoc passed to run_bash used
 * to redraw the whole command several times per second (see issue.png).
 */
export function singleRow(text: string, columns: number): string {
  const width = Math.max(8, columns)
  const [first = '', ...rest] = text.split('\n')
  const flattened = rest.some(line => line.trim())
    ? `${first.trimEnd()} …`
    : first.trimEnd()
  return truncateToWidth(flattened, width)
}

function wrapByTerminalWidth(text: string, width: number): string[] {
  const rows: string[] = []
  for (const logicalLine of text.split('\n')) {
    if (!logicalLine) {
      rows.push('')
      continue
    }
    let row = ''
    let used = 0
    for (const char of logicalLine) {
      const charWidth = terminalWidth(char)
      if (used + charWidth > width && row) {
        rows.push(row.trimEnd())
        row = ''
        used = 0
      }
      row += char
      used += charWidth
    }
    rows.push(row.trimEnd())
  }
  return rows
}

/** Limit the complete result area (summary plus preview) to three visual rows.
 * Truncation is terminal-width aware, so one giant URL cannot create a dozen
 * wrapped rows while still counting as one logical line. */
export function compactToolResultRows(
  result: string,
  preview: string | undefined,
  columns: number,
  maxRows = 3,
): { text: string; hiddenRows: number } {
  const content = [result, preview].filter(Boolean).join('\n').trimEnd()
  if (!content) return { text: '', hiddenRows: 0 }

  const width = Math.max(10, columns - 6)
  const rows = wrapByTerminalWidth(content, width)
  if (rows.length <= maxRows) return { text: rows.join('\n'), hiddenRows: 0 }

  const visibleContentRows = Math.max(1, maxRows - 1)
  const hiddenRows = rows.length - visibleContentRows
  return {
    text: [
      ...rows.slice(0, visibleContentRows),
      `… +${hiddenRows} lines (Ctrl+O to expand)`,
    ].join('\n'),
    hiddenRows,
  }
}

/** Keep the first `maxRows` terminal rows of a block, marking what was dropped. */
export function clampRows(text: string, maxRows: number, columns: number): string {
  const rows = wrapByTerminalWidth(text, Math.max(1, columns))
  if (rows.length <= maxRows) return text
  const visible = Math.max(1, maxRows - 1)
  return [
    ...rows.slice(0, visible),
    `… +${rows.length - visible} lines (Ctrl+O to expand)`,
  ].join('\n')
}

/**
 * 取文本「末尾若干行」，按终端列宽把自动换行也算进占用行数。
 * 用途：底部那截「正在生成、尚未成行」的流式尾巴限高，绝不让它撑爆动态区、
 * 把输入框顶到屏幕最上方。完整内容会逐行沉淀进上方历史，这里只截断实时预览，不丢信息。
 */
export function tailByRows(
  text: string,
  maxRows: number,
  columns: number,
): { shown: string; truncated: boolean } {
  const logical = text.split('\n')
  const width = Math.max(1, columns)
  const rows = Math.max(1, maxRows)
  const out: string[] = []
  let used = 0
  let truncated = false
  for (let i = logical.length - 1; i >= 0; i--) {
    const line = logical[i]
    // 必须按显示宽度算：中文一个字占两列，用 line.length 会把行数少算一半，
    // 动态区就会比终端还高，Ink 的「上移 N 行再擦除」失效、每帧都追加一份（issue.png）。
    const wrapped = Math.max(1, Math.ceil(terminalWidth(line) / width)) // 空行也占 1 行
    if (out.length === 0 && wrapped > rows) {
      // 模型长时间不吐换行时，单独一「逻辑行」就能比整块预算还高。
      // 这种情况只保留它末尾的几行，否则限高等于没做。
      out.unshift(tailToWidth(line, rows * width))
      truncated = true
      break
    }
    if (used + wrapped > rows) {
      truncated = true
      break
    }
    out.unshift(line)
    used += wrapped
    if (used >= rows) break
  }
  return { shown: out.join('\n'), truncated: truncated || out.length < logical.length }
}

export type LiveFooterPlan = {
  /** How many of the running tools fit; each one costs a label plus its detail. */
  tools: number
  /** Rows available to the not-yet-committed streaming tail. */
  stream: number
  /** How many queued prompts fit, each collapsed to a single row. */
  queued: number
  /** Rows available to a /btw answer. */
  btw: number
}

/**
 * Split the terminal height between the pieces of the live footer.
 *
 * The footer is redrawn several times a second, so it has to stay strictly
 * shorter than the physical screen — see the note on {@link singleRow}. Every
 * section is therefore given a row budget instead of rendering whatever the model
 * happened to produce; the full text always remains in the Ctrl+O transcript.
 */
export function planLiveFooter(input: {
  rows: number
  tools: number
  queued: number
  hasError: boolean
  hasBtw: boolean
}): LiveFooterPlan {
  // Bordered input box (3) + footer hint (1) + status line with its margin (2)
  // + slack for wrapped hints and the blank row Ink keeps below the frame.
  // The /btw panel replaces the input box and footer, so it needs less chrome.
  const CHROME_ROWS = input.hasBtw ? 5 : 9
  // The error box and every section margin cost rows too; budget them up front.
  let available = input.rows - CHROME_ROWS - (input.hasError ? 3 : 0)

  // A running tool is the most useful thing on screen, so it is served first:
  // one row for the label, one for the (already single-row) command. Two rows are
  // always held back so the streaming tail keeps a row plus its margin.
  const tools = Math.max(
    0,
    Math.min(input.tools, input.hasBtw ? 1 : 3, Math.floor((available - 2) / 2)),
  )
  available -= tools * 2

  // The /btw panel adds a border, the question, a hint and two margins.
  const btw = input.hasBtw ? Math.max(1, Math.min(8, available - 8)) : 0
  available -= btw > 0 ? btw + 6 : 0

  // Queued prompts collapse to one row each, plus the section margin.
  const queued = input.queued > 0
    ? Math.max(0, Math.min(input.queued, 3, available - 3))
    : 0
  available -= queued > 0 ? queued + 1 : 0

  // The streaming tail keeps the rest, minus its own margin.
  return { tools, stream: Math.max(1, available - 1), queued, btw }
}

/** Build a full-width prompt block; Text background colors only the glyph area in Ink. */
export function formatUserPrompt(content: string, columns: number): string {
  const target = Math.max(12, columns - 2)
  const output: string[] = []
  for (const logicalLine of content.split('\n')) {
    let line = output.length === 0 ? '  › ' : '    '
    for (const char of logicalLine) {
      const charWidth = terminalWidth(char)
      if (terminalWidth(line) + charWidth > target - 2) {
        output.push(line + ' '.repeat(Math.max(0, target - terminalWidth(line))))
        line = `    ${char}`
      } else {
        line += char
      }
    }
    output.push(line + ' '.repeat(Math.max(0, target - terminalWidth(line))))
  }
  return output.join('\n')
}

export type AgentCardItem = {
  title: string
  status: string
  toolUses: number
  failed: boolean
}

export function cleanAgentTitle(title: string): string {
  return title
    .replace(/^启动子 agent[：:]\s*/, '')
    .replace(/^续跑子 agent\s+\S+[：:]\s*/, '')
    .trim() || 'Untitled task'
}

export function parseAgentCardItem(title: string, detail?: string, failed = false): AgentCardItem {
  let status = failed ? 'Failed' : 'Done'
  let toolUses = 0
  if (detail) {
    try {
      const result = JSON.parse(detail)
      toolUses = Number.isFinite(result.tool_uses) ? result.tool_uses : 0
      if (result.status === 'max_steps') status = 'Needs continuation'
      else if (result.status === 'cancelled') status = 'Cancelled'
      else if (result.status === 'busy') status = 'Already running'
      else if (result.status === 'failed') status = 'Failed'
    } catch {
      // The card still has a useful start title if an older gateway returned plain text.
    }
  }
  return { title: cleanAgentTitle(title), status, toolUses, failed: failed || status === 'Failed' }
}
