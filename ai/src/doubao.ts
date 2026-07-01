// 豆包(火山引擎)语音合成大模型 V3 单向流式接口：零依赖(仅内置 fetch)。
// 文档：https://www.volcengine.com/docs/6561/1598757 —— appid/token 在控制台「服务接口认证信息」获取，
// voiceType(speaker) 在控制台「音色列表」查，形如 zh_female_xxx_moon_bigtts / xxx_uranus_bigtts。
//
// 注意：这是给「*_bigtts」新版音色用的接口（走 X-Api-* 请求头 + NDJSON 流式响应），
// 和旧版「基础语音合成」(BV 开头音色、api/v1/tts、cluster 参数) 是两套完全不同的接口，不能混用。
// 响应体不是一整块 JSON，而是逐行 NDJSON：每行 {code:0, data:"<base64 音频块>"}，
// 结束行 {code:20000000}；非 0/20000000 的 code 视为出错。

import type { DoubaoTtsConfig } from './config.js'
import { MAX_TTS_CHARS } from './tts.js'

const TTS_URL = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional'
const CODE_CHUNK = 0
const CODE_DONE = 20000000

export type TtsResult = { wav: Buffer; truncated: boolean }

// resource_id 按 voiceType 后缀推断：xxx_uranus_bigtts 是 2.0 音色，其余 *_bigtts(mars/moon 等)
// 是 1.0 音色，S_ 开头是声音复刻音色。查不出规律时退回 1.0（最常见）。
function inferResourceId(voiceType: string): string {
  if (/^S_/.test(voiceType)) return 'seed-icl-2.0'
  if (/_uranus_bigtts$/.test(voiceType)) return 'seed-tts-2.0'
  return 'seed-tts-1.0'
}

/** 用豆包(火山引擎)语音合成大模型把文本转成音频(mp3)。失败抛错，由调用方决定回退。 */
export async function synthesizeDoubaoWav(text: string, cfg: DoubaoTtsConfig): Promise<TtsResult> {
  if (!cfg.appId || !cfg.token) {
    throw new Error('未配置豆包 TTS。先运行: ai --set-doubao-tts <appid> <token> <voice_type>')
  }
  if (!cfg.voiceType) {
    throw new Error('未配置豆包 TTS 音色(voice_type)。控制台「音色列表」查一个，如 zh_female_xxx_moon_bigtts')
  }
  const clean = text.replace(/\s+/g, ' ').trim()
  if (!clean) throw new Error('TTS: 空文本')
  const truncated = clean.length > MAX_TTS_CHARS
  const input = truncated ? clean.slice(0, MAX_TTS_CHARS) + '……（后续内容请看文字）' : clean

  const res = await fetch(TTS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-App-Id': cfg.appId,
      'X-Api-Access-Key': cfg.token,
      'X-Api-Resource-Id': cfg.resourceId || inferResourceId(cfg.voiceType),
      'X-Api-Request-Id': crypto.randomUUID(),
    },
    body: JSON.stringify({
      user: { uid: 'ai-cli' },
      req_params: {
        text: input,
        speaker: cfg.voiceType,
        audio_params: { format: 'mp3', sample_rate: 24000 },
      },
    }),
  })
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '')
    throw new Error(`豆包 TTS 请求失败 (HTTP ${res.status}): ${detail.slice(0, 200)}`)
  }

  const chunks: Buffer[] = []
  let buf = ''
  const decoder = new TextDecoder('utf8')
  const parseLine = (line: string) => {
    const trimmed = line.trim()
    if (!trimmed) return
    const obj = JSON.parse(trimmed)
    if (obj.code === CODE_CHUNK) {
      if (obj.data) chunks.push(Buffer.from(obj.data, 'base64'))
    } else if (obj.code !== CODE_DONE) {
      throw new Error(`豆包 TTS 失败 (code ${obj.code}): ${obj.message ?? trimmed.slice(0, 200)}`)
    }
  }
  for await (const chunk of res.body as any) {
    buf += decoder.decode(chunk, { stream: true })
    let idx: number
    while ((idx = buf.indexOf('\n')) >= 0) {
      parseLine(buf.slice(0, idx))
      buf = buf.slice(idx + 1)
    }
  }
  parseLine(buf)

  if (!chunks.length) throw new Error('豆包 TTS 未返回音频数据')
  return { wav: Buffer.concat(chunks), truncated }
}
