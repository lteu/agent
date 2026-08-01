export type TranscriptEventKind =
  | 'user'
  | 'assistant_text'
  | 'thinking'
  | 'milestone'
  | 'tool'
  | 'system'

export type TranscriptEvent = {
  id: number
  turnId: number
  at: number
  kind: TranscriptEventKind
  phase?: 'start' | 'progress' | 'success' | 'failure' | 'info'
  name?: string
  callId?: string
  batchId?: string
  summary: string
  /** Full, unabridged payload. Compact/default projections may preview it but never mutate it. */
  detail?: string
}

export type TranscriptLine = {
  key: string
  text: string
  tone: 'normal' | 'dim' | 'success' | 'failure' | 'thinking' | 'user'
  accent?: 'success' | 'failure' | 'pending'
}

const KEY_TOOLS = new Set([
  'WebSearch',
  'WebFetch',
  'web_fetch',
  'write_file',
  'edit_file',
  'run_bash',
  'run_admin',
  'send_email',
  'send_image',
  'send_file',
  'run_agent',
  'screenshot',
])

export function isKeyTool(name: string): boolean {
  return KEY_TOOLS.has(name) || name.startsWith('browser_') || name.startsWith('term_')
}

export function cleanTranscriptText(value: string): string {
  return value
    // Tool output often contains color/cursor controls intended for its own TTY.
    // Rendering those inside Ink can move the cursor, erase lines, or show garbage.
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '')
    .replace(/\r\n?/g, '\n')
    .replaceAll('\t', '  ')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
}

/** Keep the same transcript rows under the viewport while live output is appended. */
export function anchoredTranscriptOffset(
  offsetFromBottom: number,
  previousLineCount: number,
  nextLineCount: number,
): number {
  if (offsetFromBottom <= 0 || nextLineCount <= previousLineCount) return offsetFromBottom
  return offsetFromBottom + (nextLineCount - previousLineCount)
}

export type SgrMouseEvent = {
  code: number
  column: number
  row: number
  action: 'press' | 'release'
  kind: 'primary' | 'wheel-up' | 'wheel-down' | 'other'
}

// Ink 会去掉部分鼠标输入开头的 ESC，因此同时接受原始的 ESC [ < ... 和
// useInput 可能收到的裸 [ < ... 形式。
const SGR_MOUSE_PATTERN = /(?:\x1b)?\[<(\d+);(\d+);(\d+)([Mm])/g

export function parseSgrMouseEvents(value: string): SgrMouseEvent[] {
  const events: SgrMouseEvent[] = []
  for (const match of value.matchAll(SGR_MOUSE_PATTERN)) {
    const code = Number(match[1])
    const wheel = (code & 64) !== 0
    events.push({
      code,
      column: Number(match[2]),
      row: Number(match[3]),
      action: match[4] === 'M' ? 'press' : 'release',
      kind: wheel
        ? (code & 3) === 0 ? 'wheel-up' : (code & 3) === 1 ? 'wheel-down' : 'other'
        : (code & 32) === 0 && (code & 3) === 0 ? 'primary' : 'other',
    })
  }
  return events
}

/** Remove terminal mouse reports before they can be inserted into the prompt. */
export function stripSgrMouseSequences(value: string): string {
  return value.replace(SGR_MOUSE_PATTERN, '')
}

/** True for an SGR mouse primary-button press (not release/drag/scroll). */
export function isPrimaryMousePress(value: string): boolean {
  return parseSgrMouseEvents(value).some(event => event.kind === 'primary' && event.action === 'press')
}

function wrapLine(line: string, width: number): string[] {
  if (!line.length) return [' ']
  const chunks: string[] = []
  let rest = line
  while (rest.length > width) {
    chunks.push(rest.slice(0, width))
    rest = rest.slice(width)
  }
  chunks.push(rest)
  return chunks
}

function inputObject(detail: string | undefined): Record<string, unknown> | undefined {
  if (!detail) return undefined
  try {
    const parsed = JSON.parse(detail)
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

function firstUrl(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const match = value?.match(/https?:\/\/[^\s"')]+/)
    if (match) return match[0]
  }
  return undefined
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

function normalizedWebResultSummary(result: TranscriptEvent): string {
  if (/^(?:Received|Error:|Failed\b)/i.test(result.summary)) {
    return result.summary.replace(/(\d(?:\.\d+)?)\s+(KB|MB|GB)\b/gi, '$1$2')
  }
  const status = `${result.summary}\n${result.detail ?? ''}`.match(
    /(?:HTTP\s*)?(\d{3})(?:\s+([^\n,;)]+))?/i,
  )
  const bytes = Buffer.byteLength(result.detail ?? '', 'utf8')
  return result.phase === 'failure'
    ? `Failed${status ? ` (${status[1]}${status[2] ? ` ${status[2].trim()}` : ''})` : ''}`
    : `Received ${formatBytes(bytes)}${status ? ` (${status[1]}${status[2] ? ` ${status[2].trim()}` : ''})` : ''}`
}

function compactToolPair(start: TranscriptEvent, result: TranscriptEvent): TranscriptEvent {
  const input = inputObject(start.detail)
  const name = start.name ?? result.name ?? 'Tool'
  let summary = start.summary
  let detail: string | undefined

  if (name === 'WebFetch' || name === 'web_fetch') {
    const url = typeof input?.url === 'string'
      ? input.url
      : firstUrl(start.summary, start.detail, result.summary)
    const prompt = typeof input?.prompt === 'string' ? input.prompt : undefined
    summary = name === 'WebFetch'
      ? `Fetch(url: ${JSON.stringify(url ?? '')}${prompt ? `, prompt: ${JSON.stringify(prompt)}` : ''})`
      : `Fetch(${url ?? start.summary.replace(/^.*?抓取\s*/, '')})`
    const resultSummary = normalizedWebResultSummary(result)
    // Remote WebFetch already returns Claude's extracted answer, not the raw page.
    // Verbose Claude Code keeps that useful result under the receipt line.
    detail = name === 'WebFetch' && result.detail?.trim()
      ? `${resultSummary}\n${result.detail.trim()}`
      : resultSummary
  } else if (name === 'WebSearch') {
    const query = typeof input?.query === 'string'
      ? input.query
      : start.summary.replace(/^.*?(?:搜索|Web Search)\s*/i, '')
    summary = `Web Search(${JSON.stringify(query)})`
    detail = /^(?:Did \d+ search(?:es)?|Error:|Search failed)/i.test(result.summary)
      ? result.summary
      : result.phase === 'failure' ? 'Search failed' : 'Did 1 search'
  } else {
    detail = result.summary === start.summary ? undefined : result.summary
  }

  return {
    ...start,
    phase: result.phase,
    summary,
    detail,
  }
}

/** Claude-style compact projection. Raw payloads remain untouched in `events`. */
export function compactTranscriptEvents(events: TranscriptEvent[]): TranscriptEvent[] {
  const projected: TranscriptEvent[] = []
  const starts = new Map<string, number>()
  const startEvents = new Map<string, TranscriptEvent>()

  for (const event of events) {
    if (event.kind === 'tool' && event.callId) {
      if (event.phase === 'start') {
        starts.set(event.callId, projected.length)
        startEvents.set(event.callId, event)
        projected.push({ ...event, detail: undefined })
        continue
      }
      const index = starts.get(event.callId)
      if (index !== undefined) {
        projected[index] = compactToolPair(startEvents.get(event.callId) ?? projected[index], event)
        continue
      }
      projected.push({ ...event, detail: undefined })
      continue
    }

    if (event.kind === 'thinking') {
      const cleaned = cleanTranscriptText(event.summary).trim()
      projected.push({
        ...event,
        summary: cleaned.length > 500 ? `${cleaned.slice(0, 499)}…` : cleaned,
        detail: undefined,
      })
      continue
    }

    projected.push({
      ...event,
      detail: event.kind === 'system' && event.phase === 'failure' ? event.detail : undefined,
    })
  }

  return projected
}

/**
 * Project the immutable event ledger into a complete scrollable transcript.
 * No event or payload is truncated here; viewport selection happens afterwards.
 */
export function transcriptLines(
  events: TranscriptEvent[],
  columns: number,
  options: { showRaw?: boolean } = {},
): TranscriptLine[] {
  const width = Math.max(20, columns - 2)
  const out: TranscriptLine[] = []
  const displayedEvents = options.showRaw ? events : compactTranscriptEvents(events)
  for (const event of displayedEvents) {
    let prefix = ''
    let tone: TranscriptLine['tone'] = 'dim'
    let accent: TranscriptLine['accent']
    if (event.kind === 'user') {
      prefix = '› '
      tone = 'user'
    } else if (event.kind === 'assistant_text') {
      prefix = '● '
      tone = 'normal'
    } else if (event.kind === 'thinking') {
      prefix = '∴ Thinking: '
      tone = 'thinking'
    } else if (event.kind === 'milestone') {
      prefix = '● '
      tone = 'normal'
    } else if (event.kind === 'system') {
      prefix = '◆ '
      tone = event.phase === 'failure' ? 'failure' : 'dim'
    } else {
      prefix = event.phase === 'failure' ? '✗ ' : event.phase === 'success' ? '● ' : '○ '
      tone = event.phase === 'success' || event.phase === 'failure' ? 'normal' : 'dim'
      accent = event.phase === 'failure' ? 'failure' : event.phase === 'success' ? 'success' : 'pending'
    }

    const summaryLines = cleanTranscriptText(event.summary).split('\n')
    summaryLines.forEach((line, index) => {
      const leader = index === 0 ? prefix : '  '
      wrapLine(leader + line, width).forEach((text, wrapped) => {
        out.push({
          key: `${event.id}-s-${index}-${wrapped}`,
          text,
          tone,
          ...(index === 0 && wrapped === 0 && accent ? { accent } : {}),
        })
      })
    })

    if (event.detail) {
      const detailTone: TranscriptLine['tone'] = event.phase === 'failure' ? 'failure' : 'dim'
      cleanTranscriptText(event.detail).split('\n').forEach((line, index) => {
        wrapLine(`  ${index === 0 ? '└ ' : '  '}${line}`, width).forEach((text, wrapped) => {
          out.push({ key: `${event.id}-d-${index}-${wrapped}`, text, tone: detailTone })
        })
      })
    }
    out.push({ key: `${event.id}-gap`, text: ' ', tone: 'dim' })
  }
  return out
}

export function transcriptViewport(
  lines: TranscriptLine[],
  height: number,
  offsetFromBottom: number,
): { visible: TranscriptLine[]; start: number; end: number; maxOffset: number } {
  const size = Math.max(1, height)
  const maxOffset = Math.max(0, lines.length - size)
  const offset = Math.min(Math.max(0, offsetFromBottom), maxOffset)
  const end = Math.max(0, lines.length - offset)
  const start = Math.max(0, end - size)
  return { visible: lines.slice(start, end), start, end, maxOffset }
}
