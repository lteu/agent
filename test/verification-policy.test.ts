import assert from 'node:assert/strict'
import test from 'node:test'
import {
  classifyVerificationCommand,
  evaluateVerificationEvidence,
  verificationRequirementForFiles,
} from '../src/agent/verification-policy.js'

test('识别常见测试、类型检查、构建和语法检查命令', () => {
  assert.equal(classifyVerificationCommand('npm test'), 'test')
  assert.equal(classifyVerificationCommand('cd app && pnpm run test:unit'), 'test')
  assert.equal(classifyVerificationCommand('python3 -m pytest tests/test_api.py'), 'test')
  assert.equal(classifyVerificationCommand('npx tsc --noEmit'), 'typecheck')
  assert.equal(classifyVerificationCommand('npm run lint'), 'lint')
  assert.equal(classifyVerificationCommand('npm run build'), 'build')
  assert.equal(classifyVerificationCommand('node --check script.js'), 'syntax')
  assert.equal(classifyVerificationCommand('ls -la'), null)
})

test('按修改文件数量和风险路径选择验证强度', () => {
  assert.equal(verificationRequirementForFiles([]), 'none')
  assert.equal(verificationRequirementForFiles(['README.md']), 'local')
  assert.equal(verificationRequirementForFiles(['src/view.ts']), 'standard')
  assert.equal(verificationRequirementForFiles(['src/a.ts', 'src/b.ts', 'src/c.ts']), 'strict')
  assert.equal(verificationRequirementForFiles(['src/auth/token.ts']), 'strict')
  assert.equal(verificationRequirementForFiles(['.github/workflows/release.yml']), 'strict')
})

test('只接受最后一次修改之后的验证，并允许同类检查重跑转为通过', () => {
  assert.deepEqual(evaluateVerificationEvidence([
    { batch: 1, order: 1, kind: 'test', ok: true },
  ], 1), {
    hasSuccessfulEvidence: false,
    unresolvedFailures: 0,
  })

  assert.deepEqual(evaluateVerificationEvidence([
    { batch: 2, order: 1, kind: 'test', ok: false },
    { batch: 3, order: 2, kind: 'test', ok: true },
    { batch: 3, order: 3, kind: 'lint', ok: false },
  ], 1), {
    hasSuccessfulEvidence: true,
    unresolvedFailures: 1,
  })
})
