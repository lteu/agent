import assert from 'node:assert/strict'
import test from 'node:test'
import { PassThrough } from 'node:stream'
import React from 'react'
import { render } from 'ink'
import MultilineInput from '../src/MultilineInput.js'
import { PASTE_START_MARKER, PASTE_END_MARKER } from '../src/pasted-text.js'

// 模拟真实终端/远程中继的行为：ink 的 useInput 会把「以 ESC 开头」的 input 无条件
// 砍掉那一个前导 ESC（node_modules/ink/build/hooks/use-input.js），而一次物理粘贴的
// 起始块几乎总是独占一次 stdin 读取、天然以 ESC 打头。这里搭一个假 TTY stdin/stdout，
// 用真实的 render() 走一遍完整链路，而不是只测字符串处理函数，因为这个 bug 恰恰发生在
// ink 和我们代码的交界处，纯函数级别的单测测不出来。
function makeStdin() {
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream & { isTTY: boolean }
  stdin.isTTY = true
  ;(stdin as any).setRawMode = () => stdin
  ;(stdin as any).ref = () => stdin
  ;(stdin as any).unref = () => stdin
  return stdin
}

function makeStdout() {
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream & { columns: number }
  stdout.columns = 80
  ;(stdout as any).rows = 24
  let frame = ''
  stdout.write = ((chunk: any) => {
    frame += chunk.toString()
    return true
  }) as any
  return { stdout, getFrame: () => frame }
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

test('完整 bracketed paste 收尾后立即显示占位符，不等待兜底超时', async () => {
  const stdin = makeStdin()
  const { stdout, getFrame } = makeStdout()
  let submitted: string | null = null
  const app = render(
    React.createElement(MultilineInput, { onSubmit: (value: string) => { submitted = value } }),
    { stdin, stdout, exitOnCtrlC: false, patchConsole: false },
  )

  const pasted = Array.from({ length: 30 }, (_, i) => `line${i}`).join('\n')

  await wait(30)
  stdin.write(PASTE_START_MARKER + pasted + PASTE_END_MARKER)
  await wait(80)

  const placeholders = [...new Set(getFrame().match(/\[Pasted text #\d+(?: \+\d+ lines)?\]/g) ?? [])]
  assert.equal(placeholders.length, 1, `应立即出现一个粘贴占位符，实际: ${JSON.stringify(placeholders)}`)

  stdin.write('\r')
  await wait(80)
  app.unmount()

  assert.equal(submitted, pasted)
})

test('完成粘贴后紧跟的普通按键保持正确顺序', async () => {
  const stdin = makeStdin()
  const { stdout, getFrame } = makeStdout()
  let submitted: string | null = null
  const app = render(
    React.createElement(MultilineInput, { onSubmit: (value: string) => { submitted = value } }),
    { stdin, stdout, exitOnCtrlC: false, patchConsole: false },
  )

  const pasted = Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n')

  await wait(30)
  stdin.write(PASTE_START_MARKER + pasted + PASTE_END_MARKER)
  await wait(80)
  stdin.write('x')
  await wait(80)

  const placeholders = [...new Set(getFrame().match(/\[Pasted text #\d+(?: \+\d+ lines)?\]/g) ?? [])]
  assert.equal(placeholders.length, 1, `应当只出现一个粘贴占位符，实际: ${JSON.stringify(placeholders)}`)

  stdin.write('\r')
  await wait(80)
  app.unmount()

  assert.equal(submitted, pasted + 'x')
})

test('终端启用 bracketed paste 后，一个物理粘贴跨多个 stdin read 仍只提交一次完整内容', async () => {
  const stdin = makeStdin()
  const { stdout, getFrame } = makeStdout()
  let submitted: string | null = null
  const app = render(
    React.createElement(MultilineInput, { onSubmit: (value: string) => { submitted = value } }),
    { stdin, stdout, exitOnCtrlC: false, patchConsole: false },
  )

  const first = Array.from({ length: 20 }, (_, i) => `first${i}`).join('\n')
  const middle = Array.from({ length: 20 }, (_, i) => `middle${i}`).join('\n')
  const last = Array.from({ length: 20 }, (_, i) => `last${i}`).join('\n')

  await wait(30)
  // A real terminal emits one marker pair for the physical paste, while the OS may
  // split the enclosed payload across any number of reads.
  stdin.write(PASTE_START_MARKER + first)
  await wait(80)
  assert.match(getFrame(), /Pasting…/, '等待后续粘贴分片时应显示进度提示')
  stdin.write(middle)
  await wait(30)
  stdin.write(last + PASTE_END_MARKER)
  await wait(30)
  stdin.write('\r')
  await wait(80)
  app.unmount()

  assert.equal(submitted, first + middle + last)
})
