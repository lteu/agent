import assert from 'node:assert/strict'
import test from 'node:test'
import {
  EMPTY_ACTIVITY_COUNTS,
  activeToolPresentation,
  addActivity,
  conciseShellFailure,
  conciseToolCardResult,
  conciseWebFetchResult,
  formatActivity,
  formatUserPrompt,
  parseAgentCardItem,
} from '../src/ui-activity.js'

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

test('本地 Fetch 普通视图只显示状态元数据，不重复 URL 和正文', () => {
  assert.equal(
    conciseWebFetchResult(
      '✓ 抓取 https://api.github.com/repos/example（HTTP 200，3 次尝试）',
      'HTTP 200 application/json; charset=utf-8\n[{"name":"large payload"}]',
    ),
    'HTTP 200 · 3 次尝试 · application/json',
  )
})
