import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runTool, TOOL_SCHEMAS, type ToolContext } from '../src/tools.js'

process.env.AI_DISABLE_TOOL_DEBUG_LOG = '1'

function context(): ToolContext {
  return {
    apiKey: 'test',
    model: 'test',
    baseURL: 'http://localhost',
    readSnapshots: new Map(),
    fileMutationLocks: new Map(),
  }
}

test('工具输入在执行前校验并返回结构化错误', async () => {
  const result = await runTool('read_file', { path: 42 }, context())
  assert.equal(result.ok, false)
  assert.equal(result.error?.code, 'invalid_input')
  assert.equal(result.error?.userMessage, '工具参数无效')
})

test('run_agent 暴露恢复 ID 和独立预算参数', () => {
  const schema = TOOL_SCHEMAS
    .find(tool => tool.function.name === 'run_agent')?.function.parameters as any
  assert.equal(schema.properties.agent_id.type, 'string')
  assert.equal(schema.properties.max_steps.type, 'number')
})

test('web_fetch 会重试瞬时网络错误，并在恢复后返回成功', async t => {
  const originalFetch = globalThis.fetch
  let attempts = 0
  t.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = (async () => {
    attempts++
    if (attempts < 3) {
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }),
      })
    }
    return new Response('recovered', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    })
  }) as typeof fetch

  const result = await runTool('web_fetch', {
    url: 'https://example.com/data',
  }, context())

  assert.equal(result.ok, true)
  assert.equal(attempts, 3)
  assert.equal(result.evidence?.attempts, 3)
  assert.match(result.output, /recovered/)
})

test('web_fetch 耗尽重试后向 UI 隐藏底层错误，但给模型保留详情', async t => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = (async () => {
    throw new TypeError('fetch failed', {
      cause: Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }),
    })
  }) as typeof fetch

  const result = await runTool('web_fetch', {
    url: 'https://example.com/data',
  }, context())

  assert.equal(result.ok, false)
  assert.equal(result.error?.code, 'network_error')
  assert.equal(result.error?.userMessage, '网页抓取失败，Agent 将尝试其他方式')
  assert.match(result.error?.message ?? '', /ECONNRESET/)
  assert.equal(result.evidence?.attempts, 3)
})

test('新文件可直接创建，但覆盖已有文件前必须读取', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-tool-result-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'sample.ts')
  const ctx = context()

  const created = await runTool('write_file', { path, content: 'const a = 1\n' }, ctx)
  assert.equal(created.ok, true)
  assert.equal(created.evidence?.kind, 'file_write')

  const blindOverwrite = await runTool('write_file', { path, content: 'const a = 2\n' }, context())
  assert.equal(blindOverwrite.ok, false)
  assert.equal(blindOverwrite.error?.code, 'file_not_read')
})

test('读取后可以编辑，并阻止覆盖读取后发生的外部修改', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-tool-stale-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'sample.ts')
  const ctx = context()
  writeFileSync(path, 'const value = 1\n')

  assert.equal((await runTool('read_file', { path }, ctx)).ok, true)
  const edited = await runTool('edit_file', {
    path,
    old_string: 'value = 1',
    new_string: 'value = 2',
  }, ctx)
  assert.equal(edited.ok, true)
  assert.equal(edited.evidence?.replacements, 1)
  assert.match(readFileSync(path, 'utf8'), /value = 2/)

  writeFileSync(path, 'const value = 3\n')
  const stale = await runTool('edit_file', {
    path,
    old_string: 'value = 2',
    new_string: 'value = 4',
  }, ctx)
  assert.equal(stale.ok, false)
  assert.equal(stale.error?.code, 'stale_file')
  assert.equal(readFileSync(path, 'utf8'), 'const value = 3\n')
})

test('Bash 使用真实退出状态，不扫描输出关键词', async () => {
  const ctx = context()
  const successWithScaryText = await runTool('run_bash', {
    command: "printf 'fatal failed error:'",
    intent: '输出测试文本',
  }, ctx)
  assert.equal(successWithScaryText.ok, true)
  assert.equal(successWithScaryText.evidence?.exitCode, 0)

  const failed = await runTool('run_bash', {
    command: "sh -c 'exit 7'",
    intent: '制造失败退出',
  }, ctx)
  assert.equal(failed.ok, false)
  assert.equal(failed.evidence?.exitCode, 7)

  const noMatch = await runTool('run_bash', {
    command: 'grep missing /dev/null',
    intent: '检查无匹配语义',
  }, ctx)
  assert.equal(noMatch.ok, true)
  assert.equal(noMatch.evidence?.exitCode, 1)
})
