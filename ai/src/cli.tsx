import { useState, useRef, useCallback, useEffect, memo, useMemo } from 'react'
import { render, Box, Text, useApp, useInput } from 'ink'
import MultilineInput from './MultilineInput.js'
import { type ChatMessage } from './llm.js'
import {
  loadConfig,
  loadRawConfig,
  saveApiKey,
  saveModel,
  saveBaseURL,
  saveProvider,
  saveQQConfig,
  addQQAllow,
  saveWechatConfig,
  saveSmtpConfig,
  loadSmtpConfig,
  loadStocksConfig,
  saveStocksConfig,
  upsertStockRule,
  removeStockRule,
  CONFIG_PATH,
  DEFAULT_MODEL,
  DEFAULT_BASE_URL,
} from './config.js'
import { sendMail } from './smtp.js'
import { getQuotes, formatQuote } from './stocks.js'
import { runAgent } from './agent/engine.js'
import { buildSystemPrompt } from './agent/session.js'
import { logChat, writeLogBanner } from './agent/chatlog.js'
import { writeCrash } from './crashlog.js'

// 启动时写 banner，快速确认日志系统运行
writeLogBanner('terminal', `ai 终端启动，工作目录: ${process.cwd()}`)

const SYSTEM_PROMPT = buildSystemPrompt(process.cwd(), 'terminal')

// ———————————————————————————————————————————————
// 命令行参数（在渲染界面之前处理）
// ———————————————————————————————————————————————
const argv = process.argv.slice(2)

if (argv[0] === '--help' || argv[0] === '-h') {
  console.log(`ai — 终端里的可编辑对话框（接入任意 OpenAI 兼容大模型），也能通过 QQ 远程操控

用法:
  ai                       进入交互对话框（缺少 key 时会在启动时引导输入）
  ai serve                 启动 QQ 官方机器人（q.qq.com 开放平台，白名单内可操控 agent）
  ai push <消息>           主动给白名单用户发一条 QQ 消息（官方限单聊每月 4 条）
  ai email <收件人> <主题> <正文>  用已配置的 SMTP 邮箱发一封邮件（收件人多个用逗号分隔）
  ai stock <代码[,代码...]>  查询美股实时报价（Yahoo Finance），例: ai stock AAPL,TSLA
  ai watch                 启动美股监控守护进程（按自选规则轮询，触发告警）
  ai watch list            查看当前监控规则
  ai watch add <代码> [above=N] [below=N] [chg=P]  添加/更新一条监控规则
  ai watch rm <代码>       删除一条监控规则
  ai --set-stocks-notify <email|terminal|both>  设置告警渠道（默认 both）
  ai --set-stocks-email <邮箱[,邮箱...]>  设置告警邮件收件人（多个用逗号分隔）
  ai wechat                启动企业微信回调服务（配合 cloudflared 隧道接入企业微信）
  ai --set-wechat <CorpID> <AgentId> <Secret> <Token> <EncodingAESKey>  保存企业微信凭据
  ai --set-smtp <邮箱> <应用专用密码> [host] [port]  保存发件邮箱（默认 smtp.gmail.com:465）
  ai --set-key <KEY>       保存 API key 到 ${CONFIG_PATH}
  ai --set-model <MODEL>   保存模型名到 ${CONFIG_PATH}（默认 ${DEFAULT_MODEL}）
  ai --set-base-url <URL>  保存 API 地址到 ${CONFIG_PATH}（默认 ${DEFAULT_BASE_URL}）
  ai --set-provider <名称>  保存服务商显示名（仅用于界面/报错，如 OpenAI、通义千问）
  ai --set-qq-app <ID> <SECRET>  保存 QQ 机器人 AppID 和 AppSecret
  ai --qq-allow <openid>   往 QQ 白名单追加一个 openid（可多次；未授权用户发消息会回显其 openid）
  ai --config              查看当前生效的完整配置（含默认值、文件值、环境变量）
  ai --help                显示帮助

切换服务商 / 模型（OpenAI 兼容即可，如 OpenAI、通义千问、Moonshot、OpenRouter、本地 Ollama）:
  改 config.json 里的 baseURL / model / apiKey 三项即可，无需改代码。例:
    ai --set-base-url https://api.openai.com/v1
    ai --set-model gpt-4o-mini
    ai --set-key <你的-key>

配置（优先级从高到低）:
  环境变量 AI_API_KEY / AI_MODEL / AI_BASE_URL / AI_PROVIDER
  （兼容旧名 DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL）
  配置文件 ${CONFIG_PATH}
  代码默认值

对话框内快捷键:
  Enter           发送
  行尾 \\ + Enter   换行（也可直接粘贴多行）
  ← → ↑ ↓         移动光标
  Ctrl+A / Ctrl+E 行首 / 行尾
  Ctrl+U          删到行首
  Esc             清空输入
  Ctrl+C 两次      退出
`)
  process.exit(0)
}

if (argv[0] === '--config') {
  const raw = loadRawConfig()
  const effective = loadConfig()
  console.log(`配置文件: ${CONFIG_PATH}\n`)
  console.log('──────── 文件内容（~/.ai/config.json） ────────')
  console.log(JSON.stringify(raw, null, 2))
  console.log('')
  console.log('──────── 生效值（环境变量 / 文件 / 默认值） ────────')
  console.log(`  provider = ${effective.provider || '(未设置)'}`)
  console.log(`  apiKey   = ${effective.apiKey ? '****' + effective.apiKey.slice(-4) : '(未设置)'}`)
  console.log(`  model    = ${effective.model}`)
  console.log(`  baseURL  = ${effective.baseURL}`)
  process.exit(0)
}

if (argv[0] === '--set-key') {
  const key = argv[1]
  if (!key) {
    console.error('用法: ai --set-key <KEY>')
    process.exit(1)
  }
  saveApiKey(key)
  console.log(`✓ 已保存 API key 到 ${CONFIG_PATH}`)
  process.exit(0)
}

if (argv[0] === '--set-model') {
  const model = argv[1]
  if (!model) {
    console.error('用法: ai --set-model <MODEL>    例: ai --set-model deepseek-chat')
    process.exit(1)
  }
  saveModel(model)
  console.log(`✓ 已保存 model = ${model} 到 ${CONFIG_PATH}`)
  process.exit(0)
}

if (argv[0] === '--set-base-url') {
  const url = argv[1]
  if (!url) {
    console.error('用法: ai --set-base-url <URL>    例: ai --set-base-url https://api.deepseek.com')
    process.exit(1)
  }
  saveBaseURL(url)
  console.log(`✓ 已保存 baseURL = ${url} 到 ${CONFIG_PATH}`)
  process.exit(0)
}

if (argv[0] === '--set-provider') {
  const name = argv.slice(1).join(' ').trim()
  if (!name) {
    console.error('用法: ai --set-provider <名称>    例: ai --set-provider OpenAI')
    process.exit(1)
  }
  saveProvider(name)
  console.log(`✓ 已保存 provider = ${name} 到 ${CONFIG_PATH}`)
  process.exit(0)
}

if (argv[0] === '--set-qq-app') {
  const [, appId, secret] = argv
  if (!appId || !secret) {
    console.error('用法: ai --set-qq-app <AppID> <AppSecret>')
    process.exit(1)
  }
  saveQQConfig({ appId, secret })
  console.log('已保存 QQ 机器人 AppID / AppSecret。')
  process.exit(0)
}

if (argv[0] === '--qq-allow') {
  if (!argv[1]) {
    console.error('用法: ai --qq-allow <openid>')
    process.exit(1)
  }
  const list = addQQAllow(argv[1])
  console.log(`白名单已更新: ${list.join(', ')}`)
  process.exit(0)
}

if (argv[0] === '--set-wechat') {
  const [, corpId, agentId, secret, token, aesKey] = argv
  if (!corpId || !agentId || !secret || !token || !aesKey) {
    console.error('用法: ai --set-wechat <CorpID> <AgentId> <Secret> <Token> <EncodingAESKey>')
    process.exit(1)
  }
  if (aesKey.length !== 43) {
    console.error(`EncodingAESKey 应为 43 位，当前 ${aesKey.length} 位，请检查。`)
    process.exit(1)
  }
  saveWechatConfig({ corpId, agentId, secret, token, aesKey })
  console.log('已保存企业微信凭据。')
  process.exit(0)
}

if (argv[0] === '--set-smtp') {
  const [, user, pass, host, port] = argv
  if (!user || !pass) {
    console.error('用法: ai --set-smtp <邮箱> <应用专用密码> [host] [port]')
    console.error('例:   ai --set-smtp you@gmail.com abcd-efgh-ijkl-mnop')
    process.exit(1)
  }
  const patch: Record<string, unknown> = { user, pass, from: user }
  if (host) patch.host = host
  if (port) {
    patch.port = Number(port)
    patch.secure = Number(port) === 465 // 465=隐式TLS，587=STARTTLS
  }
  saveSmtpConfig(patch)
  console.log(`已保存发件邮箱 ${user}（${host ?? 'smtp.gmail.com'}:${port ?? 465}）。`)
  process.exit(0)
}

if (argv[0] === 'email') {
  const [, to, subject, ...rest] = argv
  const body = rest.join(' ')
  if (!to || !subject) {
    console.error('用法: ai email <收件人> <主题> <正文>')
    process.exit(1)
  }
  const smtp = loadSmtpConfig()
  if (!smtp.user || !smtp.pass) {
    console.error('未配置发件邮箱。先运行: ai --set-smtp <邮箱> <应用专用密码> [host] [port]')
    process.exit(1)
  }
  try {
    const sent = await sendMail(
      { host: smtp.host, port: smtp.port, secure: smtp.secure, user: smtp.user, pass: smtp.pass, from: smtp.from! },
      { to: to.split(',').map(s => s.trim()).filter(Boolean), subject, text: body },
    )
    console.log(`✓ 已发送给 ${sent.join(', ')}`)
    process.exit(0)
  } catch (e: any) {
    console.error(`✗ 发送失败: ${e?.message ?? String(e)}`)
    process.exit(1)
  }
}

if (argv[0] === 'stock') {
  const symbols = (argv[1] ?? '').split(',').map(s => s.trim()).filter(Boolean)
  if (!symbols.length) {
    console.error('用法: ai stock <代码[,代码...]>   例: ai stock AAPL,TSLA')
    process.exit(1)
  }
  const results = await getQuotes(symbols)
  for (const r of results) console.log(r.quote ? formatQuote(r.quote) : `${r.symbol}: ${r.error}`)
  process.exit(0)
}

if (argv[0] === '--set-stocks-notify') {
  const v = argv[1]
  const map: Record<string, ('email' | 'terminal')[]> = {
    email: ['email'],
    terminal: ['terminal'],
    both: ['email', 'terminal'],
  }
  if (!v || !map[v]) {
    console.error('用法: ai --set-stocks-notify <email|terminal|both>')
    process.exit(1)
  }
  saveStocksConfig({ notify: map[v] })
  console.log(`已设置美股告警渠道: ${map[v].join('+')}`)
  process.exit(0)
}

if (argv[0] === '--set-stocks-email') {
  const addrs = (argv[1] ?? '').split(',').map(s => s.trim()).filter(Boolean)
  if (!addrs.length) {
    console.error('用法: ai --set-stocks-email <邮箱[,邮箱...]>')
    process.exit(1)
  }
  saveStocksConfig({ emailTo: addrs.join(',') })
  console.log(`已设置告警收件人: ${addrs.join(', ')}`)
  process.exit(0)
}

if (argv[0] === 'watch') {
  const sub = argv[1]

  if (sub === 'list' || sub === 'ls') {
    const cfg = loadStocksConfig()
    if (!cfg.watch.length) console.log('监控列表为空。用 ai watch add <代码> [above=N] [below=N] [chg=P] 添加。')
    else {
      console.log(`监控 ${cfg.watch.length} 只 · 每 ${cfg.pollSeconds}s · 告警: ${cfg.notify.join('+')}`)
      for (const r of cfg.watch) {
        const cond = [r.above != null ? `≥${r.above}` : '', r.below != null ? `≤${r.below}` : '', r.chgPct != null ? `±${r.chgPct}%` : ''].filter(Boolean).join(' / ')
        console.log(`  · ${r.symbol}  ${cond || '(无条件)'}`)
      }
    }
    process.exit(0)
  }

  if (sub === 'add') {
    const symbol = argv[2]
    if (!symbol) {
      console.error('用法: ai watch add <代码> [above=N] [below=N] [chg=P]')
      process.exit(1)
    }
    const rule: Record<string, unknown> = { symbol }
    for (const tok of argv.slice(3)) {
      const [k, raw] = tok.split('=')
      const n = Number(raw)
      if (Number.isNaN(n)) continue
      if (k === 'above') rule.above = n
      else if (k === 'below') rule.below = n
      else if (k === 'chg' || k === 'chgPct') rule.chgPct = n
    }
    const list = upsertStockRule(rule as any)
    console.log(`已添加/更新 ${symbol.toUpperCase()}。当前监控 ${list.length} 只。`)
    process.exit(0)
  }

  if (sub === 'rm' || sub === 'remove') {
    if (!argv[2]) {
      console.error('用法: ai watch rm <代码>')
      process.exit(1)
    }
    const list = removeStockRule(argv[2])
    console.log(`已删除 ${argv[2].toUpperCase()}。剩余 ${list.length} 只。`)
    process.exit(0)
  }

  // 无子命令（或未识别子命令）落到下方主调度，启动监控守护进程。
}

const config = loadConfig()

// ———————————————————————————————————————————————
// 界面组件
// ———————————————————————————————————————————————
type UIMessage = { id: number; role: 'user' | 'assistant' | 'tool'; content: string }

// 单条消息行：memo 化，role/content 不变就不重绘。
const MessageRow = memo(({ role, content }: { role: string; content: string }) => {
  if (role === 'user') {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text color="cyan" bold>
          › {content}
        </Text>
      </Box>
    )
  }
  if (role === 'tool') {
    return (
      <Box flexDirection="column" marginBottom={0}>
        <Text color="yellow" dimColor>
          ⚙ {content}
        </Text>
      </Box>
    )
  }
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>{content}</Text>
    </Box>
  )
})

// 消息列表：整体 memo，只要 messages 引用不变就完全不重渲染。
// 这样 Spinner tick 不会触发消息区的 reconciliation。
const MessageList = memo(({ messages }: { messages: UIMessage[] }) => (
  <>
    {messages.map(m => (
      <MessageRow key={m.id} role={m.role} content={m.content} />
    ))}
  </>
))

// 头部信息：memo，只有 model/baseURL 变化才重绘（基本不会）。
const Header = memo(({ model, baseURL }: { model: string; baseURL: string }) => (
  <Box marginBottom={1} flexDirection="column">
    <Text color="cyan" bold>
      ✦ ai
    </Text>
    <Text dimColor>
      {model} · {baseURL} — Enter 发送，行尾 \ 换行，Ctrl+C 两次退出
    </Text>
  </Box>
))

// Spinner：用 ref 代替 state 来跟踪帧索引，避免每 150ms 触发父组件重渲染。
// 仅通过直接调度自身重渲染来更新画面。
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

const Spinner = memo(() => {
  const [i, setI] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setI(x => (x + 1) % SPINNER_FRAMES.length), 150)
    return () => clearInterval(id)
  }, [])
  return <Text color="cyan">{SPINNER_FRAMES[i]}</Text>
})

function App() {
  const { exit } = useApp()
  const [apiKey, setApiKey] = useState<string | undefined>(config.apiKey)
  const [messages, setMessages] = useState<UIMessage[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const lastCtrlC = useRef(0)
  const abortRef = useRef<AbortController | null>(null)
  const historyRef = useRef<ChatMessage[]>([{ role: 'system', content: SYSTEM_PROMPT }])
  // 自增 id：给每条消息一个稳定 key，避免数组索引漂移引发不必要的重绘。
  const idRef = useRef(0)

  // Ctrl+C：一次中断生成，连按两次退出
  useInput((_input, key) => {
    if (key.ctrl && _input === 'c') {
      if (busy && abortRef.current) {
        abortRef.current.abort()
        return
      }
      const now = Date.now()
      if (now - lastCtrlC.current < 1000) {
        exit()
      } else {
        lastCtrlC.current = now
        setError('再按一次 Ctrl+C 退出')
        setTimeout(() => setError(null), 1000)
      }
    }
  })

  const send = useCallback(
    async (text: string) => {
      setError(null)
      const uid = ++idRef.current
      setMessages(prev => [...prev, { id: uid, role: 'user', content: text }])
      setBusy(true)

      const history = historyRef.current
      history.push({ role: 'user', content: text })

      const controller = new AbortController()
      abortRef.current = controller
      const answers: string[] = []
      try {
        for await (const ev of runAgent(history, {
          apiKey: apiKey!,
          model: config.model,
          baseURL: config.baseURL,
          provider: config.provider,
          signal: controller.signal,
        })) {
          if (ev.type === 'text') {
            const mid = ++idRef.current
            setMessages(prev => [...prev, { id: mid, role: 'assistant', content: ev.content }])
            answers.push(ev.content)
          } else {
            const mid = ++idRef.current
            setMessages(prev => [...prev, { id: mid, role: 'tool', content: ev.summary }])
          }
        }
        logChat({ channel: 'terminal', sessionId: 'terminal', question: text, answer: answers.join('\n') })
      } catch (e: any) {
        if (controller.signal.aborted) {
          const mid = ++idRef.current
          setMessages(prev => [...prev, { id: mid, role: 'assistant', content: '[已中断]' }])
          logChat({ channel: 'terminal', sessionId: 'terminal', question: text, answer: '[已中断]' })
        } else {
          setError(e?.message ?? String(e))
          logChat({ channel: 'terminal', sessionId: 'terminal', question: text, answer: `[错误] ${e?.message ?? String(e)}` })
        }
      } finally {
        setBusy(false)
        abortRef.current = null
      }
    },
    [apiKey],
  )

  // header props 用 useMemo 稳定引用，避免传给 memo(Header) 时每帧都是新对象
  const headerProps = useMemo(
    () => ({ model: config.model, baseURL: config.baseURL }),
    [config.model, config.baseURL],
  )

  // 缺少 key：启动时引导用户输入并保存
  if (!apiKey) {
    return (
      <KeyPrompt
        onSave={k => {
          saveApiKey(k)
          setApiKey(k)
        }}
      />
    )
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      {/* 头部 — memo 后只在 model/baseURL 变化时重绘 */}
      <Header {...headerProps} />

      {/* 历史消息 — 整个列表 memo，只在 messages 数组引用变化时才重绘 */}
      <MessageList messages={messages} />

      {/* 正在工作 */}
      {busy && (
        <Box flexDirection="column" marginBottom={1}>
          <Text dimColor>
            <Spinner /> 工作中…
          </Text>
        </Box>
      )}

      {/* 错误 */}
      {error && (
        <Box marginBottom={1}>
          <Text color="red">⚠ {error}</Text>
        </Box>
      )}

      {/* 输入框 */}
      <MultilineInput
        onSubmit={send}
        disabled={busy}
        placeholder="问点什么…（Ctrl+C 两次退出）"
      />
    </Box>
  )
}

// 首次启动 / 缺少 key 时的引导界面
function KeyPrompt({ onSave }: { onSave: (key: string) => void }) {
  const [err, setErr] = useState<string | null>(null)

  const submit = useCallback(
    (raw: string) => {
      const key = raw.trim()
      if (!key) {
        setErr('请输入 key（粘贴后按 Enter）')
        return
      }
      onSave(key)
    },
    [onSave],
  )

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1} flexDirection="column">
        <Text color="cyan" bold>
          ✦ ai · 首次设置
        </Text>
        <Text dimColor>没有检测到 API key，先把它填进来吧。</Text>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <Text>1. 到你所用服务商的控制台申请并复制 API key</Text>
        <Text dimColor>
          （默认对接 {DEFAULT_BASE_URL}；如需换服务商，先 ai --set-base-url 与 ai --set-model）。
        </Text>
        <Text>
          2. 在下面粘贴，按 <Text bold>Enter</Text> 保存。
        </Text>
        <Text dimColor>
          会写入 {CONFIG_PATH}（仅自己可读）；之后再启动就直接进对话。
        </Text>
      </Box>

      {err && (
        <Box marginBottom={1}>
          <Text color="yellow">⚠ {err}</Text>
        </Box>
      )}

      <Box>
        <Text color="cyan">key › </Text>
        <MultilineInput onSubmit={submit} placeholder="粘贴 API key…" />
      </Box>
    </Box>
  )
}

if (argv[0] === 'serve') {
  const { startQQ } = await import('./channels/qq.js')
  startQQ()
} else if (argv[0] === 'push') {
  const msg = argv.slice(1).join(' ').trim()
  if (!msg) {
    console.error('用法: ai push <消息内容>')
    process.exit(1)
  }
  const { qqPush } = await import('./channels/qq.js')
  await qqPush(msg)
  process.exit(0)
} else if (argv[0] === 'wechat') {
  const { startWechat } = await import('./channels/wechat.js')
  startWechat()
} else if (argv[0] === 'watch') {
  const { startWatch } = await import('./channels/watch.js')
  startWatch()
} else {
  const instance = render(<App />)

  const bail = (label: string) => (err: unknown) => {
    const logPath = writeCrash(label, err)
    try {
      instance.unmount()
    } catch {
      /* 卸载失败也要继续恢复终端 */
    }
    process.stdout.write('\x1b[?25h')
    console.error(`\nai 遇到了意外错误（${label}）。详细日志（含最近按键）已写入：`)
    console.error(`  ${logPath}`)
    console.error(err instanceof Error ? err.stack ?? err.message : String(err))
    process.exit(1)
  }
  process.on('uncaughtException', bail('uncaughtException'))
  process.on('unhandledRejection', bail('unhandledRejection'))
}
