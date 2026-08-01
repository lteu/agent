import assert from 'node:assert/strict'
import test from 'node:test'
import {
  restoreTerminalModes,
  safeTerminalSize,
  TerminalInputDecoder,
} from '../src/terminal-io.js'

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
  assert.equal(output, '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1049l\x1b[?25h')
})
