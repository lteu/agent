import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createRemoteServer } from '../src/server.js'

test('binds a device, proxies a completion, and meters its usage', async t => {
  const upstream = createServer(async (req, res) => {
    for await (const _ of req) {
      // Drain request.
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    }))
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  t.after(() => upstream.close())
  const upstreamAddress = upstream.address()
  assert(upstreamAddress && typeof upstreamAddress === 'object')

  const app = createRemoteServer({
    host: '127.0.0.1',
    port: 0,
    databasePath: join(mkdtempSync(join(tmpdir(), 'ai-remote-')), 'test.sqlite'),
    upstreamApiKey: 'provider-secret',
    upstreamBaseUrl: `http://127.0.0.1:${upstreamAddress.port}`,
    upstreamModel: 'test-model',
    initialQuota: 20,
    noticeThreshold: 5,
  })
  const address = await app.listen()
  t.after(() => app.close())
  const origin = `http://127.0.0.1:${address.port}`
  const hwid = 'a'.repeat(64)

  const bind = await fetch(`${origin}/v1/devices/bind`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hwid }),
  })
  assert.equal(bind.status, 201)
  const credentials = await bind.json() as any
  assert.match(credentials.access_key, /^sk-svr-/)

  const chat = await fetch(`${origin}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${credentials.access_key}`,
      'x-ai-device-id': credentials.device_id,
    },
    body: JSON.stringify({ model: 'ignored', messages: [{ role: 'user', content: 'hi' }] }),
  })
  assert.equal(chat.status, 200)
  const completion = await chat.json() as any
  assert.equal(completion.choices[0].message.content, 'ok')
  assert.equal(completion.ai_remote.usage.total_tokens, 5)
  assert.equal(completion.ai_remote.quota_tokens, 15)
  assert.equal(completion.ai_remote.notice.type, 'threshold_reached')

  const rebind = await fetch(`${origin}/v1/devices/bind`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hwid }),
  })
  assert.equal(rebind.status, 200)
  const rotated = await rebind.json() as any
  assert.equal(rotated.device_id, credentials.device_id)
  assert.notEqual(rotated.access_key, credentials.access_key)
  assert.equal(rotated.rebound, true)
  assert.equal(rotated.used_tokens, 5)
  assert.equal(rotated.quota_tokens, 15)

  const oldKey = await fetch(`${origin}/v1/usage/me`, {
    headers: {
      authorization: `Bearer ${credentials.access_key}`,
      'x-ai-device-id': credentials.device_id,
    },
  })
  assert.equal(oldKey.status, 401)

  const usage = await fetch(`${origin}/v1/usage/me`, {
    headers: {
      authorization: `Bearer ${rotated.access_key}`,
      'x-ai-device-id': rotated.device_id,
    },
  })
  assert.deepEqual(await usage.json(), {
    device_id: credentials.device_id,
    plan: 'free',
    used_tokens: 5,
    quota_tokens: 15,
  })

  const copiedKey = await fetch(`${origin}/v1/usage/me`, {
    headers: { authorization: `Bearer ${rotated.access_key}` },
  })
  assert.equal(copiedKey.status, 403)

  const otherBind = await fetch(`${origin}/v1/devices/bind`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hwid: 'b'.repeat(64) }),
  })
  assert.equal(otherBind.status, 201)
  const otherDevice = await otherBind.json() as any
  assert.notEqual(otherDevice.device_id, credentials.device_id)
  assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM devices').get()!.count, 2)
})
