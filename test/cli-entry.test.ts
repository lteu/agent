import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url))

test('ai --version exits without starting the Ink TUI', () => {
  const result = spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8' })
  assert.equal(result.status, 0)
  assert.match(result.stdout, /^\d+\.\d+\.\d+ \(ai\)\n$/)
  assert.doesNotMatch(result.stdout + result.stderr, /Raw mode|InternalApp|Welcome back/)
})

test('ai mcp --help is a non-interactive CLI path', () => {
  const result = spawnSync(process.execPath, [cli, 'mcp', '--help'], { encoding: 'utf8' })
  assert.equal(result.status, 0)
  assert.match(result.stdout, /ai mcp/)
  assert.match(result.stdout, /ai mcp auth/)
  assert.doesNotMatch(result.stdout + result.stderr, /Raw mode|InternalApp|Welcome back/)
})

test('ai mcp local scope can add, connect, list, and remove a real stdio server', () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-mcp-cli-'))
  const home = join(root, 'home')
  const project = join(root, 'project')
  mkdirSync(home)
  mkdirSync(join(project, '.git'), { recursive: true })
  const fixture = fileURLToPath(new URL('./fixtures/mcp-echo-server.mjs', import.meta.url))
  const env = { ...process.env, HOME: home }

  const add = spawnSync(process.execPath, [
    cli,
    'mcp',
    'add',
    '--scope',
    'local',
    'fixture',
    '--',
    process.execPath,
    fixture,
  ], { cwd: project, env, encoding: 'utf8' })
  assert.equal(add.status, 0, add.stderr)
  assert.match(add.stdout, /已添加 MCP server "fixture"/)

  const check = spawnSync(process.execPath, [cli, 'mcp', 'test', 'fixture'], {
    cwd: project,
    env,
    encoding: 'utf8',
  })
  assert.equal(check.status, 0, check.stderr)
  assert.match(check.stdout, /连接成功，发现 2 个工具/)
  assert.match(check.stdout, /capabilities: prompts/)

  const list = spawnSync(process.execPath, [cli, 'mcp', 'list'], {
    cwd: project,
    env,
    encoding: 'utf8',
  })
  assert.equal(list.status, 0, list.stderr)
  assert.match(list.stdout, /status: connected \(2 tools\)/)

  const remove = spawnSync(process.execPath, [cli, 'mcp', 'remove', 'fixture'], {
    cwd: project,
    env,
    encoding: 'utf8',
  })
  assert.equal(remove.status, 0, remove.stderr)
  assert.match(remove.stdout, /已从 local 配置移除/)
})

test('ai mcp add accepts Studio-style name --url URL syntax', () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-mcp-url-cli-'))
  const home = join(root, 'home')
  const project = join(root, 'project')
  mkdirSync(home)
  mkdirSync(join(project, '.git'), { recursive: true })
  const env = { ...process.env, HOME: home }

  const add = spawnSync(process.execPath, [
    cli,
    'mcp',
    'add',
    'dcpv2',
    '--url',
    'https://mcphub.daikuan.qihoo.net/mcp/dcpv2',
  ], { cwd: project, env, encoding: 'utf8' })
  assert.equal(add.status, 0, add.stderr)
  assert.match(add.stdout, /已添加 MCP server "dcpv2"（http）/)

  const config = JSON.parse(readFileSync(join(home, '.ai', 'config.json'), 'utf8'))
  const projectConfig = Object.values(config.mcpProjects)[0] as { mcpServers: Record<string, unknown> }
  assert.deepEqual(projectConfig.mcpServers.dcpv2, {
    type: 'http',
    url: 'https://mcphub.daikuan.qihoo.net/mcp/dcpv2',
  })
})
