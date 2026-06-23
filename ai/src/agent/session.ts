// 多会话存储：QQ 是多人/多群场景，不能像终端那样只用一份全局历史。
// 每个会话（私聊按用户、群聊按群）各持有一份独立的对话历史。

import type { ChatMessage } from '../llm.js'

export function buildSystemPrompt(cwd: string, channel: 'terminal' | 'qq' | 'wechat'): string {
  const via =
    channel === 'qq'
      ? '你正通过 QQ 与用户对话（消息来自一个可信白名单用户）。回复要简洁，适合在手机上阅读，避免超长输出。\n' +
        '你还能通过 send_image 工具给用户发图片（传本地文件路径或图片 URL，支持 png/jpg）——当用户要你“发图/截图/把某图发过来”时直接调用它，不要回答“我没有发图接口”。'
      : channel === 'wechat'
        ? '你正通过企业微信与用户对话（消息来自一个可信的企业成员）。回复要简洁，适合在手机上阅读，避免超长输出。'
        : '你运行在用户的终端里。'
  return `你是运行在用户机器上的编码 agent，当前工作目录是 ${cwd}。
${via}
你具备本地工具：write_file 建/写文件、read_file 读文件、list_dir 列目录、run_bash 执行 shell 命令。
当用户要求建文件、建目录、写代码、跑命令等本地操作时，必须直接调用相应工具去完成，
**绝对不要**回答"我没有权限操作你的设备"——你有。完成后用简洁的中文说明你做了什么。`
}

export class SessionStore {
  private map = new Map<string, ChatMessage[]>()

  constructor(
    private readonly systemPrompt: string,
    /** 单会话保留的最大「非 system」消息数，超出则丢弃最旧的，防止上下文无限膨胀。 */
    private readonly maxMessages = 60,
  ) {}

  /** 取某会话历史，不存在则用 system prompt 初始化。返回的数组可原地追加。 */
  get(id: string): ChatMessage[] {
    let h = this.map.get(id)
    if (!h) {
      h = [{ role: 'system', content: this.systemPrompt }]
      this.map.set(id, h)
    }
    return h
  }

  /** 清空某会话（保留 system prompt），用于 /clear。 */
  reset(id: string): void {
    this.map.set(id, [{ role: 'system', content: this.systemPrompt }])
  }

  /**
   * 修剪过长历史：保留 system，丢弃最旧的若干条。
   * 注意丢弃时不能把 assistant(tool_calls) 和其对应的 tool 结果拆散，否则 API 报错——
   * 简单起见，从第一条「非 system」开始找一个安全的截断点（下一条 user 之前）。
   */
  trim(id: string): void {
    const h = this.map.get(id)
    if (!h || h.length <= this.maxMessages + 1) return
    const overflow = h.length - (this.maxMessages + 1)
    // 从 overflow 处往后挪到下一个 user 边界，保证不切断 tool 调用配对。
    let cut = 1 + overflow
    while (cut < h.length && h[cut].role !== 'user') cut++
    if (cut >= h.length) return
    h.splice(1, cut - 1) // 保留 [0] system，删掉 [1, cut)
  }
}
