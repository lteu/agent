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
): ActiveToolPresentation {
  if (name === 'run_bash' || name === 'run_admin') {
    return {
      label: 'Running 1 shell command…',
      ...(detail?.trim() ? { detail: `$ ${detail.trim()}` } : {}),
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
