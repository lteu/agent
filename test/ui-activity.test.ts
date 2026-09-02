import assert from 'node:assert/strict'
import test from 'node:test'
import {
  EMPTY_ACTIVITY_COUNTS,
  activeToolPresentation,
  addActivity,
  clampRows,
  compactToolResultRows,
  conciseBrowserToolCard,
  conciseShellFailure,
  conciseToolCardResult,
  conciseWebFetchResult,
  formatActivity,
  formatUserPrompt,
  parseAgentCardItem,
  planLiveFooter,
  recoverableToolFailure,
  tailByRows,
  terminalWidth,
} from '../src/ui-activity.js'

test('浏览器跳转结果默认只显示页面语义，不重复完整 URL', () => {
  const card = conciseBrowserToolCard(
    'browser_goto',
    [
      '标题: 奇富科技｜统一认证中心',
      '地址: https://login.example.net/login?service=https%3A%2F%2Fmcphub.example.net%2Foauth',
      '',
      '(当前页面没有可交互元素)',
    ].join('\n'),
  )
  assert.deepEqual(card, {
    result: '已跳转到 奇富科技｜统一认证中心',
    preview: '(当前页面没有可交互元素)',
    finalUrl: 'https://login.example.net/login?service=https%3A%2F%2Fmcphub.example.net%2Foauth',
  })
  assert.equal(card?.result.includes('https://'), false)
  assert.equal(card?.preview?.includes('地址:'), false)
})

test('工具结果按终端视觉宽度折叠为最多三行', () => {
  const compact = compactToolResultRows(
    'Completed',
    `地址: https://example.com/${'very-long-path/'.repeat(12)}\nline 2\nline 3`,
    50,
  )
  assert.equal(compact.text.split('\n').length, 3)
  assert.ok(compact.hiddenRows > 0)
  assert.match(compact.text, /Ctrl\+O to expand/)
})

test('普通本地工具聚合为 Claude Code 风格活动摘要', () => {
  let counts = { ...EMPTY_ACTIVITY_COUNTS }
  counts = addActivity(counts, 'read_file')
  counts = addActivity(counts, 'list_dir')
  counts = addActivity(counts, 'list_dir')
  counts = addActivity(counts, 'run_bash')
  counts = addActivity(counts, 'WebSearch')
  counts = addActivity(counts, 'run_agent')

  assert.equal(
    formatActivity(counts, true),
    'Reading 1 file, listing 2 directories, running 1 shell command…',
  )
  assert.equal(
    formatActivity(counts, false),
    'Read 1 file, listed 2 directories, ran 1 shell command',
  )
})

test('用户问题渲染为铺满终端宽度的灰色块', () => {
  const block = formatUserPrompt('hello', 20)
  assert.equal(block, '  › hello         ')
  assert.equal(block.length, 18)
})

test('子 agent 结果转换为树状卡片数据', () => {
  assert.deepEqual(
    parseAgentCardItem(
      '启动子 agent：Answer GAIA tasks 1–4',
      JSON.stringify({ status: 'completed', tool_uses: 7 }),
    ),
    {
      title: 'Answer GAIA tasks 1–4',
      status: 'Done',
      toolUses: 7,
      failed: false,
    },
  )
})

test('进行中的 shell 只显示一次状态和实际命令', () => {
  assert.deepEqual(
    activeToolPresentation(
      'run_bash',
      '下载报告 · [tmp] `curl -sL -o report.pdf …`',
      'curl -sL -o report.pdf https://example.com/report.pdf',
    ),
    {
      label: 'Running 1 shell command…',
      detail: '$ curl -sL -o report.pdf https://example.com/report.pdf',
    },
  )
})

test('多行 heredoc 命令在动态区只占一行', () => {
  const heredoc = [
    "cd /data/oceanus_ctr/j-liutong3-jk && /data/oceanus_ctr/j-liutong3-jk/.conda/envs/py37/bin/python - <<'PY'",
    'import pyarrow.orc as paorc',
    'import pandas as pd, numpy as np',
    'print("ORC files: %d" % len(files))',
    'PY',
  ].join('\n')
  const presentation = activeToolPresentation('run_bash', '跑训练脚本', heredoc, 80)
  assert.equal(presentation.label, 'Running 1 shell command…')
  // 一行、且不超过终端宽度：Ink 的擦除靠上一帧的行数，动态区一旦比屏幕高就会每帧追加。
  assert.equal(presentation.detail?.includes('\n'), false)
  assert.ok(terminalWidth(presentation.detail!) <= 74)
  assert.ok(presentation.detail!.endsWith('…'))
})

test('中文命令按显示宽度截断，不按字符数', () => {
  const detail = activeToolPresentation('run_bash', '统计', '回显'.repeat(60), 40).detail!
  assert.ok(terminalWidth(detail) <= 34)
})

const footerRows = (plan: ReturnType<typeof planLiveFooter>, hasError: boolean, hasBtw: boolean) =>
  (hasBtw ? 5 : 9) +
  plan.tools * 2 +
  (plan.btw > 0 ? plan.btw + 6 : 0) +
  (plan.queued > 0 ? plan.queued + 1 : 0) +
  plan.stream + 1 +
  (hasError ? 3 : 0)

test('动态区整体放得进终端，且不随内容多少增长', () => {
  for (const rows of [20, 24, 40, 120, 500]) {
    for (const hasError of [false, true]) {
      for (const hasBtw of [false, true]) {
        const shape = { rows, hasError, hasBtw }
        const plan = planLiveFooter({ ...shape, tools: 5, queued: 9 })
        const label = `rows=${rows} error=${hasError} btw=${hasBtw}`
        // 关键不变量：动态区每秒重画多次，一旦比终端高，Ink 的擦除就会失效并
        // 把整块内容重复追加到屏幕上（issue.png）。
        assert.ok(footerRows(plan, hasError, hasBtw) <= rows, `${label} 超出终端高度`)
        // 内容再多也不能撑高动态区。
        assert.deepEqual(planLiveFooter({ ...shape, tools: 500, queued: 900 }), plan, label)
      }
    }
  }
})

test('终端极小时预算退化为最小值而不是负数', () => {
  for (const rows of [6, 8, 12]) {
    const plan = planLiveFooter({ rows, tools: 9, queued: 9, hasError: true, hasBtw: false })
    assert.deepEqual(plan, { tools: 0, stream: 1, queued: 0, btw: 0 })
  }
})

test('终端很矮时优先保留正在跑的工具，而不是流式预览', () => {
  const plan = planLiveFooter({ rows: 14, tools: 3, queued: 0, hasError: false, hasBtw: false })
  assert.ok(plan.tools >= 1)
  assert.ok(plan.stream >= 1)
})

const wrappedRows = (text: string, columns: number) =>
  text.split('\n').reduce((rows, line) => rows + Math.max(1, Math.ceil(terminalWidth(line) / columns)), 0)

test('流式尾巴按显示宽度限高，中文段落不会撑爆动态区', () => {
  const paragraph = '模型有时会很久不吐换行，'.repeat(40)
  const tail = tailByRows(paragraph, 4, 60)
  assert.ok(wrappedRows(tail.shown, 60) <= 4)
  assert.equal(tail.truncated, true)
  // 保留的是最新内容（尾部），前面用省略号说明被截过。
  assert.ok(tail.shown.startsWith('…'))
  assert.ok(paragraph.endsWith(tail.shown.slice(1)))
})

test('流式尾巴保留完整的末尾几行', () => {
  const lines = ['第一行', '第二行', '第三行', '第四行'].join('\n')
  assert.deepEqual(tailByRows(lines, 2, 40), { shown: '第三行\n第四行', truncated: true })
  assert.deepEqual(tailByRows(lines, 9, 40), { shown: lines, truncated: false })
})

test('超长文本按终端行数截断并说明省略了多少', () => {
  const clamped = clampRows('一二三四五\n'.repeat(20), 3, 10)
  assert.equal(clamped.split('\n').length, 3)
  assert.match(clamped, /… \+19 lines/)
})

test('完成工具卡去掉与标题重复的成功摘要', () => {
  assert.equal(conciseToolCardResult('编辑 src/a.ts', '✓ 编辑 src/a.ts', false), 'Completed')
  assert.equal(
    conciseToolCardResult('运行测试', '✗ 运行测试 · 退出码 1', true),
    '退出码 1',
  )
})

test('shell 失败只保留退出码和一行可操作原因', () => {
  assert.equal(
    conciseShellFailure(
      '命令退出码 1',
      [
        '命令退出码 1',
        'Traceback (most recent call last):',
        '  File "<string>", line 1, in <module>',
        "ModuleNotFoundError: No module named 'cv2'",
      ].join('\n'),
    ),
    "命令退出码 1 · ModuleNotFoundError: No module named 'cv2'",
  )
})

test('编辑前置条件失败显示为单条弱提示', () => {
  assert.deepEqual(
    recoverableToolFailure(
      'edit_file',
      '✗ 编辑 references/setup.md · 修改已有文件前必须先用 read_file 读取：/tmp/setup.md',
      '错误: 修改已有文件前必须先用 read_file 读取：/tmp/setup.md',
    ),
    { result: '修改前需要先读取文件', quiet: true },
  )
  assert.deepEqual(
    recoverableToolFailure(
      'write_file',
      '✗ 写文件 /tmp/setup.md · 文件在读取后已被其他进程修改，请重新 read_file 后再编辑：/tmp/setup.md',
      '错误: 文件在读取后已被其他进程修改，请重新 read_file 后再编辑：/tmp/setup.md',
    ),
    { result: '文件已发生变化，需要重新读取', quiet: true },
  )
  assert.equal(recoverableToolFailure('run_bash', '命令退出码 1'), undefined)
})

test('本地 Fetch 普通视图只显示状态元数据，不重复 URL 和正文', () => {
  assert.equal(
    conciseWebFetchResult(
      '✓ 抓取 https://api.github.com/repos/example（HTTP 200，3 次尝试）',
      'HTTP 200 application/json; charset=utf-8\n[{"name":"large payload"}]',
    ),
    'HTTP 200 · 3 次尝试 · application/json',
  )
})
