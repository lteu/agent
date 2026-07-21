// 阻止 macOS 在长时间无人操作时休眠。
//
// 背景：本机 `pmset` 的 sleep 计时器很短（如 1 分钟），人一离开系统就休眠。
// 系统休眠会把 Node 进程整体冻结——QQ 网关连接随之中断，手机端便「连不上」。
// 任何应用内的重连逻辑都救不了一个被冻结的进程，所以必须从根上不让系统休眠。
//
// 做法：在 serve 期间拉起 `caffeinate -i`，并用 `-w <本进程 pid>` 让它跟随本进程生命周期，
// bot 一退出 caffeinate 自动结束——即「只在 bot 运行时」阻止系统空闲休眠。
// 注意：合上笔记本盖子的「强制休眠」不受 caffeinate 约束（除非接电源+外接显示器）。

import { spawn } from 'node:child_process'

export function keepAwake(): void {
  if (process.platform !== 'darwin') return
  try {
    const child = spawn('caffeinate', ['-i', '-w', String(process.pid)], {
      stdio: 'ignore',
      detached: true,
    })
    child.unref()
    child.on('error', e => console.error('caffeinate 启动失败（系统可能仍会休眠）：', (e as any)?.message ?? e))
    console.log('☕ 已阻止系统空闲休眠（caffeinate -i）——注意：合盖仍会休眠')
  } catch (e: any) {
    console.error('caffeinate 启动失败（系统可能仍会休眠）：', e?.message ?? e)
  }
}
