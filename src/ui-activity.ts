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
  if (['read_file', 'excel_read', 'pdf_read', 'powerpoint_read', 'term_read'].includes(name)) {
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

function terminalWidth(text: string): number {
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
