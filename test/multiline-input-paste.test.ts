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

test('一次物理粘贴被拆成多个各自完整的 bracketed-paste 序列、粘贴完直接回车发送，内容完整还原不丢失也不夹带标记', async () => {
  const stdin = makeStdin()
  const { stdout } = makeStdout()
  let submitted: string | null = null
  const app = render(
    React.createElement(MultilineInput, { onSubmit: (value: string) => { submitted = value } }),
    { stdin, stdout, exitOnCtrlC: false, patchConsole: false },
  )

  const chunkA = Array.from({ length: 12 }, (_, i) => `lineA${i}`).join('\n')
  const chunkB = Array.from({ length: 12 }, (_, i) => `lineB${i}`).join('\n')
  const chunkC = Array.from({ length: 6 }, (_, i) => `lineC${i}`).join('\n')

  await wait(30)
  // 三次各自独立、各自完整的 bracketed-paste 序列，模拟远程中继把一次粘贴按网络包切开
  // （这正是截图里 [Pasted text #21]...[Pasted text #30] 复现出来的场景）。
  stdin.write(PASTE_START_MARKER + chunkA + PASTE_END_MARKER)
  await wait(80)
  stdin.write(PASTE_START_MARKER + chunkB + PASTE_END_MARKER)
  await wait(80)
  stdin.write(PASTE_START_MARKER + chunkC + PASTE_END_MARKER)
  await wait(80)
  // 粘贴完直接回车发送，是最常见的实际操作：发送前会先 flush 挂起的粘贴合并，
  // 保证 onSubmit 拿到的是合并后的完整内容，而不是三段夹着 \x1b[200~/[201~ 标记的碎片。
  stdin.write('\r')
  await wait(80)
  app.unmount()

  assert.equal(submitted, chunkA + chunkB + chunkC)
})

test('粘贴分片合并后，紧跟的普通按键也会正确触发落地（不必等到静默超时）', async () => {
  const stdin = makeStdin()
  const { stdout, getFrame } = makeStdout()
  let submitted: string | null = null
  const app = render(
    React.createElement(MultilineInput, { onSubmit: (value: string) => { submitted = value } }),
    { stdin, stdout, exitOnCtrlC: false, patchConsole: false },
  )

  const chunkA = Array.from({ length: 5 }, (_, i) => `a${i}`).join('\n')
  const chunkB = Array.from({ length: 5 }, (_, i) => `b${i}`).join('\n')

  await wait(30)
  stdin.write(PASTE_START_MARKER + chunkA + PASTE_END_MARKER)
  await wait(80)
  stdin.write(PASTE_START_MARKER + chunkB + PASTE_END_MARKER)
  await wait(80)
  // 粘贴后接着打字（而不是立刻回车），同样应该把挂起的分片合并成一个占位符。
  stdin.write('x')
  await wait(80)

  const placeholders = [...new Set(getFrame().match(/\[Pasted text #\d+(?: \+\d+ lines)?\]/g) ?? [])]
  assert.equal(placeholders.length, 1, `应当只出现一个粘贴占位符，实际: ${JSON.stringify(placeholders)}`)

  stdin.write('\r')
  await wait(80)
  app.unmount()

  assert.equal(submitted, chunkA + chunkB + 'x')
})
