import { readFileSync } from 'fs'
import { useState, useRef, useCallback, useEffect, memo, useMemo } from 'react'
import { render, Box, Text, useApp, useInput, Static } from 'ink'
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
  addWxAllow,
  saveSmtpConfig,
  loadSmtpConfig,
  saveDoubaoTtsConfig,
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
import { loadSkills, readSkill, scaffoldSkill } from './skills.js'
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
  ai ask <问题>             非交互单轮问答，答案直接打印到 stdout（脚本/管道场景用）
  ai ask --file <问题文件>  同上，问题内容从文件读取
  ai serve                 启动 QQ 官方机器人（q.qq.com 开放平台，白名单内可操控 agent）
  ai push <消息>           主动给白名单用户发一条 QQ 消息（官方限单聊每月 4 条）
  ai email <收件人> <主题> <正文>  用已配置的 SMTP 邮箱发一封邮件（收件人多个用逗号分隔）
  ai stock <代码[,代码...]>  查询美股实时报价（Yahoo Finance），例: ai stock AAPL,TSLA
  ai watch                 启动美股监控守护进程（按自选规则轮询，触发告警）
  ai watch list            查看当前监控规则
  ai watch add <代码> [above=N] [below=N] [chg=P] [email=addr]  添加/更新一条监控规则（email=addr 指定本规则专属收件人，不设则用全局）
  ai watch rm <代码>       删除一条监控规则
  ai --set-stocks-notify <email|terminal|both>  设置告警渠道（默认 both）
  ai --set-stocks-email <邮箱[,邮箱...]>  设置告警邮件收件人（多个用逗号分隔）
  ai wechat                启动企业微信回调服务（配合 cloudflared 隧道接入企业微信）
  ai --set-wechat <CorpID> <AgentId> <Secret> <Token> <EncodingAESKey>  保存企业微信凭据
  ai wx-login              扫码绑定个人微信（微信官方 ilink 机器人协议，无需服务器/内网穿透）
  ai wx                    启动个人微信服务（长轮询收发消息，白名单内可操控 agent）
  ai --wx-allow <ilink_user_id>  往个人微信白名单追加一个用户（未授权用户发消息会回显其标识）
  ai --set-smtp <邮箱> <应用专用密码> [host] [port]  保存发件邮箱（默认 smtp.gmail.com:465）
  ai --set-doubao-tts appid=.. token=.. [voice=..] [voice_zh=..] [voice_en=..] [voice_other=..]  保存豆包(火山引擎)语音合成大模型凭据，按文本语种选音色，QQ 语音回复优先用它（未配则退回本机 say）；均为 key=value，只传要改的字段
  ai --set-key <KEY>       保存 API key 到 ${CONFIG_PATH}
  ai --set-model <MODEL>   保存模型名到 ${CONFIG_PATH}（默认 ${DEFAULT_MODEL}）
  ai --set-base-url <URL>  保存 API 地址到 ${CONFIG_PATH}（默认 ${DEFAULT_BASE_URL}）
  ai --set-provider <名称>  保存服务商显示名（仅用于界面/报错，如 OpenAI、通义千问）
  ai --set-qq-app <ID> <SECRET>  保存 QQ 机器人 AppID 和 AppSecret
  ai --qq-allow <openid>   往 QQ 白名单追加一个 openid（可多次；未授权用户发消息会回显其 openid）
  ai --config              查看当前生效的完整配置（含默认值、文件值、环境变量）
  ai --skills              列出已安装的技能（skill，可复用的操作手册）
  ai --skill-show <名字>    打印某个技能的完整正文（审查/测试下载来的技能用）
  ai --skill-new <名字>     新建一个技能模板到 ~/.ai/skills/<名字>/SKILL.md
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

if (argv[0] === '--skills') {
  const skills = loadSkills()
  if (!skills.length) {
    console.log(
      '暂无技能。\n用 ai --skill-new <名字> 新建一个，或在 ~/.ai/skills/<名字>/SKILL.md（全局）' +
        '、<项目>/.ai/skills/<名字>/SKILL.md（项目本地）放一个带 frontmatter 的 markdown。',
    )
  } else {
    console.log(`已安装 ${skills.length} 个技能：\n`)
    for (const s of skills) {
      console.log(`  ${s.name}  [${s.source === 'project' ? '项目本地' : '用户全局'}]`)
      console.log(`    ${s.description || '(无描述)'}`)
      console.log(`    ${s.path}\n`)
    }
  }
  process.exit(0)
}

if (argv[0] === '--skill-show') {
  const name = argv[1]
  if (!name) {
    console.error('用法: ai --skill-show <名字>    （打印模型实际会读到的完整正文，便于审查/测试下载来的技能）')
    process.exit(1)
  }
  const found = readSkill(name)
  if (!found) {
    console.error(`未找到技能「${name}」。先用 ai --skills 看已安装的技能名。`)
    process.exit(1)
  }
  console.log(`名字: ${found.meta.name}`)
  console.log(`来源: ${found.meta.source === 'project' ? '项目本地' : '用户全局'}`)
  console.log(`描述: ${found.meta.description || '(无描述 —— 缺 description，模型清单里会显示“无描述”)'}`)
  console.log(`路径: ${found.meta.path}`)
  console.log('\n──────── 正文（skill 工具返回给模型的内容） ────────\n')
  console.log(found.body || '(正文为空)')
  process.exit(0)
}

if (argv[0] === '--skill-new') {
  const name = argv[1]
  if (!name) {
    console.error('用法: ai --skill-new <名字>    例: ai --skill-new release-notes')
    process.exit(1)
  }
  try {
    const file = scaffoldSkill(name)
    console.log(`已创建技能模板: ${file}\n用编辑器打开它，填好 description 与正文步骤即可（下次对话自动生效）。`)
  } catch (e: any) {
    console.error(e?.message ?? String(e))
    process.exit(1)
  }
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

if (argv[0] === '--wx-allow') {
  if (!argv[1]) {
    console.error('用法: ai --wx-allow <ilink_user_id>')
    process.exit(1)
  }
  const list = addWxAllow(argv[1])
  console.log(`白名单已更新: ${list.join(', ')}`)
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

if (argv[0] === '--set-doubao-tts') {
  // 全部 key=value、全部可选、只合并不整体覆盖——单独改音色时不会误把 appid/token 顶掉。
  const kv: Record<string, string> = {}
  for (const arg of argv.slice(1)) {
    const eq = arg.indexOf('=')
    if (eq > 0) kv[arg.slice(0, eq)] = arg.slice(eq + 1)
  }
  if (!Object.keys(kv).length) {
    console.error(
      '用法: ai --set-doubao-tts appid=<appid> token=<token> [voice=<默认音色>] [voice_zh=<中文音色>] [voice_en=<英文音色>] [voice_other=<其他语种音色>] [resource_id=<覆盖自动推断>] [secret_key=<预留>]',
    )
    console.error('appid/token 在火山引擎控制台「语音技术」应用的服务接口认证信息里获取。')
    console.error('每项都是 key=value，只传要改的字段即可（如只改音色，不用重传 appid/token）。')
    console.error('例: ai --set-doubao-tts appid=xxx token=xxx voice_zh=ICL_zh_male_wenrouxuezhang_tob voice_en=en_male_hades_moon_bigtts voice_other=multi_male_xudong_conversation_wvae_bigtts')
    process.exit(1)
  }
  const patch: Record<string, unknown> = {}
  if (kv.appid) patch.appId = kv.appid
  if (kv.token) patch.token = kv.token
  if (kv.voice) patch.voiceType = kv.voice
  if (kv.voice_zh) patch.voiceTypeZh = kv.voice_zh
  if (kv.voice_en) patch.voiceTypeEn = kv.voice_en
  if (kv.voice_other) patch.voiceTypeOther = kv.voice_other
  if (kv.resource_id) patch.resourceId = kv.resource_id
  if (kv.secret_key) patch.secretKey = kv.secret_key
  saveDoubaoTtsConfig(patch)
  console.log(`已更新豆包 TTS 配置字段: ${Object.keys(kv).join(', ')}`)
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

if (argv[0] === 'ask') {
  const rest = argv.slice(1)
  const fileIdx = rest.indexOf('--file')
  let question: string
  if (fileIdx !== -1) {
    const filePath = rest[fileIdx + 1]
    if (!filePath) {
      console.error('用法: ai ask --file <问题文件路径>')
      process.exit(1)
    }
    try {
      question = readFileSync(filePath, 'utf-8')
    } catch (e: any) {
      console.error(`✗ 读取问题文件失败: ${e?.message ?? String(e)}`)
      process.exit(1)
    }
  } else {
    question = rest.join(' ')
  }
  if (!question.trim()) {
    console.error('用法: ai ask <问题>\n      ai ask --file <问题文件路径>')
    process.exit(1)
  }

  const cfg = loadConfig()
  if (!cfg.apiKey) {
    console.error('未配置 API key。先运行: ai --set-key <KEY>')
    process.exit(1)
  }

  const history: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(process.cwd(), 'terminal') },
    { role: 'user', content: question },
  ]

  const answers: string[] = []
  try {
    for await (const ev of runAgent(history, {
      apiKey: cfg.apiKey,
      model: cfg.model,
      baseURL: cfg.baseURL,
      provider: cfg.provider,
    })) {
      if (ev.type === 'text') {
        answers.push(ev.content)
      } else if (ev.type === 'tool') {
        console.error(`⚙ ${ev.summary}`)
      } else if (ev.type === 'limit') {
        console.error(`⏸ 已连续执行 ${ev.steps} 步仍未结束。`)
      }
    }
    const answer = answers.join('\n')
    console.log(answer)
    logChat({ channel: 'terminal', sessionId: 'ask', question, answer })
    process.exit(0)
  } catch (e: any) {
    console.error(`✗ 出错: ${e?.message ?? String(e)}`)
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
        const email = r.emailTo ? `→ ${r.emailTo}` : `(全局收件人)`
        console.log(`  · ${r.symbol}  ${cond || '(无条件)'}  ${email}`)
      }
    }
    process.exit(0)
  }

  if (sub === 'add') {
    const symbol = argv[2]
    if (!symbol) {
      console.error('用法: ai watch add <代码> [above=N] [below=N] [chg=P] [email=addr]')
      process.exit(1)
    }
    const rule: Record<string, unknown> = { symbol }
    for (const tok of argv.slice(3)) {
      const eq = tok.indexOf('=')
      if (eq === -1) continue
      const k = tok.slice(0, eq)
      const raw = tok.slice(eq + 1)
      if (k === 'email') {
        rule.emailTo = raw
        continue
      }
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
// role 说明：
//   user           —— 用户输入
//   assistant      —— 一整段助手文本（中断/兜底等少数场景）
//   assistant-line —— 助手流式文本被「逐行沉淀」进历史的单行（动态区只留未完成的尾巴）
//   tool           —— 工具进度
// gap：该行底部是否留一行间距（段落收尾用）。
type UIMessage = {
  id: number
  role: 'user' | 'assistant' | 'assistant-line' | 'tool'
  content: string
  gap?: boolean
}

// 单条消息行：memo 化，props 不变就不重绘。
const MessageRow = memo(({ role, content, gap }: { role: string; content: string; gap?: boolean }) => {
  if (role === 'user') {
    return (
      <Box marginBottom={1}>
        <Text color="cyan" bold>
          ❯ {content}
        </Text>
      </Box>
    )
  }
  if (role === 'tool') {
    // 失败行（✗ 开头）用红色凸显，普通进度行维持暗黄。
    const failed = content.startsWith('✗')
    return (
      <Box marginBottom={0}>
        <Text color={failed ? 'red' : 'yellow'} dimColor={!failed}>
          {failed ? '' : '⚙ '}{content}
        </Text>
      </Box>
    )
  }
  if (role === 'assistant-line') {
    // 空行也要占一行高度，保留段落间的视觉间隔。
    return (
      <Box marginBottom={gap ? 1 : 0}>
        <Text>{content.length ? content : ' '}</Text>
      </Box>
    )
  }
  return (
    <Box marginBottom={1}>
      <Text>{content}</Text>
    </Box>
  )
})

// 消息列表：整体 memo，只要 messages 引用不变就完全不重渲染。
// 这样 Spinner tick 不会触发消息区的 reconciliation。
// 头部信息：memo，只有 model/baseURL 变化才重绘（基本不会）。
const Header = memo(({ model, baseURL }: { model: string; baseURL: string }) => (
  <Box marginBottom={1} flexDirection="column">
    <Text color="cyan" bold>
      ✦ ai
    </Text>
    <Text dimColor>
      {model} · {baseURL}
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

// 取文本「末尾若干行」，按终端列宽把自动换行也算进占用行数。
// 用途：底部那截「正在生成、尚未成行」的流式尾巴限高，绝不让它撑爆动态区、
// 把输入框顶到屏幕最上方。完整内容会逐行沉淀进上方历史，这里只截断实时预览，不丢信息。
function tailByRows(text: string, maxRows: number, cols: number): { shown: string; truncated: boolean } {
  const logical = text.split('\n')
  const width = Math.max(1, cols)
  const out: string[] = []
  let used = 0
  for (let i = logical.length - 1; i >= 0; i--) {
    const line = logical[i]
    const wrapped = Math.max(1, Math.ceil(line.length / width)) // 空行也占 1 行
    if (used + wrapped > maxRows && out.length > 0) break
    out.unshift(line)
    used += wrapped
    if (used >= maxRows) break
  }
  return { shown: out.join('\n'), truncated: out.length < logical.length }
}

function App() {
  const { exit } = useApp()
  const [apiKey, setApiKey] = useState<string | undefined>(config.apiKey)
  const [messages, setMessages] = useState<UIMessage[]>([])
  // 正在流式输出的助手草稿：实时打字机效果，定稿后并入 messages（Static）并清空。
  const [streaming, setStreaming] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const lastCtrlC = useRef(0)
  const abortRef = useRef<AbortController | null>(null)
  const historyRef = useRef<ChatMessage[]>([{ role: 'system', content: SYSTEM_PROMPT }])
  // 自增 id：给每条消息一个稳定 key，避免数组索引漂移引发不必要的重绘。
  const idRef = useRef(0)
  // 流式「未完成的最后一行」。完整行随到随沉淀进上方 Static 历史，动态区只留这截尾巴，
  // 让底部输入框高度恒定、使用过程中不跳顶（对标 Claude Code）。ref 同步、避免批处理丢字。
  const streamTailRef = useRef('')

  // Esc：生成中按一下即中断当前任务（不退出程序）。
  // Ctrl+C：忙时一次中断生成，空闲时连按两次退出。
  useInput((_input, key) => {
    if (key.escape) {
      if (busy && abortRef.current) {
        abortRef.current.abort()
      }
      return
    }
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

      // 往 Static 历史追加一行（统一分配稳定 key）。
      const pushRow = (role: UIMessage['role'], content: string, gap = false) =>
        setMessages(prev => [...prev, { id: ++idRef.current, role, content, gap }])
      // 把「未完成的尾巴」收口：作为一行沉淀进历史，清空动态区。gap=true 段尾留白。
      const commitTail = (gap: boolean) => {
        const t = streamTailRef.current
        streamTailRef.current = ''
        setStreaming('')
        if (t.length) pushRow('assistant-line', t, gap)
      }

      streamTailRef.current = ''
      try {
        for await (const ev of runAgent(history, {
          apiKey: apiKey!,
          model: config.model,
          baseURL: config.baseURL,
          provider: config.provider,
          signal: controller.signal,
        })) {
          if (ev.type === 'delta') {
            // 流式增量：拼到尾巴上，每凑满一整行（遇 \n）就立刻沉淀进 Static 历史，
            // 动态区永远只剩最后一截没写完的行 —— 这是底部输入框使用中不跳顶的关键。
            let tail = streamTailRef.current + ev.content
            let nl = tail.indexOf('\n')
            while (nl !== -1) {
              pushRow('assistant-line', tail.slice(0, nl))
              tail = tail.slice(nl + 1)
              nl = tail.indexOf('\n')
            }
            streamTailRef.current = tail
            setStreaming(tail)
          } else if (ev.type === 'text') {
            // 一段文本收口：把剩余尾巴沉淀，段尾留一行间距。完整内容已逐行进历史，
            // 这里不再重复 push 整段，只取 ev.content 做日志。
            commitTail(true)
            answers.push(ev.content)
          } else if (ev.type === 'limit') {
            // 撞到步数上限：提示而非硬停，回复「继续」即可再跑一轮。
            commitTail(true)
            pushRow('tool', `⏸ 已连续执行 ${ev.steps} 步仍未结束。回复「继续」可再跑一轮。`)
          } else {
            // 工具进度：先把已说的话收口，再追加进度行。
            commitTail(true)
            pushRow('tool', ev.summary)
          }
        }
        logChat({ channel: 'terminal', sessionId: 'terminal', question: text, answer: answers.join('\n') })
      } catch (e: any) {
        if (controller.signal.aborted) {
          commitTail(true) // 中断前先把已生成的尾巴留住
          pushRow('assistant', '[已中断]')
          logChat({ channel: 'terminal', sessionId: 'terminal', question: text, answer: '[已中断]' })
        } else {
          commitTail(true)
          setError(e?.message ?? String(e))
          logChat({ channel: 'terminal', sessionId: 'terminal', question: text, answer: `[错误] ${e?.message ?? String(e)}` })
        }
      } finally {
        commitTail(true) // 兜底：任何残留尾巴都不丢
        setBusy(false)
        streamTailRef.current = ''
        setStreaming('')
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

  // Static 的数据源：头部固定为第一行，其后是所有历史消息。
  // 每个元素只会被 Ink 写入终端一次，因此这部分永远不参与重绘。
  type StaticRow = { kind: 'header' } | { kind: 'msg'; msg: UIMessage }
  const staticRows = useMemo<StaticRow[]>(
    () => [{ kind: 'header' }, ...messages.map(msg => ({ kind: 'msg' as const, msg }))],
    [messages],
  )

  // 流式尾巴正常只有一行；但模型若长时间不吐换行，这一「逻辑行」也可能很长，
  // 自动换行后撑高动态区。按终端高度兜底截断，保证动态区永不超出屏幕、输入框不跳顶。
  // 预留 ~9 行给 spinner、错误行、带边框输入框、页脚提示和各处 margin。
  const termRows = process.stdout.rows || 24
  const termCols = (process.stdout.columns || 80) - 2 // 容器 paddingX=1，左右各 1
  const stream = streaming
    ? tailByRows(streaming, Math.max(3, termRows - 9), termCols)
    : { shown: '', truncated: false }

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
      {/* 头部 + 历史消息 — 用 Static 渲染：每条只往终端写一次，永不重绘。
          这才是根除闪烁的关键：Spinner 每 120ms 触发的重渲染只会重画下方
          的动态区（spinner + 输入框），不再连带重画整段历史。 */}
      <Static items={staticRows}>
        {row =>
          row.kind === 'header' ? (
            <Header key="header" {...headerProps} />
          ) : (
            <MessageRow key={row.msg.id} role={row.msg.role} content={row.msg.content} gap={row.msg.gap} />
          )
        }
      </Static>

      {/* —— 动态区：高度恒定的底栏，已生成内容都已逐行沉淀进上方 Static —— */}

      {/* 流式尾巴 — 当前正在打字、尚未凑满一整行的最后一截（已成行的都在上方历史里）。 */}
      {streaming && (
        <Box marginBottom={1}>
          <Text>{stream.shown}</Text>
        </Box>
      )}

      {/* 正在工作 — 细长一行，紧贴输入框上方 */}
      {busy && (
        <Box marginBottom={streaming ? 0 : 1}>
          <Text dimColor>
            <Spinner /> 思考中…（Esc 中断）
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
      <MultilineInput onSubmit={send} disabled={busy} placeholder="问点什么…" />

      {/* 常驻页脚提示 */}
      <Box paddingX={1}>
        <Text dimColor>
          {config.model} · Enter 发送 · 行尾 \ 换行 · Esc 中断 · Ctrl+C×2 退出
        </Text>
      </Box>
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
} else if (argv[0] === 'wx-login') {
  const { setupWx } = await import('./channels/wx.js')
  await setupWx()
  process.exit(0)
} else if (argv[0] === 'wx') {
  const { startWx } = await import('./channels/wx.js')
  startWx()
} else if (argv[0] === 'watch') {
  const { startWatch } = await import('./channels/watch.js')
  startWatch()
} else {
  // exitOnCtrlC: false —— 关掉 Ink 内置的「Ctrl+C 即退出」，把控制权交给 useInput，
  // 否则第一次 Ctrl+C 就被 Ink 直接退出了，下面的「连按两次才退出」逻辑根本来不及生效。
  const instance = render(<App />, { exitOnCtrlC: false })

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
