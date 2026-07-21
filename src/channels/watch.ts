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
  // 解析全局收件人（兜底用）。
  const globalEmailTo = (cfg.emailTo || smtp?.from || smtp?.user || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)

  // 按规则解析收件人：优先用规则级的 emailTo，否则用全局。
  function emailsFor(rule: StockRule): string[] {
    const raw = rule.emailTo ?? ''
    if (raw.trim()) return raw.split(',').map(s => s.trim()).filter(Boolean)
    return globalEmailTo
  }

  writeLogBanner('watch', '美股监控启动')
  console.log(`✦ ai · 美股监控已启动`)
  console.log(`  监控 ${cfg.watch.length} 只 · 每 ${cfg.pollSeconds}s 轮询一次 · 告警渠道: ${cfg.notify.join('+')}`)
  for (const r of cfg.watch) {
    const cond = [
      r.above != null ? `≥${r.above}` : '',
      r.below != null ? `≤${r.below}` : '',
      r.chgPct != null ? `±${r.chgPct}%` : '',
    ].filter(Boolean).join(' / ')
    const email = r.emailTo ? `→ ${r.emailTo}` : `(全局收件人)`
    console.log(`  · ${r.symbol}  ${cond || '(无条件，仅取价)'}  ${email}`)
  }

  // 每条规则的「已告警」状态：true=条件当前满足且已通知过，等它恢复后再武装。
  const armed = new Map<string, boolean>()
  // 每条规则最近一次告警的日期（YYYY-MM-DD），用于同一天不重复告警。
  const lastAlertDate = new Map<string, string>()
  // 「当天」以各股票交易所所在时区为准（美股按美东、港股按香港），而非 UTC：
  // 这样一个交易日不会被从中间切开，跨日重置也落在收盘后的自然边界上。
  const dateInTz = (tz: string): string => {
    try {
      // en-CA 直接输出 YYYY-MM-DD
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date())
    } catch {
      // 时区名非法时回退到 UTC，至少保证不崩
      return new Date().toISOString().slice(0, 10)
    }
  }

  async function alert(rule: StockRule, q: Quote, reasons: string[]) {
    const ts = new Date().toLocaleString('zh-CN', { hour12: false })
    const line = formatQuote(q)
    const body = `[${ts}] 触发告警\n${line}\n原因: ${reasons.join('；')}`

    if (cfg.notify.includes('terminal')) {
      console.log(`\n🔔 ${body}\n`)
    }
    const to = emailsFor(rule)
    if (wantEmail && to.length) {
      try {
        await sendMail(
          { host: smtp!.host, port: smtp!.port, secure: smtp!.secure, user: smtp!.user!, pass: smtp!.pass!, from: smtp!.from! },
          { to, subject: `📈 ${rule.symbol} 触发告警 (${q.price.toFixed(2)} ${q.currency})`, text: body },
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
      const today = dateInTz(q.timezone)
      // 跨天：重置 armed，让持续触发的条件在新一天也能告警一次
      if (lastAlertDate.get(rule.symbol) !== today) {
        armed.set(rule.symbol, false)
      }
      const wasArmed = armed.get(rule.symbol) ?? false
      const alreadyAlertedToday = lastAlertDate.get(rule.symbol) === today
      if (hit && !wasArmed && !alreadyAlertedToday) {
        armed.set(rule.symbol, true)
        lastAlertDate.set(rule.symbol, today)
        await alert(rule, q, reasons)
      } else if (hit && !wasArmed && alreadyAlertedToday) {
        // 条件满足但今天已告警过：武装以防跨日后需要再告警，但不再重复通知
        armed.set(rule.symbol, true)
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
