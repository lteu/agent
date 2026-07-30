import assert from 'node:assert/strict'
import test from 'node:test'
import {
  expandPastedTextRefs,
  formatPastedTextRef,
  normalizePastedText,
  prunePastedTextRefs,
  shouldCollapsePaste,
} from '../src/pasted-text.js'

test('Claude Code 风格折叠多行粘贴并在发送前恢复全文', () => {
  const pasted = 'one\ntwo\nthree\nfour'
  assert.equal(shouldCollapsePaste(pasted), true)
  const ref = formatPastedTextRef(1, pasted)
  assert.equal(ref, '[Pasted text #1 +3 lines]')
  assert.equal(
    expandPastedTextRefs(`before ${ref} after`, new Map([[1, pasted]])),
    `before ${pasted} after`,
  )
})

test('短粘贴保持原样，长单行粘贴也会折叠', () => {
  assert.equal(shouldCollapsePaste('one\ntwo\nthree'), false)
  assert.equal(shouldCollapsePaste('x'.repeat(801)), true)
})

test('清理括号粘贴标记、CRLF 和 tab，并移除已删除占位符的内容', () => {
  const normalized = normalizePastedText('\x1b[200~a\r\n\tb\x1b[201~')
  assert.equal(normalized, 'a\n    b')
  const pasted = 'a\nb\nc\nd'
  assert.equal(prunePastedTextRefs('deleted', new Map([[1, pasted]])).size, 0)
})
