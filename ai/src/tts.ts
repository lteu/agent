// 本机文字转语音：用 macOS 自带的 `say` 合成，再用 `afconvert` 转成 QQ 富媒体语音
// 接受的 16k 单声道 WAV。零外部服务 / 零密钥 / 零额外依赖——守护进程正好跑在 mac 上。
//
// 选 WAV 而非 SILK：QQ 富媒体语音(file_type:3)接受 silk/wav/mp3/flac，WAV 最省事，
// 不必引入 SILK 原生编码器。

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const exec = promisify(execFile)

// 语音回复的文本上限：太长既难听、合成也慢，且 QQ 语音约 60s 上限。
// 200 字普通话约 45s，稳在限制内；超出截断并补发完整文字（见 qq.ts）。
const MAX_TTS_CHARS = 200

// macOS 默认普通话音色；config 里 qq.voice 可覆盖。
export const DEFAULT_VOICE = 'Tingting'

export type TtsResult = { wav: Buffer; truncated: boolean }

/** 把文本合成为 WAV(16k 单声道)。失败抛错，由调用方决定回退文字。 */
export async function synthesizeWav(text: string, voice = DEFAULT_VOICE): Promise<TtsResult> {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (!clean) throw new Error('TTS: 空文本')
  const truncated = clean.length > MAX_TTS_CHARS
  const input = truncated ? clean.slice(0, MAX_TTS_CHARS) + '……（后续内容请看文字）' : clean

  const dir = await mkdtemp(join(tmpdir(), 'ai-tts-'))
  const aiff = join(dir, 'out.aiff')
  const wav = join(dir, 'out.wav')
  try {
    // say -v <voice> -o out.aiff "text"；指定音色不可用时退回系统默认音色。
    try {
      await exec('say', voice ? ['-v', voice, '-o', aiff, input] : ['-o', aiff, input])
    } catch (e) {
      if (!voice) throw e
      await exec('say', ['-o', aiff, input])
    }
    // afconvert → WAVE / 16-bit LE PCM / 16kHz / 单声道
    await exec('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', aiff, wav])
    return { wav: await readFile(wav), truncated }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
