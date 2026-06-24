// 判断一条 IM 消息是不是「叫停」指令：用户在任务进行中发来「等一下/停/暂停/stop」之类，
// 我们据此中断（abort）当前还在跑的 runAgent。
//
// 故意用「整条消息≈就是这个词」的严格匹配（允许尾部标点/语气词），
// 避免「停车场怎么走」「我先暂停了一下工作」这种把 stop 词当子串的误伤。
const STOP_RE =
  /^\s*(等一?下|等等|稍等|慢着|停一?下|停止|别动|先别|暂停|打住|先停|住手|取消|算了|停|stop|wait|pause|hold on|hold|cancel|abort)[\s!！。.，,…~、]*$/i

export function isStopCommand(text: string): boolean {
  return STOP_RE.test(text.trim())
}
