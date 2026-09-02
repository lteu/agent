import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runTool, type ToolContext } from '../src/tools.js'
import { buildFileDiffCard, syntaxSegments, truncateDiffLine } from '../src/ui-diff.js'
import {
  anchoredTranscriptOffset,
  BufferedTranscriptLedger,
  cleanTranscriptText,
  isKeyTool,
  isPrimaryMousePress,
  parseSgrMouseEvents,
  stripSgrMouseSequences,
  transcriptLines,
  transcriptViewport,
  type TranscriptEvent,
} from '../src/ui-transcript.js'

test('高频流式片段在 ledger 中合并，不产生逐 token 事件数组', () => {
  const ledger = new BufferedTranscriptLedger()
  for (let index = 0; index < 10_000; index++) {
    ledger.appendDelta(1, 'thinking', `${index},`)
  }
  const expectedThinking = Array.from({ length: 10_000 }, (_, index) => `${index},`).join('')
  assert.deepEqual(ledger.snapshot().map(event => [event.kind, event.summary]), [
    ['thinking', expectedThinking],
  ])

  for (let index = 0; index < 2_000; index++) ledger.appendDelta(1, 'assistant_text', 'x')
  ledger.append({ turnId: 1, at: 2, kind: 'system', summary: 'done' })
  const events = ledger.snapshot()
  assert.equal(events.length, 3)
  assert.equal(events[1].summary, 'x'.repeat(2_000))
  assert.equal(events[2].summary, 'done')
})

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

test('展开转录保留浏览器跳转后的完整 URL 和页面快照', () => {
  const fullUrl = 'https://login.example.net/login?service=oauth&state=full-value'
  const events: TranscriptEvent[] = [
    {
      id: 1,
      turnId: 1,
      at: 1,
      kind: 'tool',
      phase: 'start',
      name: 'browser_goto',
      callId: 'browser-1',
      summary: '浏览器 auth 跳转 login.example.net/login',
      detail: JSON.stringify({ name: 'auth', url: fullUrl }),
    },
    {
      id: 2,
      turnId: 1,
      at: 2,
      kind: 'tool',
      phase: 'success',
      name: 'browser_goto',
      callId: 'browser-1',
      summary: '✓ 浏览器 auth 跳转 login.example.net/login',
      detail: `标题: Login\n地址: ${fullUrl}\n\ne1 button "Continue"`,
    },
  ]
  const expanded = transcriptLines(events, 120)
  assert.ok(expanded.some(line => line.text.includes('state=full-value')))
  assert.ok(expanded.some(line => line.text.includes('e1 button "Continue"')))
})

test('shell 展开转录保留完整命令和原始错误', () => {
  const events: TranscriptEvent[] = [
    {
      id: 1,
      turnId: 1,
      at: 1,
      kind: 'tool',
      phase: 'start',
      name: 'run_bash',
      callId: 'shell-1',
      summary: '统计引用数',
      detail: JSON.stringify({
        intent: '统计引用数',
        command: '/usr/bin/python3 /tmp/dcpv2_cli.py --params "very long value"',
      }),
    },
    {
      id: 2,
      turnId: 1,
      at: 2,
      kind: 'tool',
      phase: 'failure',
      name: 'run_bash',
      callId: 'shell-1',
      summary: '✗ 统计引用数 · 命令退出码 1',
      detail: '命令退出码 1\nTraceback\nJSONDecodeError: Expecting value',
    },
  ]
  const expanded = transcriptLines(events, 120)
  assert.ok(expanded.some(line => line.text.includes('/usr/bin/python3 /tmp/dcpv2_cli.py')))
  assert.ok(expanded.some(line => line.text.includes('JSONDecodeError: Expecting value')))
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

test('文件更新生成带上下文和准确行号的多个 diff hunk', () => {
  const before = [
    'first',
    'keep 2',
    'old 3',
    'keep 4',
    'keep 5',
    'keep 6',
    'keep 7',
    'keep 8',
    'keep 9',
    'keep 10',
    'old 11',
    'last',
  ].join('\n')
  const after = before.replace('old 3', 'new 3\nadded 4').replace('old 11', 'new 12')
  const card = buildFileDiffCard({
    path: '/workspace/src/example.ts',
    before,
    after,
    created: false,
  }, '/workspace')

  assert.equal(card.operation, 'Update')
  assert.equal(card.displayPath, 'src/example.ts')
  assert.equal(card.additions, 3)
  assert.equal(card.removals, 2)
  assert.equal(card.hunks.length, 2)
  assert.deepEqual(
    card.hunks[0].lines.filter(line => line.kind !== 'context').map(line => [line.kind, line.oldLine, line.newLine]),
    [
      ['remove', 3, undefined],
      ['add', undefined, 3],
      ['add', undefined, 4],
    ],
  )
  assert.deepEqual(
    card.hunks[1].lines.filter(line => line.kind !== 'context').map(line => [line.kind, line.oldLine, line.newLine]),
    [
      ['remove', 11, undefined],
      ['add', undefined, 12],
    ],
  )
})

test('新文件显示为 Create，所有内容都是新增行', () => {
  const card = buildFileDiffCard({
    path: '/workspace/new.sql',
    before: '',
    after: "SELECT 1\nWHERE name = 'demo'\n",
    created: true,
  }, '/workspace')
  assert.equal(card.operation, 'Create')
  assert.equal(card.additions, 2)
  assert.equal(card.removals, 0)
  assert.deepEqual(card.hunks[0].lines.map(line => line.newLine), [1, 2])
})

test('SQL 风格 diff 行识别关键字、数字、字符串和注释', () => {
  assert.deepEqual(
    syntaxSegments("WHEN price = 198 THEN '实验组' -- label").map(segment => segment.kind),
    ['keyword', 'plain', 'number', 'plain', 'keyword', 'plain', 'string', 'plain', 'comment'],
  )
})

test('diff 行按终端显示宽度截断中文', () => {
  const clipped = truncateDiffLine('中文'.repeat(20), 12)
  assert.equal(clipped.endsWith('…'), true)
  assert.ok(clipped.length < 40)
})

test('文件工具在同一个修改锁内返回真实 before/after 快照', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-diff-test-'))
  const path = join(directory, 'sample.txt')
  const context: ToolContext = {
    apiKey: '',
    model: '',
    baseURL: '',
    readSnapshots: new Map(),
    fileMutationLocks: new Map(),
  }
  try {
    const created = await runTool('write_file', { path, content: 'alpha\nbeta\n' }, context)
    assert.deepEqual(created.fileDiff, {
      path,
      before: '',
      after: 'alpha\nbeta\n',
      created: true,
    })

    await runTool('read_file', { path }, context)
    const edited = await runTool('edit_file', {
      path,
      old_string: 'beta',
      new_string: 'gamma',
    }, context)
    assert.equal(edited.ok, true)
    assert.deepEqual(edited.fileDiff, {
      path,
      before: 'alpha\nbeta\n',
      after: 'alpha\ngamma\n',
      created: false,
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
