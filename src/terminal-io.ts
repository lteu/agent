import { EventEmitter } from 'node:events'
import { Transform } from 'node:stream'

const SGR_PREFIX = '\x1b[<'
const COMPLETE_SGR_MOUSE = /^\x1b\[<\d+;\d+;\d+[Mm]/
const PARTIAL_SGR_MOUSE = /^\x1b\[<\d*(?:;\d*){0,2}$/
const BRACKETED_PASTE_ENABLE = '\x1b[?2004h'
const BRACKETED_PASTE_DISABLE = '\x1b[?2004l'
const INK_START_LINE = '\r\x1b[2K'
const BACKGROUND_QUERY = '\x1b]11;?\x07'
const BACKGROUND_RESPONSE = /\x1b\]11;rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})(?:\x07|\x1b\\)/i
const INK_EXIT_SCREEN = '\r\x1b[2J\x1b[H'
// Ink only consults stdout.rows to decide whether it should abandon its normal
// append/erase renderer and clear the whole terminal. The main UI deliberately
// bounds its live footer, so that fallback is both unnecessary and harmful: CSI
// 2J starts a new visible page that some terminals do not join to existing
// scrollback while the user is viewing older output.
const INK_MAIN_BUFFER_ROWS = 1_000_000

export type TerminalColorScheme = 'dark' | 'light'

export type DecodedTerminalInput = {
  keyboard: string
  mouse: string[]
}

/**
 * Separates terminal mouse reports from keyboard input before Ink sees either.
 * Ink 5's key parser does not understand SGR mouse input and can otherwise treat
 * its leading ESC as Escape, insert the remaining bytes, or swallow the next key.
 */
export class TerminalInputDecoder {
  private pending = ''

  feed(value: string, flush = false): DecodedTerminalInput {
    let source = this.pending + value
    this.pending = ''
    let keyboard = ''
    const mouse: string[] = []

    while (source.length > 0) {
      const start = source.indexOf(SGR_PREFIX)
      if (start < 0) {
        if (!flush) {
          const suffixLength = longestPrefixSuffix(source, SGR_PREFIX)
          if (suffixLength > 0) {
            this.pending = source.slice(-suffixLength)
            source = source.slice(0, -suffixLength)
          }
        }
        keyboard += source
        break
      }

      keyboard += source.slice(0, start)
      source = source.slice(start)
      const complete = source.match(COMPLETE_SGR_MOUSE)?.[0]
      if (complete) {
        mouse.push(complete)
        source = source.slice(complete.length)
        continue
      }

      if (!flush && PARTIAL_SGR_MOUSE.test(source)) {
        this.pending = source
        break
      }

      // Invalid lookalike: preserve it as keyboard input instead of dropping data.
      keyboard += source[0]
      source = source.slice(1)
    }

    return { keyboard, mouse }
  }

  flush(): DecodedTerminalInput {
    return this.feed('', true)
  }

  get hasPending(): boolean {
    return this.pending.length > 0
  }
}

function longestPrefixSuffix(value: string, prefix: string): number {
  for (let length = Math.min(value.length, prefix.length - 1); length > 0; length--) {
    if (value.endsWith(prefix.slice(0, length))) return length
  }
  return 0
}

/** Mouse reports removed from Ink's stdin are delivered here to the transcript UI. */
export const terminalMouseEvents = new EventEmitter()
export const terminalControlEvents = new EventEmitter()
let terminalRawModeLocked = false
let terminalAlternateScreenActive = false

export function setTerminalRawModeLock(locked: boolean): void {
  terminalRawModeLocked = locked
}

export function setTerminalAlternateScreenActive(active: boolean): void {
  terminalAlternateScreenActive = active
}

/** Ask the terminal to wrap each physical paste in CSI 200~/201~ markers. */
export function enableBracketedPasteMode(output: NodeJS.WriteStream): void {
  output.write(BRACKETED_PASTE_ENABLE)
}

/**
 * Put Ink's first frame at column one on a clean line. Some SSH PTYs leave the
 * cursor at the shell prompt's final column even though the command was submitted;
 * a full-width first frame then wraps and interleaves with the previous prompt.
 */
export function prepareTerminalForInk(output: NodeJS.WriteStream): void {
  output.write(INK_START_LINE)
}

/** Remove the visible TUI frame so the returning shell never overwrites it. */
export function clearTerminalAfterInk(output: NodeJS.WriteStream): void {
  output.write(INK_EXIT_SCREEN)
}

function componentBrightness(value: string): number {
  return Number.parseInt(value, 16) / (16 ** value.length - 1)
}

/** Parse the standard OSC 11 terminal-background response. */
export function parseTerminalBackground(value: string): TerminalColorScheme | undefined {
  const match = value.match(BACKGROUND_RESPONSE)
  if (!match) return undefined
  const red = componentBrightness(match[1])
  const green = componentBrightness(match[2])
  const blue = componentBrightness(match[3])
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue >= 0.6 ? 'light' : 'dark'
}

/** Detect a light terminal without relying on COLORFGBG being forwarded over SSH. */
export async function detectTerminalColorScheme(
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 180,
): Promise<TerminalColorScheme> {
  const override = env.AI_THEME?.toLowerCase()
  if (override === 'light' || override === 'dark') return override

  const colorFgBg = env.COLORFGBG?.split(';').at(-1)
  if (colorFgBg && /^\d+$/.test(colorFgBg)) {
    const background = Number(colorFgBg)
    return background === 7 || background >= 9 ? 'light' : 'dark'
  }
  if (!input.isTTY || !output.isTTY || env.TERM === 'dumb') return 'dark'

  return await new Promise(resolve => {
    let buffered = Buffer.alloc(0)
    let settled = false
    const finish = (scheme: TerminalColorScheme, response?: RegExpMatchArray) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      input.off('data', onData)
      input.pause()
      if (buffered.length) {
        if (response?.index != null) {
          const before = buffered.subarray(0, response.index)
          const after = buffered.subarray(response.index + response[0].length)
          buffered = Buffer.concat([before, after])
        }
        if (buffered.length) input.unshift(buffered)
      }
      resolve(scheme)
    }
    const onData = (chunk: Buffer | string) => {
      buffered = Buffer.concat([buffered, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)])
      const response = buffered.toString('latin1').match(BACKGROUND_RESPONSE)
      const scheme = response ? parseTerminalBackground(response[0]) : undefined
      if (scheme) finish(scheme, response ?? undefined)
    }
    const timer = setTimeout(() => finish('dark'), timeoutMs)
    input.on('data', onData)
    output.write(BACKGROUND_QUERY)
  })
}

export type TerminalSize = { columns: number; rows: number }

/** Keep malformed/transient TTY dimensions from reaching Yoga as Infinity/NaN. */
export function safeTerminalSize(columns: unknown, rows: unknown): TerminalSize {
  const finiteInteger = (value: unknown, fallback: number, minimum: number, maximum: number) => {
    const number = typeof value === 'number' ? value : Number.NaN
    return Number.isFinite(number) && number !== 0
      ? Math.min(maximum, Math.max(minimum, Math.floor(number)))
      : fallback
  }
  return {
    columns: finiteInteger(columns, 80, 20, 1000),
    rows: finiteInteger(rows, 24, 6, 500),
  }
}

/** Restore modes that can make mouse movement print escape reports into the shell. */
export function restoreTerminalModes(output: NodeJS.WriteStream): void {
  terminalRawModeLocked = false
  terminalAlternateScreenActive = false
  try {
    process.stdin.setRawMode?.(false)
  } catch {
    // stdin may already be closed during exception/signal cleanup.
  }
  try {
    output.write(
      BRACKETED_PASTE_DISABLE +
      '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1049l\x1b[?25h',
    )
  } catch {
    // Terminal restoration must never mask the original failure.
  }
}

class InkInputBridge extends Transform {
  private readonly decoder = new TerminalInputDecoder()
  private flushTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly source: NodeJS.ReadStream) {
    super()
  }

  override _transform(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    this.forward(this.decoder.feed(String(chunk)))
    // ESC / partial reports may be split across OS reads. Do not retain an ordinary
    // standalone Escape indefinitely; a tiny timeout keeps Escape responsive.
    if (this.decoder.hasPending) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null
        this.forward(this.decoder.flush())
      }, 8)
    }
    callback()
  }

  override _flush(callback: (error?: Error | null) => void) {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    this.forward(this.decoder.flush())
    callback()
  }

  private forward(decoded: DecodedTerminalInput) {
    if (decoded.keyboard) {
      for (const character of decoded.keyboard) {
        if (character === '\x0f') terminalControlEvents.emit('control', 'ctrl-o')
      }
      this.push(decoded.keyboard)
    }
    for (const report of decoded.mouse) terminalMouseEvents.emit('mouse', report)
  }

  get isTTY(): boolean {
    return Boolean(this.source.isTTY)
  }

  get fd(): number {
    return this.source.fd
  }

  setRawMode(mode: boolean) {
    if (!mode && terminalRawModeLocked) return this.source
    return this.source.setRawMode?.(mode)
  }

  ref() {
    this.source.ref?.()
    return this
  }

  unref() {
    this.source.unref?.()
    return this
  }
}

export function createInkInputBridge(
  source: NodeJS.ReadStream,
  options: { onEio?: (error: NodeJS.ErrnoException) => void } = {},
): {
  stdin: NodeJS.ReadStream
  dispose: () => void
} {
  const bridge = new InkInputBridge(source)
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    source.off('error', onSourceError)
    source.unpipe(bridge)
    bridge.end()
  }
  const onSourceError = (error: NodeJS.ErrnoException) => {
    if (error.code === 'EIO') {
      source.unpipe(bridge)
      bridge.end()
      options.onEio?.(error)
      return
    }
    // Preserve the existing crash-report path for unexpected stdin failures.
    queueMicrotask(() => { throw error })
  }
  source.on('error', onSourceError)
  source.pipe(bridge)
  return {
    stdin: bridge as unknown as NodeJS.ReadStream,
    dispose,
  }
}

/**
 * Ink clears both the visible screen and terminal scrollback when a frame reaches
 * the terminal height. Claude Code keeps scrollback intact during view changes.
 */
export function createScrollbackPreservingStdout(source: NodeJS.WriteStream): NodeJS.WriteStream {
  const write = (chunk: Uint8Array | string, ...args: unknown[]) => {
    const value = Buffer.isBuffer(chunk)
      ? Buffer.from(chunk.toString().replace(/\x1b\[3J/g, ''))
      : String(chunk).replace(/\x1b\[3J/g, '')
    return (source.write as (...values: unknown[]) => boolean).call(source, value, ...args)
  }

  return new Proxy(source, {
    get(target, property) {
      if (property === 'write') return write
      if (property === 'rows') {
        const physicalRows = safeTerminalSize(target.columns, target.rows).rows
        // Ink prepends its entire accumulated <Static> history behind CSI 2J/3J
        // whenever outputHeight >= stdout.rows. Stripping CSI 3J preserves old
        // scrollback but still leaves CSI 2J, which can detach the newly painted
        // live page from that history. Keep both main-buffer and alternate-screen
        // frames on Ink's incremental path instead.
        return terminalAlternateScreenActive
          ? physicalRows + 1
          : Math.max(INK_MAIN_BUFFER_ROWS, physicalRows + 1)
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
