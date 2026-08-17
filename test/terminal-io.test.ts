import assert from 'node:assert/strict'
import test from 'node:test'
import { PassThrough } from 'node:stream'
import {
  clearTerminalAfterInk,
  createInkInputBridge,
  createScrollbackPreservingStdout,
  detectTerminalColorScheme,
  enableBracketedPasteMode,
  parseTerminalBackground,
  prepareTerminalForInk,
  restoreTerminalModes,
  safeTerminalSize,
  TerminalInputDecoder,
} from '../src/terminal-io.js'

test('stdin EIO 由输入桥接器接管，不会变成未捕获异常', () => {
  const source = new PassThrough() as unknown as NodeJS.ReadStream
  let received: NodeJS.ErrnoException | undefined
  const bridge = createInkInputBridge(source, { onEio: error => { received = error } })
  const error = Object.assign(new Error('read EIO'), { code: 'EIO' })
  source.emit('error', error)
  assert.equal(received, error)
  bridge.dispose()
})

test('终端输入分流保留普通键并移除完整鼠标报告', () => {
  const decoder = new TerminalInputDecoder()
  assert.deepEqual(decoder.feed('a\x1b[<64;20;9Mb'), {
    keyboard: 'ab',
    mouse: ['\x1b[<64;20;9M'],
  })
})

test('终端输入分流支持跨 chunk 的鼠标报告', () => {
  const decoder = new TerminalInputDecoder()
  assert.deepEqual(decoder.feed('x\x1b['), { keyboard: 'x', mouse: [] })
  assert.deepEqual(decoder.feed('<64;20'), { keyboard: '', mouse: [] })
  assert.deepEqual(decoder.feed(';9My'), {
    keyboard: 'y',
    mouse: ['\x1b[<64;20;9M'],
  })
})

test('终端输入分流不会丢弃不完整的普通 Escape 输入', () => {
  const decoder = new TerminalInputDecoder()
  assert.deepEqual(decoder.feed('\x1b'), { keyboard: '', mouse: [] })
  assert.deepEqual(decoder.flush(), { keyboard: '\x1b', mouse: [] })
})

test('同一 chunk 中多个鼠标事件不会吞掉紧随其后的快捷键', () => {
  const decoder = new TerminalInputDecoder()
  assert.deepEqual(decoder.feed('\x1b[<64;1;2M\x1b[<65;1;2M\x0f'), {
    keyboard: '\x0f',
    mouse: ['\x1b[<64;1;2M', '\x1b[<65;1;2M'],
  })
})

test('异常或瞬态终端尺寸不会把 Infinity/NaN 传给 Ink Yoga', () => {
  assert.deepEqual(safeTerminalSize(Number.POSITIVE_INFINITY, Number.NaN), {
    columns: 80,
    rows: 24,
  })
  assert.deepEqual(safeTerminalSize(0, 0), {
    columns: 80,
    rows: 24,
  })
  assert.deepEqual(safeTerminalSize(4000, -1), {
    columns: 1000,
    rows: 6,
  })
  assert.deepEqual(safeTerminalSize(137.9, 40.8), {
    columns: 137,
    rows: 40,
  })
})

test('异常退出恢复所有鼠标追踪模式和光标', () => {
  let output = ''
  restoreTerminalModes({
    write(value: string) {
      output += value
      return true
    },
  } as unknown as NodeJS.WriteStream)
  assert.equal(
    output,
    '\x1b[?2004l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1049l\x1b[?25h',
  )
})

test('交互界面显式请求终端发送 bracketed-paste 边界', () => {
  let output = ''
  enableBracketedPasteMode({
    write(value: string) {
      output += value
      return true
    },
  } as unknown as NodeJS.WriteStream)
  assert.equal(output, '\x1b[?2004h')
})

test('Ink 首帧绘制前回到行首并清理当前行', () => {
  let output = ''
  prepareTerminalForInk({
    write(value: string) {
      output += value
      return true
    },
  } as unknown as NodeJS.WriteStream)
  assert.equal(output, '\r\x1b[2K')
})

test('Ink 正常退出后清理可见帧并将 shell 放回左上角', () => {
  let output = ''
  clearTerminalAfterInk({
    write(value: string) {
      output += value
      return true
    },
  } as unknown as NodeJS.WriteStream)
  assert.equal(output, '\r\x1b[2J\x1b[H')
})

test('普通界面阻止 Ink 用整屏清除切断原生 scrollback', () => {
  let output = ''
  const source = {
    columns: 120,
    rows: 40,
    write(value: string | Buffer) {
      output += value.toString()
      return true
    },
  } as unknown as NodeJS.WriteStream
  const wrapped = createScrollbackPreservingStdout(source)

  // Ink 以这个 rows 值决定是否发送 clearTerminal。它不参与 Yoga 的宽度
  // 计算，因此可安全地把主缓冲区固定在增量渲染路径上。
  assert.ok((wrapped.rows ?? 0) > 40)
  wrapped.write('\x1b[2J\x1b[3J\x1b[Hnew frame')

  // 即使第三方代码真的发出 clearTerminal，适配层仍至少不能删除 scrollback。
  assert.equal(output, '\x1b[2J\x1b[Hnew frame')
})

test('终端背景响应可区分浅色和深色', () => {
  assert.equal(parseTerminalBackground('\x1b]11;rgb:ffff/ffff/ffff\x1b\\'), 'light')
  assert.equal(parseTerminalBackground('\x1b]11;rgb:1111/1818/2020\x07'), 'dark')
  assert.equal(parseTerminalBackground('not an OSC response'), undefined)
})

test('没有 COLORFGBG 时通过 OSC 11 自动检测浅色终端', async () => {
  const input = Object.assign(new PassThrough(), { isTTY: true }) as unknown as NodeJS.ReadStream
  let query = ''
  const output = {
    isTTY: true,
    write(value: string) {
      query += value
      queueMicrotask(() => (input as unknown as PassThrough).write('\x1b]11;rgb:ffff/ffff/ffff\x07'))
      return true
    },
  } as unknown as NodeJS.WriteStream

  assert.equal(await detectTerminalColorScheme(input, output, { TERM: 'xterm-256color' }, 50), 'light')
  assert.equal(query, '\x1b]11;?\x07')
})
