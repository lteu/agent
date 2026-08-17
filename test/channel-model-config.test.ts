import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const repo = new URL('..', import.meta.url).pathname
const cli = join(repo, 'node_modules', '.bin', 'tsx')

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'ai-channel-model-'))
  const configDir = join(home, '.ai')
  const configPath = join(configDir, 'config.json')
  mkdirSync(configDir)
  writeFileSync(
    configPath,
    JSON.stringify({
      apiKey: 'global-key',
      model: 'global-model',
      baseURL: 'https://global.example/v1',
      activeModel: 'global',
      models: [
        { name: 'global', model: 'global-model', baseURL: 'https://global.example/v1', apiKey: 'global-key' },
        { name: 'qq-model', model: 'qq-model-id', baseURL: 'https://qq.example/v1', apiKey: 'qq-key' },
        { name: 'wx-model', model: 'wx-model-id', baseURL: 'https://wx.example/v1', apiKey: 'wx-key' },
      ],
    }),
  )
  return { home, configPath }
}

function run(home: string, ...args: string[]) {
  return spawnSync(cli, ['src/cli.tsx', ...args], {
    cwd: repo,
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
  })
}

test('scoped --use-model keeps the global model unchanged and binds one channel', () => {
  const { home, configPath } = fixture()
  const result = run(home, '--use-model', 'qq-model', '--channel', 'qq')
  assert.equal(result.status, 0, result.stderr)

  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  assert.equal(config.activeModel, 'global')
  assert.equal(config.model, 'global-model')
  assert.deepEqual(config.channelModels, { qq: 'qq-model' })
})

test('--channel all binds every long-running messaging channel', () => {
  const { home, configPath } = fixture()
  const result = run(home, '--use-model', 'wx-model', '--channel', 'all')
  assert.equal(result.status, 0, result.stderr)

  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  assert.deepEqual(config.channelModels, {
    qq: 'wx-model',
    wx: 'wx-model',
    wechat: 'wx-model',
  })
})

test('--use-model rejects unknown channels without changing configuration', () => {
  const { home, configPath } = fixture()
  const before = readFileSync(configPath, 'utf8')
  const result = run(home, '--use-model', 'qq-model', '--channel', 'telegram')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /渠道必须是/)
  assert.equal(readFileSync(configPath, 'utf8'), before)
})

test('--models always exposes the built-in GPT-5.6 Sol subscription profile', () => {
  const { home } = fixture()
  const result = run(home, '--models')
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /5\.6-sol\s+gpt-5\.6-sol/)
  assert.match(result.stdout, /codex:\/\/chatgpt-subscription/)
  assert.match(result.stdout, /Codex Subscription/)
})

for (const alias of ['--list', '--l']) {
  test(`${alias} lists the same built-in model presets as --models`, () => {
    const { home } = fixture()
    const result = run(home, alias)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /5\.6-sol\s+gpt-5\.6-sol/)
    assert.match(result.stdout, /Codex Subscription/)
  })
}

test('--use-model selects the built-in Sol profile without adding an API key', () => {
  const { home, configPath } = fixture()
  const before = JSON.parse(readFileSync(configPath, 'utf8'))
  delete before.apiKey
  writeFileSync(configPath, JSON.stringify(before))

  const result = run(home, '--use-model', '5.6-sol')
  assert.equal(result.status, 0, result.stderr)
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  assert.equal(config.activeModel, '5.6-sol')
  assert.equal(config.model, 'gpt-5.6-sol')
  assert.equal(config.baseURL, 'codex://chatgpt-subscription')
  assert.equal(config.provider, 'Codex Subscription')
  assert.equal(config.apiKey, undefined)
})

for (const alias of ['--use', '--u']) {
  test(`${alias} selects a model and supports the existing channel option`, () => {
    const { home, configPath } = fixture()
    const result = run(home, alias, '5.6-sol', '--channel', 'qq')
    assert.equal(result.status, 0, result.stderr)
    const config = JSON.parse(readFileSync(configPath, 'utf8'))
    assert.equal(config.channelModels.qq, '5.6-sol')
    assert.equal(config.activeModel, 'global')
  })
}
