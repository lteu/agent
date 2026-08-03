import assert from 'node:assert/strict'
import test from 'node:test'
import {
  EMPTY_ACTIVITY_COUNTS,
  activeToolPresentation,
  addActivity,
  compactToolResultRows,
  conciseBrowserToolCard,
  conciseShellFailure,
  conciseToolCardResult,
  conciseWebFetchResult,
  formatActivity,
  formatUserPrompt,
  parseAgentCardItem,
  recoverableToolFailure,
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
