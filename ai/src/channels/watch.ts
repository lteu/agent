// 美股监控守护进程：按配置的自选规则轮询 Yahoo 行情，触发条件时告警（邮件 / 终端打印）。
//
// 设计要点：
//   · 边沿触发 + 迟滞：只在「条件从未满足变为满足」的那一刻告警一次，避免每轮重复轰炸；
//     条件恢复后才重新「武装」，下次再次突破才会再告警。
//   · 单只行情失败（网络抖动/限流）只跳过这一轮，不影响整体循环。
//   · 与 QQ 守护进程一样，自带顶层异常兜底，崩了也落盘而不是静默退出。

import { loadStocksConfig, loadSmtpConfig, type StockRule } from '../config.js'
import { getQuote, formatQuote, type Quote } from '../stocks.js'
import { sendMail } from '../smtp.js'
import { writeLogBanner } from '../agent/chatlog.js'
import { writeCrash } from '../crashlog.js'

// 判断一条规则在当前报价下命中了哪些条件（可能多条），返回告警原因文本数组。
function evaluate(rule: StockRule, q: Quote): string[] {
  const hits: string[] = []
  if (typeof rule.above === 'number' && q.price >= rule.above) {
    hits.push(`价格 ${q.price.toFixed(2)} ≥ ${rule.above}`)
  }
  if (typeof rule.below === 'number' && q.price <= rule.below) {
    hits.push(`价格 ${q.price.toFixed(2)} ≤ ${rule.below}`)
  }
  if (typeof rule.chgPct === 'number' && Math.abs(q.changePct) >= rule.chgPct) {
    hits.push(`涨跌幅 ${q.changePct.toFixed(2)}% 触及 ±${rule.chgPct}%`)
  }
  return hits
}

export function startWatch(): void {
  const cfg = loadStocksConfig()
  if (!cfg.watch.length) {
    console.error('监控列表为空。先添加规则，例如:\n  ai watch add AAPL above=300 below=250 chg=5')
    process.exit(1)
  }

  const wantEmail = cfg.notify.includes('email')
  const smtp = wantEmail ? loadSmtpConfig() : null
  if (wantEmail && (!smtp!.user || !smtp!.pass)) {
    console.error('告警渠道含「邮件」但未配置发件邮箱。先运行 ai --set-smtp，或改用 ai --set-stocks-notify terminal')
    process.exit(1)
  }
  // 收件人支持多个（逗号分隔）；留空则默认发给自己（SMTP 发件邮箱）。
  const emailTo = (cfg.emailTo || smtp?.from || smtp?.user || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)

  writeLogBanner('watch', '美股监控启动')
  console.log(`✦ ai · 美股监控已启动`)
  console.log(`  监控 ${cfg.watch.length} 只 · 每 ${cfg.pollSeconds}s 轮询一次 · 告警渠道: ${cfg.notify.join('+')}`)
  for (const r of cfg.watch) {
    const cond = [
      r.above != null ? `≥${r.above}` : '',
      r.below != null ? `≤${r.below}` : '',
      r.chgPct != null ? `±${r.chgPct}%` : '',
    ].filter(Boolean).join(' / ')
    console.log(`  · ${r.symbol}  ${cond || '(无条件，仅取价)'}`)
  }

  // 每条规则的「已告警」状态：true=条件当前满足且已通知过，等它恢复后再武装。
  const armed = new Map<string, boolean>()

  async function alert(rule: StockRule, q: Quote, reasons: string[]) {
    const ts = new Date().toLocaleString('zh-CN', { hour12: false })
    const line = formatQuote(q)
    const body = `[${ts}] 触发告警\n${line}\n原因: ${reasons.join('；')}`

    if (cfg.notify.includes('terminal')) {
      console.log(`\n🔔 ${body}\n`)
    }
    if (wantEmail && emailTo.length) {
      try {
        await sendMail(
          { host: smtp!.host, port: smtp!.port, secure: smtp!.secure, user: smtp!.user!, pass: smtp!.pass!, from: smtp!.from! },
          { to: emailTo, subject: `📈 ${rule.symbol} 触发告警 (${q.price.toFixed(2)} ${q.currency})`, text: body },
        )
      } catch (e: any) {
        console.error(`  邮件告警发送失败: ${e?.message ?? e}`)
      }
    }
  }

  async function tick() {
    for (const rule of cfg.watch) {
      let q: Quote
      try {
        q = await getQuote(rule.symbol)
      } catch (e: any) {
        console.error(`  [${rule.symbol}] 取价失败，跳过本轮: ${e?.message ?? e}`)
        continue
      }
      const reasons = evaluate(rule, q)
      const hit = reasons.length > 0
      const wasArmed = armed.get(rule.symbol) ?? false
      if (hit && !wasArmed) {
        armed.set(rule.symbol, true) // 武装→触发，告警一次
        await alert(rule, q, reasons)
      } else if (!hit && wasArmed) {
        armed.set(rule.symbol, false) // 条件恢复，重新武装
      }
    }
  }

  // 立即跑一轮，之后按间隔轮询。
  tick().catch(e => console.error('首轮轮询出错:', e?.message ?? e))
  setInterval(() => {
    tick().catch(e => console.error('轮询出错:', e?.message ?? e))
  }, cfg.pollSeconds * 1000)

  // 顶层兜底：守护进程崩溃也落盘，不静默退出。
  const bail = (label: string) => (err: unknown) => {
    const logPath = writeCrash(label, err)
    console.error(`\n美股监控遇到意外错误（${label}），日志: ${logPath}`)
    console.error(err instanceof Error ? err.stack ?? err.message : String(err))
  }
  process.on('uncaughtException', bail('watch:uncaughtException'))
  process.on('unhandledRejection', bail('watch:unhandledRejection'))
}
