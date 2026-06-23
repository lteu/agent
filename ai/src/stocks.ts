// 美股行情：用 Yahoo Finance 的公开 chart 接口取实时报价。
// 无需 API key、无需额外依赖（只用 Node 内置 fetch），与项目「Node 内置」的风格一致。
// 接口：GET query1.finance.yahoo.com/v8/finance/chart/{symbol}
//   返回 chart.result[0].meta 里含 regularMarketPrice / chartPreviousClose / currency 等。

export type Quote = {
  symbol: string
  name: string
  price: number
  prevClose: number
  change: number // 价格变动（price - prevClose）
  changePct: number // 涨跌幅 %
  currency: string
  exchange: string
  time: number // 报价时间（unix 秒）
}

// 两个等价域名：query1 抖动时回退 query2，对付偶发超时/限流。
const HOSTS = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']
const chartUrl = (host: string, s: string) =>
  `https://${host}/v8/finance/chart/${encodeURIComponent(s)}?interval=1d&range=1d`

// 抓一次行情 JSON：按域名轮替 + 整体重试，全部失败才抛最后一个错误。
// 单次请求超时 10s；两个域名各试两轮，足以吸收瞬时网络抖动。
async function fetchChart(sym: string): Promise<any> {
  let lastErr: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const host of HOSTS) {
      try {
        const res = await fetch(chartUrl(host, sym), {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          signal: AbortSignal.timeout(10_000),
        })
        if (!res.ok) throw new Error(`行情接口 HTTP ${res.status}`)
        return await res.json()
      } catch (e) {
        lastErr = e
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

/** 取单只股票报价。symbol 不存在或接口异常时抛错。 */
export async function getQuote(symbol: string): Promise<Quote> {
  const sym = symbol.trim().toUpperCase()
  const json: any = await fetchChart(sym)
  const err = json?.chart?.error
  if (err) throw new Error(`${sym}: ${err.description ?? err.code ?? '查询失败'}`)
  const meta = json?.chart?.result?.[0]?.meta
  if (!meta || typeof meta.regularMarketPrice !== 'number') {
    throw new Error(`${sym}: 未找到该代码的报价`)
  }
  const price = meta.regularMarketPrice
  const prevClose = meta.chartPreviousClose ?? meta.previousClose ?? price
  const change = price - prevClose
  return {
    symbol: meta.symbol ?? sym,
    name: meta.shortName ?? meta.longName ?? sym,
    price,
    prevClose,
    change,
    changePct: prevClose ? (change / prevClose) * 100 : 0,
    currency: meta.currency ?? 'USD',
    exchange: meta.exchangeName ?? '',
    time: meta.regularMarketTime ?? Math.floor(Date.now() / 1000),
  }
}

/** 批量取报价：逐只串行，单只失败不影响其它（返回里带 error 字段）。 */
export async function getQuotes(
  symbols: string[],
): Promise<{ symbol: string; quote?: Quote; error?: string }[]> {
  const out: { symbol: string; quote?: Quote; error?: string }[] = []
  for (const s of symbols) {
    try {
      out.push({ symbol: s, quote: await getQuote(s) })
    } catch (e: any) {
      out.push({ symbol: s, error: e?.message ?? String(e) })
    }
  }
  return out
}

/** 把一只报价格式化成一行人类可读文本，如：AAPL Apple Inc. 295.95 USD ▼ -3.29 (-1.10%)。 */
export function formatQuote(q: Quote): string {
  const arrow = q.change > 0 ? '▲' : q.change < 0 ? '▼' : '＝'
  const sign = q.change > 0 ? '+' : ''
  return (
    `${q.symbol} ${q.name}  ${q.price.toFixed(2)} ${q.currency}  ` +
    `${arrow} ${sign}${q.change.toFixed(2)} (${sign}${q.changePct.toFixed(2)}%)`
  )
}
