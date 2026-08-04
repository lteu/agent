import { EventEmitter } from 'node:events'
import { Transform } from 'node:stream'

const SGR_PREFIX = '\x1b[<'
const COMPLETE_SGR_MOUSE = /^\x1b\[<\d+;\d+;\d+[Mm]/
const PARTIAL_SGR_MOUSE = /^\x1b\[<\d*(?:;\d*){0,2}$/

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
    output.write('\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1049l\x1b[?25h')
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
      // Ink prepends its entire accumulated <Static> history whenever
      // outputHeight >= stdout.rows. In alt mode the frame is deliberately one
      // row shorter than the viewport; report a safe viewport even for PTYs that
      // expose rows=0 so that stale main-screen history is never replayed.
      if (property === 'rows' && terminalAlternateScreenActive) {
        return safeTerminalSize(target.columns, target.rows).rows + 1
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
