export type ModelStatus = {
  phase: 'connecting' | 'waiting' | 'receiving'
  phaseStartedAt: number
  lastActivityAt: number
}

export function formatModelStatus(status: ModelStatus, now: number, model: string): string {
  const silentSeconds = Math.max(0, Math.floor((now - status.lastActivityAt) / 1000))
  const phaseLabel =
    status.phase === 'connecting'
      ? `正在连接 ${model}`
      : status.phase === 'waiting'
        ? `等待 ${model} 响应`
        : `正在接收 ${model} 输出`
  const warning =
    silentSeconds >= 90
      ? ' · 响应持续较慢，可按 Esc 中断'
      : silentSeconds >= 30
        ? ' · 响应较慢'
        : ''
  return `${phaseLabel}（静默 ${silentSeconds}s${warning}）`
}
