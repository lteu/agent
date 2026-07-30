import assert from 'node:assert/strict'
import test from 'node:test'
import {
  EMPTY_ACTIVITY_COUNTS,
  addActivity,
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
