import assert from 'node:assert/strict'
import test from 'node:test'
import {
  anchoredTranscriptOffset,
  cleanTranscriptText,
  isKeyTool,
  isPrimaryMousePress,
  parseSgrMouseEvents,
  stripSgrMouseSequences,
  transcriptLines,
  transcriptViewport,
  type TranscriptEvent,
} from '../src/ui-transcript.js'

test('raw 转录不截断工具输出', () => {
  const detail = Array.from({ length: 30 }, (_, i) => `line-${i}`).join('\n')
  const events: TranscriptEvent[] = [{
    id: 1,
    turnId: 1,
    at: 1,
    kind: 'tool',
    phase: 'success',
    name: 'run_bash',
    summary: 'ran tests',
    detail,
  }]
  const lines = transcriptLines(events, 120, { showRaw: true })
  assert.ok(lines.some(line => line.text.includes('line-0')))
  assert.ok(lines.some(line => line.text.includes('line-29')))
})

test('展开转录显示 WebFetch 的 url、prompt、响应摘要和提取结果', () => {
  const extracted = 'The requested fact is **Fluffy**, quoted from two critics.'
  const events: TranscriptEvent[] = [
    {
      id: 1,
      turnId: 1,
      at: 1,
      kind: 'tool',
      phase: 'start',
      name: 'WebFetch',
      callId: 'fetch-1',
      summary: '抓取 https://example.com/page',
      detail: JSON.stringify({
        url: 'https://example.com/page',
        prompt: 'Find the exact quoted word',
      }),
    },
    {
      id: 2,
      turnId: 1,
      at: 2,
      kind: 'tool',
      phase: 'success',
      name: 'WebFetch',
      callId: 'fetch-1',
      summary: 'Received 55.7 KB (200 OK)',
      detail: extracted,
    },
  ]
  const compact = transcriptLines(events, 120)
  assert.ok(compact.some(line => line.text.includes(
    'Fetch(url: "https://example.com/page", prompt: "Find the exact quoted word")',
  )))
  assert.ok(compact.some(line => line.text.includes('Received 55.7KB (200 OK)')))
  assert.ok(compact.some(line => line.text.includes('The requested fact is **Fluffy**')))
  const title = compact.find(line => line.text.startsWith('● Fetch'))
  assert.equal(title?.tone, 'normal')
  assert.equal(title?.accent, 'success')
  assert.ok(transcriptLines(events, 120, { showRaw: true }).some(line => line.text.includes(extracted)))
})

test('默认转录把 WebSearch 投影成 Claude 风格的单张摘要卡', () => {
  const events: TranscriptEvent[] = [
    {
      id: 1,
      turnId: 1,
      at: 1,
      kind: 'tool',
      phase: 'start',
      name: 'WebSearch',
      callId: 'search-1',
      summary: '搜索 terminal UI',
      detail: JSON.stringify({ query: 'terminal UI' }),
    },
    {
      id: 2,
      turnId: 1,
      at: 2,
      kind: 'tool',
      phase: 'success',
      name: 'WebSearch',
      callId: 'search-1',
      summary: 'Did 1 search in 5s',
      detail: 'result title\nhttps://example.com\nlarge search payload',
    },
  ]
  const compact = transcriptLines(events, 120)
  assert.ok(compact.some(line => line.text.includes('Web Search("terminal UI")')))
  assert.ok(compact.some(line => line.text.includes('Did 1 search')))
  assert.ok(compact.some(line => line.text.includes('Did 1 search in 5s')))
  assert.equal(compact.some(line => line.text.includes('large search payload')), false)
})

test('viewport 从底部滚动且不修改源数据', () => {
  const lines = Array.from({ length: 20 }, (_, i) => ({
    key: String(i),
    text: String(i),
    tone: 'dim' as const,
  }))
  assert.deepEqual(transcriptViewport(lines, 5, 0).visible.map(line => line.text), ['15', '16', '17', '18', '19'])
  assert.deepEqual(transcriptViewport(lines, 5, 3).visible.map(line => line.text), ['12', '13', '14', '15', '16'])
  assert.equal(lines.length, 20)
})

test('滚离底部后新增内容保持当前历史位置，底部跟随模式不变', () => {
  assert.equal(anchoredTranscriptOffset(5, 20, 23), 8)
  assert.equal(anchoredTranscriptOffset(0, 20, 23), 0)
  assert.equal(anchoredTranscriptOffset(5, 23, 20), 5)
})

test('转录清除工具输出中的 ANSI、光标控制和其他不可见控制字节', () => {
  assert.equal(
    cleanTranscriptText('\x1b[31mred\x1b[0m\rnext\tvalue\x00\x07'),
    'red\nnext  value',
  )
})

test('关键工具不会被默认活动计数吞掉', () => {
  assert.equal(isKeyTool('write_file'), true)
  assert.equal(isKeyTool('WebFetch'), true)
  assert.equal(isKeyTool('browser_click'), true)
  assert.equal(isKeyTool('read_file'), false)
})

test('SGR 鼠标主键点击可识别，释放和滚轮不会误判', () => {
  assert.equal(isPrimaryMousePress('\x1b[<0;12;8M'), true)
  assert.equal(isPrimaryMousePress('\x1b[<0;12;8m'), false)
  assert.equal(isPrimaryMousePress('\x1b[<64;12;8M'), false)
  assert.equal(isPrimaryMousePress('plain input'), false)
})

test('SGR 触控板滚轮可完整解析，兼容 Ink 去掉 ESC 的形式', () => {
  assert.deepEqual(
    parseSgrMouseEvents('\x1b[<64;84;11M[<65;84;10M').map(event => event.kind),
    ['wheel-up', 'wheel-down'],
  )
  assert.equal(isPrimaryMousePress('[<0;12;8M'), true)
})

test('鼠标控制序列不会泄漏进文本输入', () => {
  assert.equal(stripSgrMouseSequences('\x1b[<64;84;11M'), '')
  assert.equal(stripSgrMouseSequences('[<65;84;10M'), '')
  assert.equal(stripSgrMouseSequences('a\x1b[<64;84;11Mb'), 'ab')
})
