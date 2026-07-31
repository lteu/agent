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
