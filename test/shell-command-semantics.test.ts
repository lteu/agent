import assert from 'node:assert/strict'
import test from 'node:test'
import { interpretShellCommandResult } from '../src/shell-command-semantics.js'

test('grep/rg 退出码 1 表示无匹配，不是错误', () => {
  assert.deepEqual(interpretShellCommandResult('ls -la | grep -E "^\\."', 1), {
    isError: false,
    message: '未找到匹配',
  })
  assert.equal(interpretShellCommandResult('rg missing src', 1).isError, false)
})

test('grep 的退出码 2 仍然是错误', () => {
  assert.equal(interpretShellCommandResult('grep pattern missing-file', 2).isError, true)
})

test('识别引号内的控制符和命令绝对路径', () => {
  assert.equal(interpretShellCommandResult("printf '%s|%s' a b | /usr/bin/grep z", 1).isError, false)
  assert.equal(interpretShellCommandResult('printf x | grep y;\n', 1).isError, false)
})

test('diff/test 的退出码 1 是有意义的正常结果', () => {
  assert.equal(interpretShellCommandResult('diff before after', 1).isError, false)
  assert.equal(interpretShellCommandResult('[ -f missing ]', 1).isError, false)
})

test('未知命令保持非零即失败的默认语义', () => {
  assert.equal(interpretShellCommandResult('node script.js', 1).isError, true)
})
