import { readFileSync } from 'fs'
import { spawn } from 'node:child_process'
import packageJson from '../package.json' with { type: 'json' }
import {
  useState,
  useRef,
  useCallback,
  useEffect,
  useInsertionEffect,
  memo,
  useMemo,
  type ReactNode,
} from 'react'
import { render, Box, Text, useApp, useInput, Static } from 'ink'
import MultilineInput from './MultilineInput.js'
import { chatComplete, type ChatMessage } from './llm.js'
import {
  loadConfig,
  loadRawConfig,
  saveApiKey,
  saveModel,
  saveBaseURL,
  saveProvider,
  loadModels,
  saveModelProfile,
  removeModelProfile,
  switchModel,
  switchAllChannelModels,
  type ModelChannel,
  type ModelProfile,
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
  modelNeedsApiKey,
} from './config.js'
import { sendMail } from './smtp.js'
import { getQuotes, formatQuote } from './stocks.js'
import { runAgent } from './agent/engine.js'
import { createHistoryTraceContext, traceHistory } from './agent/history-trace.js'
import { formatWorkedFor } from './duration.js'
import { buildSystemPrompt } from './agent/session.js'
import { loadSkills, readSkill, scaffoldSkill } from './skills.js'
import { logChat, writeLogBanner } from './agent/chatlog.js'
import { writeCrash } from './crashlog.js'
import {
  createInkInputBridge,
  createScrollbackPreservingStdout,
  clearTerminalAfterInk,
  detectTerminalColorScheme,
  enableBracketedPasteMode,
  prepareTerminalForInk,
  restoreTerminalModes,
  safeTerminalSize,
  setTerminalAlternateScreenActive,
  setTerminalRawModeLock,
  terminalControlEvents,
  terminalMouseEvents,
} from './terminal-io.js'
import {
  addTokenUsage,
  EMPTY_TOKEN_USAGE,
  formatTokenCount,
  formatTokenUsage,
  type TokenUsage,
} from './token-usage.js'
import {
  EMPTY_ACTIVITY_COUNTS,
  activityCategory,
  addActivity,
  activeToolPresentation,
  compactToolResultRows,
  conciseBrowserToolCard,
  conciseShellFailure,
  conciseToolCardResult,
  conciseWebFetchResult,
  formatActivity,
  formatUserPrompt,
  hasActivity,
  parseAgentCardItem,
  recoverableToolFailure,
  type ActivityCounts,
  type AgentCardItem,
} from './ui-activity.js'
import {
  inlineMarkdownSegments,
  compactUrlForDisplay,
  localWebFetchUrl,
  markdownLinePresentation,
  splitRemoteWebTitle,
  terminalHyperlink,
} from './ui-format.js'
import { formatModelStatus, type ModelStatus } from './ui-model-status.js'
import { runMcpCli } from './mcp-cli.js'
import { loadMcpConfiguration, summarizeMcpServer } from './mcp.js'
import {
  anchoredTranscriptOffset,
  BufferedTranscriptLedger,
  isKeyTool,
  parseSgrMouseEvents,
  transcriptLines,
  transcriptViewport,
  type TranscriptEvent,
  type TranscriptEventKind,
  type TranscriptLine,
} from './ui-transcript.js'

/** 把环境变量字符串转成验证级别（0|1|2），无效值返回 undefined（走 engine 默认值）。 */
function parseVerifyLevel(raw: string | undefined): 0 | 1 | 2 | undefined {
  if (raw == null || raw === '') return undefined
  const n = Number(raw)
  if (n === 0 || n === 1 || n === 2) return n
  return undefined
}

// 启动时写 banner，快速确认日志系统运行
writeLogBanner('terminal', `ai 终端启动，工作目录: ${process.cwd()}`)

const SYSTEM_PROMPT = buildSystemPrompt(process.cwd(), 'terminal')

type UiTheme = {
  scheme: 'dark' | 'light'
  accent: string
  cursorText: string
}

const UI_THEMES: Record<UiTheme['scheme'], UiTheme> = {
  dark: { scheme: 'dark', accent: '#9A7418', cursorText: 'black' },
  light: { scheme: 'light', accent: '#005FAF', cursorText: 'white' },
}
let activeUiTheme = UI_THEMES.dark

// ———————————————————————————————————————————————
// 命令行参数（在渲染界面之前处理）
// ———————————————————————————————————————————————
const argv = process.argv.slice(2)

if (argv[0] === '--version' || argv[0] === '-v' || argv[0] === '-V') {
  console.log(`${packageJson.version} (ai)`)
  process.exit(0)
}

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
  ai --add-model <名字> model=<模型名> baseURL=<地址> [apiKey=<key>] [provider=<服务商>]  保存一个模型预设（不传 apiKey 则切换时沿用当前已保存的 key）
  ai --list-models         列出已保存的模型预设，标注当前生效的那个
  ai --models | --list | --l
                           --list-models 的别名
  ai --model-list          --list-models 的别名
  ai --use-model <名字> [--channel qq|wx|wechat|all]
                           切换默认模型，或单独切换 QQ / 个人微信 / 企业微信（长驻服务无需重启）
  ai --use <名字> | --u <名字>
                           --use-model 的别名（同样支持 --channel）
  ai --rm-model <名字>     删除一个模型预设
  ai --set-qq-app <ID> <SECRET>  保存 QQ 机器人 AppID 和 AppSecret
  ai --qq-allow <openid>   往 QQ 白名单追加一个 openid（可多次；未授权用户发消息会回显其 openid）
  ai --config              查看当前生效的完整配置（含默认值、文件值、环境变量）
  ai --skills              列出已安装的技能（skill，可复用的操作手册）
  ai --skill-show <名字>    打印某个技能的完整正文（审查/测试下载来的技能用）
  ai --skill-new <名字>     新建一个技能模板到 ~/.ai/skills/<名字>/SKILL.md
  ai mcp <add|list|get|test|auth|logout|prompts|remove> ...
                           管理 MCP servers；运行 ai mcp help 查看示例
  ai -v, --version         显示版本号并退出
  ai --help                显示帮助

切换服务商 / 模型（OpenAI 兼容即可，如 OpenAI、通义千问、Moonshot、OpenRouter、本地 Ollama）:
  改 config.json 里的 baseURL / model / apiKey 三项即可，无需改代码。例:
    ai --set-base-url https://api.openai.com/v1
    ai --set-model gpt-4o-mini
    ai --set-key <你的-key>

配置（优先级从高到低）:
  环境变量 AI_API_KEY / AI_MODEL / AI_BASE_URL / AI_PROVIDER / AI_VERIFY_LEVEL
  （兼容旧名 DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL）
  配置文件 ${CONFIG_PATH}
  代码默认值

上下文追踪:
  TRACE=1 ai              同时写入 log/history-trace-full.jsonl 和
                          log/history-trace-summary.jsonl；Remote Claude 额外写入
                          log/remote-communication.jsonl（完整日志可能含敏感内容）

验证级别（AI_VERIFY_LEVEL）:
  0 = 默认：本地确定性校验，不追加模型请求
  1 = 本地校验 + LLM 最终核验（较慢）
  2 = 兼容旧配置，当前等同 1

对话框内命令:
  /models           列出已保存的模型预设
  /models <序号|名字>  切换到某个预设（当场生效，无需重启）
  /btw <问题>       运行中旁问：共享当前上下文、无工具、不打断主任务、不写入历史
  /usage            查看本次会话 input/output/cache/total token
  /usage reset      清零本次会话 token 计数
  /mcp              查看当前目录生效的 MCP servers

对话框内快捷键:
  Enter           发送
  行尾 \\ + Enter   换行（也可直接粘贴多行）
  ← → ↑ ↓         移动光标
  Ctrl+A / Ctrl+E 行首 / 行尾
  Ctrl+U          删到行首
  Esc             清空输入
  运行中 Enter     将下一条 prompt 加入队列，当前任务结束后自动执行
  Ctrl+C 两次      退出
`)
  process.exit(0)
}

if (argv[0] === 'mcp') {
  process.exit(await runMcpCli(argv.slice(1)))
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
  const models = loadModels()
  if (models.length) {
    console.log('')
    console.log(`──────── 模型预设（${models.length} 个，activeModel = ${effective.activeModel || '(未设置)'}） ────────`)
    for (const m of models) {
      console.log(`  ${m.name}  ${m.model} @ ${m.baseURL}${m.provider ? `  (${m.provider})` : ''}`)
    }
    console.log('')
    console.log('──────── 渠道模型（未设置则继承默认模型） ────────')
    for (const channel of ['qq', 'wx', 'wechat'] as const) {
      const channelConfig = loadConfig(channel)
      console.log(`  ${channel.padEnd(7)} = ${raw.channelModels?.[channel] || '(继承默认)'}  → ${channelConfig.model}`)
    }
  }
  process.exit(0)
}

if (argv[0] === '--add-model') {
  const name = argv[1]
  if (!name) {
    console.error('用法: ai --add-model <名字> model=<模型名> baseURL=<地址> [apiKey=<key>] [provider=<服务商>]')
    console.error('例:   ai --add-model qwen model=qwen-plus baseURL=https://dashscope.aliyuncs.com/compatible-mode/v1 apiKey=sk-xxx provider=通义千问')
    process.exit(1)
  }
  const kv: Record<string, string> = {}
  for (const arg of argv.slice(2)) {
    const eq = arg.indexOf('=')
    if (eq > 0) kv[arg.slice(0, eq)] = arg.slice(eq + 1)
  }
  if (!kv.model || !kv.baseURL) {
    console.error('至少要传 model=<模型名> 和 baseURL=<地址>；apiKey/provider 可选（不传 apiKey 则切换时沿用当前已保存的 apiKey）。')
    process.exit(1)
  }
  const profile: ModelProfile = { name, model: kv.model, baseURL: kv.baseURL }
  if (kv.apiKey) profile.apiKey = kv.apiKey
  if (kv.provider) profile.provider = kv.provider
  const list = saveModelProfile(profile)
  console.log(`✓ 已保存模型「${name}」。当前共 ${list.length} 个预设，用 ai --use-model ${name}（或对话框内 /models）切换。`)
  process.exit(0)
}

if (
  argv[0] === '--list-models' ||
  argv[0] === '--models' ||
  argv[0] === '--model-list' ||
  argv[0] === '--list' ||
  argv[0] === '--l'
) {
  const list = loadModels()
  const effective = loadConfig()
  if (!list.length) {
    console.log('暂无已保存的模型预设。用 ai --add-model <名字> model=.. baseURL=.. [apiKey=..] [provider=..] 添加。')
  } else {
    console.log(`已保存 ${list.length} 个模型预设：\n`)
    const raw = loadRawConfig()
    list.forEach((m, i) => {
      const uses = [
        m.name === effective.activeModel ? 'default' : '',
        ...(['qq', 'wx', 'wechat'] as const).filter(c => raw.channelModels?.[c] === m.name),
      ].filter(Boolean)
      const cur = uses.length ? `  ← ${uses.join(', ')}` : ''
      console.log(`  ${i + 1}. ${m.name}  ${m.model} @ ${m.baseURL}${m.provider ? `  (${m.provider})` : ''}${cur}`)
    })
  }
  process.exit(0)
}

if (argv[0] === '--use-model' || argv[0] === '--use' || argv[0] === '--u') {
  const name = argv[1]
  if (!name) {
    console.error('用法: ai --use-model <名字> [--channel qq|wx|wechat|all]')
    process.exit(1)
  }
  const channelFlag = argv.indexOf('--channel')
  const channelArg = channelFlag >= 0 ? argv[channelFlag + 1]?.toLowerCase() : undefined
  const validChannels = ['qq', 'wx', 'wechat', 'all']
  if (channelFlag >= 0 && (!channelArg || !validChannels.includes(channelArg))) {
    console.error('渠道必须是 qq、wx（个人微信）、wechat（企业微信）或 all。')
    process.exit(1)
  }
  const profile =
    channelArg === 'all'
      ? switchAllChannelModels(name)
      : switchModel(name, channelArg as ModelChannel | undefined)
  if (!profile) {
    console.error(`未找到模型「${name}」。先用 ai --list-models（或 --models / --model-list）看已保存哪些。`)
    process.exit(1)
  }
  const scope = channelArg
    ? channelArg === 'all'
      ? 'QQ、个人微信、企业微信'
      : channelArg === 'wx'
        ? '个人微信'
        : channelArg === 'wechat'
          ? '企业微信'
          : 'QQ'
    : '默认/终端'
  console.log(`✓ ${scope}已切换到「${profile.name}」：${profile.model} @ ${profile.baseURL}`)
  if (channelArg) console.log('  长驻服务会在下一条消息自动加载，无需重启。')
  process.exit(0)
}

if (argv[0] === '--rm-model') {
  const name = argv[1]
  if (!name) {
    console.error('用法: ai --rm-model <名字>')
    process.exit(1)
  }
  const list = removeModelProfile(name)
  console.log(`已删除「${name}」。剩余 ${list.length} 个预设。`)
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
  if (modelNeedsApiKey(cfg) && !cfg.apiKey) {
    console.error('未配置 API key。先运行: ai --set-key <KEY>')
    process.exit(1)
  }

  const history: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(process.cwd(), 'terminal') },
    { role: 'user', content: question },
  ]
  const historyTrace = createHistoryTraceContext('ask', 'ask')
  traceHistory(historyTrace, 'before-run-agent', history)

  const answers: string[] = []
  let tokenUsage: TokenUsage = { ...EMPTY_TOKEN_USAGE }
  const startedAt = Date.now()
  try {
    for await (const ev of runAgent(history, {
      apiKey: cfg.apiKey ?? '',
      model: cfg.model,
      baseURL: cfg.baseURL,
      provider: cfg.provider,
      verifyLevel: parseVerifyLevel(process.env.AI_VERIFY_LEVEL),
      historyTrace,
      onUsage: usage => {
        tokenUsage = addTokenUsage(tokenUsage, usage)
      },
    })) {
      if (ev.type === 'text') {
        answers.push(ev.content)
      } else if (ev.type === 'tool') {
        // 非交互输出没有可安全重绘的动态区，只写最终态和系统状态，避免 start/result 成对重复。
        if (ev.phase !== 'start') console.error(ev.summary)
      } else if (ev.type === 'limit') {
        console.error(`⏸ 已连续执行 ${ev.steps} 步仍未结束。`)
      }
    }
    const answer = answers.join('\n')
    traceHistory(historyTrace, 'after-run-agent', history)
    console.log(answer)
    console.error(formatWorkedFor(Date.now() - startedAt))
    console.error(`Tokens: ${formatTokenUsage(tokenUsage)}`)
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
  role:
    | 'user'
    | 'assistant'
    | 'assistant-line'
    | 'assistant-status'
    | 'thinking-marker'
    | 'tool'
    | 'remote-tool'
    | 'tool-card'
    | 'activity'
    | 'agent-batch'
  content: string
  gap?: boolean
  toolCard?: {
    name?: string
    title: string
    result: string
    failed: boolean
    preview?: string
    remote?: boolean
    rawUrl?: string
    quietFailure?: boolean
  }
  agentCard?: AgentCardItem[]
}

type ActiveTool = {
  callId: string
  name: string
  summary: string
  detail?: string
}

type ToolBatch = {
  expected: number
  tools: Map<string, {
    name: string
    title: string
    inputDetail?: string
    result?: string
    resultDetail?: string
    failed?: boolean
    rawUrl?: string
  }>
}

type BtwState = {
  question: string
  status: 'loading' | 'done' | 'error'
  answer?: string
}

function toolPreview(detail: string | undefined, failed: boolean): string | undefined {
  if (!detail) return undefined
  const lines = detail.replace(/\0/g, '').split('\n').filter(line => line.trim())
  if (!lines.length) return undefined
  const selected = failed ? lines.slice(-3) : lines.slice(0, 3)
  const preview = selected.join('\n')
  const clipped = preview.length > 500 ? `${preview.slice(0, 497)}…` : preview
  return lines.length > selected.length ? `${clipped}\n…` : clipped
}

function semanticToolPreview(
  name: string,
  inputDetail: string | undefined,
  resultDetail: string | undefined,
  failed: boolean,
): string | undefined {
  // Web failures commonly contain an HTML challenge page or a one-line JSON body.
  // Claude Code keeps that diagnostic payload in the verbose transcript and shows
  // only the actionable failure summary in the normal conversation.
  if (failed && (name === 'web_fetch' || name === 'WebFetch' || name === 'WebSearch')) {
    return undefined
  }
  // Shell failures are summarized into the result row. Keep tracebacks and
  // compiler diagnostics in Ctrl+O instead of painting several rows red here.
  if (failed && (name === 'run_bash' || name === 'run_admin')) return undefined
  // Claude Code 的默认 Web 卡片只显示查询目标与次数/耗时或响应摘要；完整搜索
  // 结果和抓取正文留在 Ctrl+O transcript，避免原始 JSON 淹没正常对话。
  if (!failed && (name === 'WebSearch' || name === 'WebFetch' || name === 'web_fetch')) {
    return undefined
  }
  if (!failed && (name === 'write_file' || name === 'edit_file') && inputDetail) {
    try {
      const input = JSON.parse(inputDetail)
      const changed = name === 'write_file' ? input.content : input.new_string
      if (typeof changed === 'string' && changed) return toolPreview(changed, false)
    } catch {
      // Fall through to the result preview for legacy/plain-text tool details.
    }
  }
  return toolPreview(resultDetail, failed)
}

function toolUrl(
  name: string,
  inputDetail: string | undefined,
  resultDetail?: string,
): string | undefined {
  if (!(name.startsWith('browser_') || name === 'web_fetch' || name === 'WebFetch')) {
    return undefined
  }
  if (inputDetail) {
    try {
      const input = JSON.parse(inputDetail)
      if (typeof input?.url === 'string' && /^https?:\/\//i.test(input.url)) return input.url
    } catch {
      // Legacy/plain-text detail falls through to conservative URL extraction.
    }
  }
  return resultDetail?.match(/^地址:\s*(https?:\/\/\S+)$/m)?.[1]
    ?? inputDetail?.match(/https?:\/\/[^\s"']+/)?.[0]
}

function copyToClipboard(value: string): Promise<void> {
  const candidates: Array<[string, string[]]> = process.platform === 'darwin'
    ? [['/usr/bin/pbcopy', []]]
    : process.platform === 'win32'
      ? [['clip', []]]
      : process.env.WAYLAND_DISPLAY
        ? [['wl-copy', []], ['xclip', ['-selection', 'clipboard']]]
        : [['xclip', ['-selection', 'clipboard']], ['wl-copy', []]]

  const attempt = (index: number): Promise<void> => new Promise((resolve, reject) => {
    const candidate = candidates[index]
    if (!candidate) {
      reject(new Error('未找到可用的系统剪贴板命令'))
      return
    }
    const child = spawn(candidate[0], candidate[1], { stdio: ['pipe', 'ignore', 'ignore'] })
    let settled = false
    const retry = () => {
      if (settled) return
      settled = true
      void attempt(index + 1).then(resolve, reject)
    }
    child.once('error', () => {
      retry()
    })
    child.once('exit', code => {
      if (settled) return
      settled = true
      if (code === 0) resolve()
      else void attempt(index + 1).then(resolve, reject)
    })
    child.stdin.end(value)
  })

  return attempt(0)
}

function InlineMarkdown({ children }: { children: string }) {
  const line = markdownLinePresentation(children)
  return (
    <Text bold={line.heading}>
      {inlineMarkdownSegments(line.content).map((segment, index) => (
        <Text
          key={index}
          bold={segment.style === 'bold'}
          italic={segment.style === 'italic'}
          color={segment.style === 'link' || segment.style === 'code' ? activeUiTheme.accent : undefined}
          underline={segment.style === 'link'}
        >
          {segment.style === 'link' && segment.href
            ? terminalHyperlink(segment.href, segment.text)
            : segment.text}
        </Text>
      ))}
    </Text>
  )
}

function ToolCardTitle({
  title,
  name,
  remote,
  rawUrl,
}: {
  title: string
  name?: string
  remote?: boolean
  rawUrl?: string
}) {
  const localUrl = name === 'web_fetch' ? rawUrl ?? localWebFetchUrl(title) : undefined
  if (localUrl) {
    return (
      <Text>
        <Text bold>Fetch</Text>
        ({terminalHyperlink(localUrl, compactUrlForDisplay(localUrl))})
      </Text>
    )
  }
  if (rawUrl && name === 'WebFetch') {
    return <Text><Text bold>Fetch</Text>({terminalHyperlink(rawUrl, compactUrlForDisplay(rawUrl))})</Text>
  }
  if (rawUrl && name?.startsWith('browser_')) {
    return <Text bold>{terminalHyperlink(rawUrl, title)}</Text>
  }
  if (name === 'run_bash' || name === 'run_admin') {
    const separator = title.indexOf(' · ')
    if (separator > 0) {
      return (
        <Text>
          <Text bold>{title.slice(0, separator)}</Text>
          <Text dimColor>{title.slice(separator)}</Text>
        </Text>
      )
    }
  }
  const webTitle = remote ? splitRemoteWebTitle(title) : undefined
  if (!webTitle) return <Text bold>{title}</Text>
  return (
    <Text>
      <Text bold>{webTitle.tool}</Text>
      {webTitle.argument}
    </Text>
  )
}

function TranscriptLineContent({ line }: { line: TranscriptLine }) {
  const marker = line.accent && /^([●✗○])\s(.*)$/s.exec(line.text)
  if (!marker) return <>{line.text}</>
  // Long verbose Fetch inputs may already have been wrapped before rendering,
  // so style the leading tool name even when the closing parenthesis is on a
  // later terminal row.
  const webTitle = /^(Web Search|Fetch)(.*)$/s.exec(marker[2])
  return (
    <>
      <Text color={line.accent === 'failure' ? 'magenta' : line.accent === 'success' ? 'green' : undefined}>
        {marker[1]}
      </Text>{' '}
      {webTitle ? (
        <><Text bold>{webTitle[1]}</Text>{webTitle[2]}</>
      ) : marker[2]}
    </>
  )
}

// 单条消息行：memo 化，props 不变就不重绘。
const MessageRow = memo(
  ({
    role,
    content,
    gap,
    toolCard,
    agentCard,
  }: {
    role: string
    content: string
    gap?: boolean
    toolCard?: UIMessage['toolCard']
    agentCard?: UIMessage['agentCard']
  }) => {
  if (role === 'user') {
    if (activeUiTheme.scheme === 'light') {
      return (
        <Box
          marginBottom={1}
          borderStyle="single"
          borderColor={activeUiTheme.accent}
          borderTop={false}
          borderRight={false}
          borderBottom={false}
          paddingLeft={1}
          width={Math.max(20, (process.stdout.columns || 80) - 4)}
        >
          <Text>{content}</Text>
        </Box>
      )
    }
    return (
      <Box marginBottom={1}>
        <Text backgroundColor="#3a3a3a" color="white">
          {formatUserPrompt(content, process.stdout.columns || 80)}
        </Text>
      </Box>
    )
  }
  if (role === 'activity') {
    return (
      <Box marginBottom={gap ? 1 : 0}>
        <Text dimColor>{content}</Text>
      </Box>
    )
  }
  if (role === 'assistant-status') {
    return (
      <Box marginBottom={1}>
        <Text>
          <Text>●</Text>{' '}
          {content}
        </Text>
      </Box>
    )
  }
  if (role === 'thinking-marker') {
    return (
      <Box marginBottom={1}>
        <Text dimColor italic>∴ Thinking · Ctrl+O to expand</Text>
      </Box>
    )
  }
  if (role === 'agent-batch' && agentCard) {
    const finished = agentCard.filter(item => item.status === 'Done').length
    const failed = agentCard.length - finished
    return (
      <Box marginBottom={1} flexDirection="column">
        <Text>
          <Text color={failed ? 'yellow' : 'green'}>●</Text>{' '}
          <Text bold>
            {agentCard.length} {agentCard.length === 1 ? 'agent' : 'agents'} finished
          </Text>
          {failed > 0 && <Text dimColor> · {failed} need attention</Text>}
        </Text>
        {agentCard.map((item, index) => {
          const last = index === agentCard.length - 1
          return (
            <Box key={`${item.title}-${index}`} flexDirection="column">
              <Text>
                {'  '}{last ? '└' : '├'} {item.title}
                <Text dimColor> · {item.toolUses} tool {item.toolUses === 1 ? 'use' : 'uses'}</Text>
              </Text>
              <Text color={item.failed ? 'yellow' : undefined} dimColor={!item.failed}>
                {'  '}{last ? ' ' : '│'}  └ {item.status}
              </Text>
            </Box>
          )
        })}
      </Box>
    )
  }
  if ((role === 'remote-tool' || role === 'tool-card') && toolCard) {
    const quietFailure = toolCard.failed && (toolCard.quietFailure || (
      toolCard.name === 'run_bash' || toolCard.name === 'run_admin'
    ))
    const compactResult = compactToolResultRows(
      toolCard.result,
      toolCard.preview,
      process.stdout.columns || 80,
    ).text.replace(/\n/g, '\n    ')
    return (
      <Box marginBottom={1} flexDirection="column">
        <Text>
          <Text color={toolCard.failed ? 'red' : 'green'}>●</Text>{' '}
          <ToolCardTitle
            title={toolCard.title}
            name={toolCard.name}
            remote={toolCard.remote}
            rawUrl={toolCard.rawUrl}
          />
        </Text>
        <Text
          color={toolCard.failed && !quietFailure ? 'red' : undefined}
          dimColor={!toolCard.failed || quietFailure}
        >
          {'  '}└ {compactResult}
        </Text>
      </Box>
    )
  }
  if (role === 'tool') {
    // 工具行已经带有状态图标；这里不再叠加“⚙”，避免出现“⚙ ✓”双状态。
    const failed = content.startsWith('✗')
    const succeeded = content.startsWith('✓')
    return (
      <Box marginBottom={0}>
        <Text color={failed || succeeded ? 'yellow' : undefined} dimColor={!failed}>
          {content}
        </Text>
      </Box>
    )
  }
  if (role === 'assistant-line') {
    // 空行也要占一行高度，保留段落间的视觉间隔。
    return (
      <Box marginBottom={gap ? 1 : 0}>
        {content.length ? <InlineMarkdown>{content}</InlineMarkdown> : <Text> </Text>}
      </Box>
    )
  }
  return (
    <Box marginBottom={1}>
      <Text>{content}</Text>
    </Box>
  )
  },
)

// 消息列表：整体 memo，只要 messages 引用不变就完全不重渲染。
// 这样 Spinner tick 不会触发消息区的 reconciliation。
// 头部信息：memo，只有 model/baseURL 变化才重绘（基本不会）。
const TornadoIcon = memo(({ color }: { color: string }) => (
  <Box flexDirection="column" marginRight={2}>
    <Text color={color} bold>{'████████▄'}</Text>
    <Text color={color} bold>{'  ▀█████'}</Text>
    <Text color={color} bold>{'   ███▀'}</Text>
    <Text color={color} bold>{'    ██'}</Text>
    <Text color={color} bold>{'   ▀'}</Text>
  </Box>
))

const Header = memo(({
  model,
  baseURL,
  columns,
}: {
  model: string
  baseURL: string
  columns: number
}) => {
  const theme = activeUiTheme
  if (theme.scheme === 'light') {
    return (
      <Box
        marginBottom={1}
        width={Math.max(20, columns - 4)}
        borderStyle="single"
        borderColor={theme.accent}
        paddingX={1}
        flexDirection="column"
      >
        <Text>
          <Text color={theme.accent} bold>{'◆ ai'}</Text>
          <Text bold>{'  Welcome back'}</Text>
          <Text dimColor>{`  ·  ${model}`}</Text>
        </Text>
        <Text dimColor wrap="truncate-middle">{process.cwd()}  ·  {baseURL}</Text>
        <Text>Ask a question or describe a task. <Text dimColor>Ctrl+O: details</Text></Text>
      </Box>
    )
  }
  return (
    <Box
      marginBottom={1}
      width={Math.max(20, columns - 4)}
      borderStyle="round"
      borderColor={theme.accent}
      paddingX={2}
      paddingY={1}
    >
      <Box flexDirection="column" width="50%">
        <Box>
          <TornadoIcon color={theme.accent} />
          <Box flexDirection="column">
            <Text bold>Welcome back!</Text>
            <Text color={theme.accent} bold>ai</Text>
          </Box>
        </Box>
        <Text dimColor>{model}</Text>
        <Text dimColor wrap="truncate-middle">Endpoint: {baseURL}</Text>
        <Text dimColor wrap="truncate-middle">{process.cwd()}</Text>
      </Box>
      <Box flexDirection="column" width="50%" paddingLeft={2}>
        <Text bold>Tips for getting started</Text>
        <Text dimColor>Ask a question or describe a task.</Text>
        <Text dimColor>Ctrl+O opens the complete tool transcript.</Text>
      </Box>
    </Box>
  )
})

// Spinner：用 ref 代替 state 来跟踪帧索引，避免每 150ms 触发父组件重渲染。
// 仅通过直接调度自身重渲染来更新画面。
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

// Ink 的动画依赖「上移光标 + 擦除旧行」。部分 SSH/网页终端虽然能显示颜色，
// 却不能稳定处理高频光标移动，结果是每一帧都被追加到屏幕（见 bug.png）。
// 远程会话默认使用静态状态点，避免无内容变化时仍每 150ms 重画整块底栏。
// 如确认远程终端兼容，可用 AI_SPINNER=1 强制开启动画；AI_SPINNER=0 可在本地关闭。
const spinnerOverride = process.env.AI_SPINNER
const REMOTE_SAFE_UI =
  Boolean(process.env.SSH_TTY || process.env.SSH_CONNECTION) &&
  process.env.AI_LIVE_STREAM !== '1'
const ANIMATE_SPINNER =
  spinnerOverride === '1' ||
  (spinnerOverride !== '0' &&
    process.stdout.isTTY === true &&
    process.env.TERM !== 'dumb' &&
    !REMOTE_SAFE_UI)

const Spinner = memo(() => {
  const [i, setI] = useState(0)
  useEffect(() => {
    if (!ANIMATE_SPINNER) return
    const id = setInterval(() => setI(x => (x + 1) % SPINNER_FRAMES.length), 150)
    return () => clearInterval(id)
  }, [])
  return <Text color={activeUiTheme.accent}>{ANIMATE_SPINNER ? SPINNER_FRAMES[i] : '●'}</Text>
})

const BlinkingToolDot = memo(() => {
  const [visible, setVisible] = useState(true)
  useEffect(() => {
    if (!ANIMATE_SPINNER) return
    const id = setInterval(() => setVisible(value => !value), 500)
    return () => clearInterval(id)
  }, [])
  return <Text>{!ANIMATE_SPINNER || visible ? '●' : ' '}</Text>
})

const ActiveToolRow = memo(({ tool }: { tool: ActiveTool }) => {
  const presentation = activeToolPresentation(tool.name, tool.summary, tool.detail)
  return (
    <Box flexDirection="column">
      <Text>
        <BlinkingToolDot /> {presentation.label}
      </Text>
      {presentation.detail && <Text dimColor>{'  └ '}{presentation.detail}</Text>}
    </Box>
  )
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

function TranscriptAlternateScreen({
  rows,
  onRestored,
  children,
}: {
  rows: number
  onRestored: () => void
  children: ReactNode
}) {
  // Enter during React's mutation phase, before Ink paints the transcript frame.
  // Exit in the passive cleanup, after Ink has painted the normal branch into the
  // disposable alt buffer; restoring DEC 1049 then reveals the untouched main UI.
  useInsertionEffect(() => {
    // MultilineInput unmounts in the same commit. Re-assert raw mode before its
    // cleanup can expose POSIX VDISCARD (Ctrl+O) and let the terminal swallow it.
    setTerminalRawModeLock(true)
    setTerminalAlternateScreenActive(true)
    process.stdin.setRawMode?.(true)
    process.stdout.write('\x1b[?1049h\x1b[2J\x1b[H\x1b[?1000h\x1b[?1006h')
    return () => {
      // Deliberately exit in useEffect cleanup below.
    }
  }, [])

  useEffect(() => {
    return () => {
      setTerminalRawModeLock(false)
      process.stdout.write('\x1b[?1000l\x1b[?1006l\x1b[?1049l')
      setTerminalAlternateScreenActive(false)
      queueMicrotask(onRestored)
    }
  }, [onRestored])

  return (
    <Box flexDirection="column" height={Math.max(3, rows - 1)} overflow="hidden" flexShrink={0}>
      {children}
    </Box>
  )
}

function App() {
  const { exit } = useApp()
  const [apiKey, setApiKey] = useState<string | undefined>(config.apiKey)
  // 当前生效的模型参数：初始取自 config.json/环境变量；/models 切换预设时在这里更新，
  // 当场生效、无需重启（headerProps/页脚/runAgent 都读它，而不是启动时的静态 config）。
  const [modelConfig, setModelConfig] = useState({
    model: config.model,
    baseURL: config.baseURL,
    provider: config.provider,
    activeModel: config.activeModel,
  })
  const [messages, setMessages] = useState<UIMessage[]>([])
  // 正在流式输出的助手草稿：实时打字机效果，定稿后并入 messages（Static）并清空。
  const [streaming, setStreaming] = useState('')
  // 工具调用在动态区只占一个活动项；收到 result 后移除，并把最终态沉淀到 Static 历史。
  const [activeTools, setActiveTools] = useState<ActiveTool[]>([])
  const [transcriptEvents, setTranscriptEvents] = useState<TranscriptEvent[]>([])
  const [showTranscript, setShowTranscript] = useState(false)
  const [transcriptOffset, setTranscriptOffset] = useState(0)
  const [transcriptShowRaw, setTranscriptShowRaw] = useState(false)
  const [transcriptNotice, setTranscriptNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // 运行中仍保持输入框可编辑。普通 prompt 先排队，当前 turn 收口后按提交顺序执行。
  const [queuedPrompts, setQueuedPrompts] = useState<string[]>([])
  // /btw 是独立、无工具、不会写入主历史的旁路请求。
  const [btw, setBtw] = useState<BtwState | null>(null)
  const [activity, setActivity] = useState<ActivityCounts>({ ...EMPTY_ACTIVITY_COUNTS })
  const [busyStartedAt, setBusyStartedAt] = useState<number | null>(null)
  const [elapsedMs, setElapsedMs] = useState(0)
  const [modelStatus, setModelStatus] = useState<ModelStatus | null>(null)
  const [terminalSize, setTerminalSize] = useState(() =>
    safeTerminalSize(process.stdout.columns, process.stdout.rows),
  )
  const [staticBaseMessageCount, setStaticBaseMessageCount] = useState(0)
  const [staticHeaderVisible, setStaticHeaderVisible] = useState(true)
  const [staticEpoch, setStaticEpoch] = useState(0)
  const [tokenUsage, setTokenUsage] = useState<TokenUsage>({ ...EMPTY_TOKEN_USAGE })
  const [error, setError] = useState<string | null>(null)
  const lastCtrlC = useRef(0)
  const abortRef = useRef<AbortController | null>(null)
  const btwAbortRef = useRef<AbortController | null>(null)
  const btwRequestRef = useRef(0)
  const busyRef = useRef(false)
  const queuedPromptsRef = useRef<string[]>([])
  const sendRef = useRef<((text: string) => Promise<void>) | null>(null)
  // 主 turn 运行时，historyRef 可能暂时包含尚未配对的 tool_call。/btw 只读取
  // turn 开始时的合法快照，避免旁路请求拿到半截协议消息。
  const sideHistoryRef = useRef<ChatMessage[]>([])
  const toolBatchesRef = useRef(new Map<string, ToolBatch>())
  const turnIdRef = useRef(0)
  const historyRef = useRef<ChatMessage[]>([{ role: 'system', content: SYSTEM_PROMPT }])
  const tokenUsageRef = useRef<TokenUsage>({ ...EMPTY_TOKEN_USAGE })
  const activityRef = useRef<ActivityCounts>({ ...EMPTY_ACTIVITY_COUNTS })
  const turnOutputStartRef = useRef(0)
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 自增 id：给每条消息一个稳定 key，避免数组索引漂移引发不必要的重绘。
  const idRef = useRef(0)
  const transcriptLedgerRef = useRef<BufferedTranscriptLedger | null>(null)
  if (!transcriptLedgerRef.current) transcriptLedgerRef.current = new BufferedTranscriptLedger()
  const transcriptPublishTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const showTranscriptRef = useRef(false)
  const transcriptLineCountRef = useRef(0)
  const transcriptEntryMessageCountRef = useRef(0)
  const lastCopyableUrlRef = useRef<string | null>(null)
  // 流式「未完成的最后一行」。完整行随到随沉淀进上方 Static 历史，动态区只留这截尾巴，
  // 让底部输入框高度恒定、使用过程中不跳顶（对标 Claude Code）。ref 同步、避免批处理丢字。
  const streamTailRef = useRef('')

  const publishTranscript = useCallback((immediate = false) => {
    if (!showTranscriptRef.current) return
    if (immediate) {
      if (transcriptPublishTimerRef.current) clearTimeout(transcriptPublishTimerRef.current)
      transcriptPublishTimerRef.current = null
      setTranscriptEvents(transcriptLedgerRef.current!.snapshot())
      return
    }
    if (transcriptPublishTimerRef.current) return
    transcriptPublishTimerRef.current = setTimeout(() => {
      transcriptPublishTimerRef.current = null
      if (showTranscriptRef.current) {
        setTranscriptEvents(transcriptLedgerRef.current!.snapshot())
      }
    }, 80)
  }, [])

  const recordTranscript = useCallback((event: Omit<TranscriptEvent, 'id'>) => {
    transcriptLedgerRef.current!.append(event)
    publishTranscript(true)
  }, [publishTranscript])

  const recordTranscriptDelta = useCallback((
    turnId: number,
    kind: 'assistant_text' | 'thinking',
    content: string,
  ) => {
    transcriptLedgerRef.current!.appendDelta(turnId, kind, content)
    publishTranscript(false)
  }, [publishTranscript])

  useEffect(() => {
    showTranscriptRef.current = showTranscript
    if (showTranscript) publishTranscript(true)
    else if (transcriptPublishTimerRef.current) {
      clearTimeout(transcriptPublishTimerRef.current)
      transcriptPublishTimerRef.current = null
    }
  }, [showTranscript, publishTranscript])

  useEffect(() => () => {
    if (transcriptPublishTimerRef.current) clearTimeout(transcriptPublishTimerRef.current)
  }, [])

  useEffect(() => {
    if (busyStartedAt === null) return
    const tick = () => setElapsedMs(Date.now() - busyStartedAt)
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [busyStartedAt])

  // 与 Claude Code 一致：正常 REPL 不启用 mouse tracking，让终端原生负责
  // scrollback、拖拽圈选和复制。只有 Ctrl+O 的完整转录视图接管滚轮；该视图
  // 底部灰色提示行可以点击关闭。退出/卸载时必须恢复终端模式。
  useEffect(() => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) return
    const enable = '\x1b[?1000h\x1b[?1006h'
    const disable = '\x1b[?1000l\x1b[?1006l'
    if (!showTranscript) {
      process.stdout.write(disable)
      return
    }
    process.stdout.write(enable)
    const onMouse = (report: string) => {
      const events = parseSgrMouseEvents(report)
      if (!events.length) return

      // 完整转录占满终端；只让底部灰色操作提示成为点击目标。正文点击不触发
      // 状态变化，避免“一点任意位置就关闭”。SGR 坐标为 1-based。
      const footerClick = events.some(event =>
        event.kind === 'primary' &&
        event.action === 'press' &&
        event.row >= Math.max(1, terminalSize.rows - 1),
      )
      if (footerClick) {
        setShowTranscript(false)
        return
      }

      const wheelUp = events.filter(event => event.kind === 'wheel-up').length
      const wheelDown = events.filter(event => event.kind === 'wheel-down').length
      if (wheelUp === 0 && wheelDown === 0) return
      // 一个滚轮报告移动三行；同一 stdin chunk 内的全部触控板事件都会累计，
      // 保留连续手势的速度与方向，而不是只处理第一个事件。
      const delta = (wheelUp - wheelDown) * 3
      setTranscriptOffset(value => Math.max(0, value + delta))
    }
    const onControl = (control: string) => {
      if (control === 'ctrl-o') setShowTranscript(false)
    }
    terminalMouseEvents.on('mouse', onMouse)
    terminalControlEvents.on('control', onControl)
    return () => {
      terminalMouseEvents.off('mouse', onMouse)
      terminalControlEvents.off('control', onControl)
      process.stdout.write(disable)
    }
  }, [showTranscript, terminalSize.rows])

  // <Static> 历史不会自行按新列宽重排。resize 高频触发时不逐帧清屏；
  // 等拖动停下 120ms 后做一次完整重绘。messages/activity/streaming 均保留在
  // React 状态中，重绘只改变排版，不会删除任何中间结果。
  useEffect(() => {
    const onResize = () => {
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current)
      resizeTimerRef.current = setTimeout(() => {
        const next = safeTerminalSize(process.stdout.columns, process.stdout.rows)
        // Repaint the visible screen without CSI 3J. Clearing scrollback here erased the
        // very intermediate evidence Ctrl+O is meant to preserve.
        process.stdout.write('\x1b[2J\x1b[H')
        setTerminalSize(next)
        setStaticBaseMessageCount(0)
        setStaticHeaderVisible(true)
        setStaticEpoch(epoch => epoch + 1)
        resizeTimerRef.current = null
      }, 120)
    }
    process.stdout.on('resize', onResize)
    return () => {
      process.stdout.off('resize', onResize)
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current)
    }
  }, [])

  // Esc：生成中按一下即中断当前任务（不退出程序）。
  // Ctrl+C：忙时一次中断生成，空闲时连按两次退出。
  useInput((_input, key) => {
    // Ink parses one readable chunk as one key. Under terminal load, repeated Ctrl+O
    // bytes can arrive together and would otherwise be classified as ordinary text.
    // Treat an all-Ctrl+O chunk atomically; an even count cancels itself, an odd count
    // toggles once. MultilineInput independently rejects all remaining C0 bytes.
    if (_input.length > 0 && [..._input].every(char => char === '\x0f')) {
      if (_input.length % 2 === 1) {
        setShowTranscript(current => {
          if (!current) {
            transcriptEntryMessageCountRef.current = messages.length
            setTranscriptOffset(0)
            setTranscriptShowRaw(false)
            setTranscriptNotice(null)
          }
          return !current
        })
      }
      return
    }
    // Apply the same protection to coalesced Ctrl+C. Two or more while idle means
    // the user's explicit double-press; a single byte falls through to normal logic.
    if (_input.length > 1 && [..._input].every(char => char === '\x03')) {
      if (busy && abortRef.current) abortRef.current.abort()
      else exit()
      return
    }
    // Ink 5 does not understand SGR mouse reports. Depending on the terminal it can expose
    // them as a bare "[<64;…M" string and/or mark the leading ESC as key.escape. The raw
    // mouse listener owns these events; keyboard shortcuts must never see them.
    if (parseSgrMouseEvents(_input).length > 0) return
    if (btw) {
      if (
        key.escape ||
        key.return ||
        _input === ' ' ||
        (key.ctrl && (_input === 'c' || _input === 'd'))
      ) {
        btwRequestRef.current += 1
        btwAbortRef.current?.abort()
        btwAbortRef.current = null
        setBtw(null)
      }
      return
    }
    if (showTranscript) {
      if (key.ctrl && _input === 'e') {
        setTranscriptShowRaw(value => !value)
        setTranscriptOffset(0)
      } else if (_input.toLowerCase() === 'p') {
        const url = lastCopyableUrlRef.current
        if (!url) {
          setTranscriptNotice('没有可复制的 URL')
        } else {
          void copyToClipboard(url).then(
            () => setTranscriptNotice(`已复制 ${compactUrlForDisplay(url)}`),
            error => setTranscriptNotice(`复制失败：${error instanceof Error ? error.message : String(error)}`),
          )
        }
      } else if ((key.ctrl && _input === 'o') || (key.ctrl && _input === 'c') || key.escape || _input === 'q') {
        setShowTranscript(false)
      } else if (key.upArrow) {
        setTranscriptOffset(value => value + 1)
      } else if (key.downArrow) {
        setTranscriptOffset(value => Math.max(0, value - 1))
      } else if (key.pageUp) {
        setTranscriptOffset(value => value + Math.max(5, terminalSize.rows - 5))
      } else if (key.pageDown) {
        setTranscriptOffset(value => Math.max(0, value - Math.max(5, terminalSize.rows - 5)))
      } else if (_input === 'g') {
        setTranscriptOffset(Number.MAX_SAFE_INTEGER)
      } else if (_input === 'G') {
        setTranscriptOffset(0)
      }
      return
    }
    if (key.ctrl && _input === 'o') {
      transcriptEntryMessageCountRef.current = messages.length
      setTranscriptOffset(0)
      setTranscriptShowRaw(false)
      setTranscriptNotice(null)
      setShowTranscript(true)
      return
    }
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

  const askBtw = useCallback(
    async (question: string) => {
      const requestId = ++btwRequestRef.current
      btwAbortRef.current?.abort()
      const controller = new AbortController()
      btwAbortRef.current = controller
      setError(null)
      setBtw({ question, status: 'loading' })

      // 忙时使用 turn 开始时的稳定快照；空闲时直接复制完整主历史。
      const baseHistory = busyRef.current ? sideHistoryRef.current : historyRef.current
      const context = structuredClone(baseHistory)
      context.push({
        role: 'user',
        content:
          '这是一个临时旁问。请只根据当前对话上下文简洁回答；不要调用工具，也不要改变或继续主任务。' +
          `\n\n问题：${question}`,
      })

      try {
        const completion = await chatComplete(context, {
          apiKey: apiKey ?? '',
          model: modelConfig.model,
          baseURL: modelConfig.baseURL,
          provider: modelConfig.provider,
          signal: controller.signal,
          onUsage: usage => {
            const next = addTokenUsage(tokenUsageRef.current, usage)
            tokenUsageRef.current = next
            setTokenUsage(next)
          },
        })
        if (btwRequestRef.current !== requestId || controller.signal.aborted) return
        setBtw({
          question,
          status: 'done',
          answer: completion.content.trim() || '没有收到回答。',
        })
      } catch (e: any) {
        if (btwRequestRef.current !== requestId || controller.signal.aborted) return
        setBtw({ question, status: 'error', answer: e?.message ?? String(e) })
      } finally {
        if (btwRequestRef.current === requestId) btwAbortRef.current = null
      }
    },
    [apiKey, modelConfig],
  )

  const send = useCallback(
    async (text: string) => {
      setError(null)

      // /usage、/models、/mcp 都是本地命令：不进 LLM 历史、不消耗 token。
      const trimmed = text.trim()
      if (trimmed === '/btw' || trimmed.startsWith('/btw ')) {
        const question = trimmed.slice('/btw'.length).trim()
        if (!question) {
          setError('用法：/btw <问题>')
          return
        }
        void askBtw(question)
        return
      }
      if (trimmed === '/usage' || trimmed === '/usage reset') {
        setMessages(prev => [...prev, { id: ++idRef.current, role: 'user', content: text }])
        const pushLocal = (content: string) =>
          setMessages(prev => [...prev, { id: ++idRef.current, role: 'tool', content, gap: true }])
        if (trimmed.endsWith('reset')) {
          const empty = { ...EMPTY_TOKEN_USAGE }
          tokenUsageRef.current = empty
          setTokenUsage(empty)
          pushLocal('Token 用量已清零。')
        } else {
          pushLocal(`本次会话 Token：${formatTokenUsage(tokenUsageRef.current)}`)
        }
        return
      }
      if (trimmed === '/mcp') {
        setMessages(prev => [...prev, { id: ++idRef.current, role: 'user', content: text }])
        const loaded = loadMcpConfiguration()
        const entries = Object.entries(loaded.servers)
        const lines = entries.map(([name, config]) => {
          const source = loaded.sources[name]
          return `  ${name}${config.disabled ? ' [disabled]' : ''}  ${summarizeMcpServer(config)}  [${source.scope}]`
        })
        const errors = loaded.errors.map(error => `  ✗ ${error}`)
        const content = entries.length
          ? `当前生效的 MCP servers：\n${[...lines, ...errors].join('\n')}\n\n用 ai mcp test <名字> 实测连接。`
          : errors.length
            ? `MCP 配置有误：\n${errors.join('\n')}`
            : '当前目录没有配置 MCP server。用 ai mcp help 查看添加方式。'
        setMessages(prev => [...prev, { id: ++idRef.current, role: 'tool', content, gap: true }])
        return
      }
      if (trimmed === '/models' || trimmed.startsWith('/models ')) {
        setMessages(prev => [...prev, { id: ++idRef.current, role: 'user', content: text }])
        const pushLocal = (content: string) =>
          setMessages(prev => [...prev, { id: ++idRef.current, role: 'tool', content, gap: true }])
        const arg = trimmed.slice('/models'.length).trim()
        const profiles = loadModels()
        if (!arg) {
          if (!profiles.length) {
            pushLocal('暂无已保存的模型预设。用 ai --add-model <名字> model=.. baseURL=.. [apiKey=..] [provider=..] 添加。')
          } else {
            const lines = profiles.map((p, i) => {
              const cur = p.name === modelConfig.activeModel ? '  ← 当前' : ''
              return `  ${i + 1}. ${p.name}  ${p.model} @ ${p.baseURL}${cur}`
            })
            pushLocal(`已保存的模型（/models <序号|名字> 切换）：\n${lines.join('\n')}`)
          }
        } else {
          const idx = Number(arg)
          const name =
            Number.isInteger(idx) && idx >= 1 && idx <= profiles.length ? profiles[idx - 1].name : arg
          const profile = switchModel(name)
          if (!profile) {
            pushLocal(`✗ 未找到模型「${arg}」。先 /models 看看已保存哪些。`)
          } else {
            setModelConfig({ model: profile.model, baseURL: profile.baseURL, provider: profile.provider, activeModel: profile.name })
            if (profile.apiKey) setApiKey(profile.apiKey)
            pushLocal(`✓ 已切换到「${profile.name}」：${profile.model} @ ${profile.baseURL}`)
          }
        }
        return
      }

      if (busyRef.current) {
        queuedPromptsRef.current.push(text)
        setQueuedPrompts([...queuedPromptsRef.current])
        return
      }

      busyRef.current = true
      const uid = ++idRef.current
      setMessages(prev => [...prev, { id: uid, role: 'user', content: text }])
      const turnId = ++turnIdRef.current
      recordTranscript({ turnId, at: Date.now(), kind: 'user', summary: text })
      setBusy(true)
      const startedAt = Date.now()
      setBusyStartedAt(startedAt)
      setElapsedMs(0)
      setModelStatus(null)
      turnOutputStartRef.current = tokenUsageRef.current.outputTokens
      activityRef.current = { ...EMPTY_ACTIVITY_COUNTS }
      setActivity({ ...EMPTY_ACTIVITY_COUNTS })

      const history = historyRef.current
      const historyTrace = createHistoryTraceContext('terminal', 'terminal')
      traceHistory(historyTrace, 'before-user-push', history)
      history.push({ role: 'user', content: text })
      sideHistoryRef.current = structuredClone(history)
      traceHistory(historyTrace, 'after-user-push', history)

      const controller = new AbortController()
      abortRef.current = controller
      const answers: string[] = []
      let activityPersisted = false
      let thinkingMarkerShown = false

      const appendTranscript = (
        kind: TranscriptEventKind,
        summary: string,
        extra: Partial<Omit<TranscriptEvent, 'id' | 'turnId' | 'at' | 'kind' | 'summary'>> = {},
      ) => {
        const event: Omit<TranscriptEvent, 'id'> = {
          turnId,
          at: Date.now(),
          kind,
          summary,
          ...extra,
        }
        recordTranscript(event)
      }
      const appendTranscriptDelta = (kind: 'assistant_text' | 'thinking', content: string) => {
        recordTranscriptDelta(turnId, kind, content)
      }

      // 往 Static 历史追加一行（统一分配稳定 key）。
      const pushRow = (role: UIMessage['role'], content: string, gap = false) =>
        setMessages(prev => [...prev, { id: ++idRef.current, role, content, gap }])
      // 把「未完成的尾巴」收口：作为一行沉淀进历史，清空动态区。gap=true 段尾留白。
      const preserveTail = (gap: boolean) => {
        const t = streamTailRef.current
        streamTailRef.current = ''
        setStreaming('')
        if (t.length) pushRow('assistant-line', t, gap)
      }
      // 活动摘要在整轮执行期间持续显示，不在正文或下一项工具出现时清空。
      // 结束时只复制一次到 Static 历史；旧摘要不会被删除，下一轮使用新的计数器。
      const persistActivity = () => {
        if (activityPersisted || !hasActivity(activityRef.current)) return
        activityPersisted = true
        pushRow('activity', formatActivity(activityRef.current, false))
      }

      streamTailRef.current = ''
      try {
        for await (const ev of runAgent(history, {
          apiKey: apiKey ?? '',
          model: modelConfig.model,
          baseURL: modelConfig.baseURL,
          provider: modelConfig.provider,
          signal: controller.signal,
          verifyLevel: parseVerifyLevel(process.env.AI_VERIFY_LEVEL),
          historyTrace,
          drainQueuedPrompts: () => {
            if (!queuedPromptsRef.current.length) return []
            const prompts = queuedPromptsRef.current.splice(0)
            setQueuedPrompts([])
            setMessages(prev => [
              ...prev,
              ...prompts.map(prompt => ({
                id: ++idRef.current,
                role: 'user' as const,
                content: prompt,
              })),
            ])
            for (const prompt of prompts) {
              recordTranscript({ turnId, at: Date.now(), kind: 'user', summary: prompt })
            }
            // runAgent appends the combined steering message immediately after this
            // callback returns. Refresh the stable side-question snapshot afterwards.
            queueMicrotask(() => {
              sideHistoryRef.current = structuredClone(history)
            })
            return prompts
          },
          onUsage: usage => {
            const next = addTokenUsage(tokenUsageRef.current, usage)
            tokenUsageRef.current = next
            setTokenUsage(next)
          },
        })) {
          if (ev.type === 'delta') {
            appendTranscriptDelta('assistant_text', ev.content)
            setModelStatus(current =>
              current
                ? { ...current, phase: 'receiving', lastActivityAt: Date.now() }
                : current,
            )
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
            // SSH 下逐 token 重画仍可能压垮兼容性较差的远程终端。完整行照常实时沉淀，
            // 只把未换行的尾巴留到下一行或本段结束时一次性显示。
            if (!REMOTE_SAFE_UI) setStreaming(tail)
          } else if (ev.type === 'thinking') {
            appendTranscriptDelta('thinking', ev.content)
            if (!thinkingMarkerShown) {
              thinkingMarkerShown = true
              pushRow('thinking-marker', '')
            }
          } else if (ev.type === 'text') {
            // 一段文本收口：把剩余尾巴沉淀，段尾留一行间距。完整内容已逐行进历史，
            // 这里不再重复 push 整段，只取 ev.content 做日志。
            preserveTail(true)
            answers.push(ev.content)
          } else if (ev.type === 'model') {
            setModelStatus({
              phase: ev.phase,
              phaseStartedAt: ev.at,
              lastActivityAt: ev.at,
            })
          } else if (ev.type === 'limit') {
            // 撞到步数上限：提示而非硬停，回复「继续」即可再跑一轮。
            preserveTail(true)
            appendTranscript('system', `已连续执行 ${ev.steps} 步仍未结束`, { phase: 'info' })
            pushRow('tool', `⏸ 已连续执行 ${ev.steps} 步仍未结束。回复「继续」可再跑一轮。`)
          } else if (ev.name === 'remote-status' && ev.phase === 'info') {
            // Claude Code 会把多步研究中的阶段结论作为独立白点消息保留，例如
            // “Found exact snapshots…”。它不是工具摘要，也不是最终回答。
            preserveTail(true)
            appendTranscript('milestone', ev.summary.replace(/^●\s*/, ''), {
              phase: ev.phase,
              detail: ev.detail,
            })
            pushRow('assistant-status', ev.summary.replace(/^●\s*/, ''))
          } else if (ev.phase === 'start' && ev.callId) {
            setModelStatus(null)
            // 工具开始：只进入可变动态区，不能写进 Static，否则结束时只能再追加一条重复记录。
            preserveTail(true)
            appendTranscript('tool', ev.summary, {
              phase: ev.phase,
              name: ev.name,
              callId: ev.callId,
              batchId: ev.batchId,
              detail: ev.detail,
            })
            const batchId = ev.batchId ?? ev.callId
            const batch = toolBatchesRef.current.get(batchId) ?? {
              expected: ev.batchSize ?? 1,
              tools: new Map(),
            }
            const rawUrl = toolUrl(ev.name, ev.detail)
            if (rawUrl) lastCopyableUrlRef.current = rawUrl
            batch.tools.set(ev.callId, {
              name: ev.name,
              title: ev.summary,
              inputDetail: ev.detail,
              rawUrl,
            })
            toolBatchesRef.current.set(batchId, batch)
            const category = activityCategory(ev.name)
            setActiveTools(prev => [
              ...prev.filter(tool => tool.callId !== ev.callId),
              {
                callId: ev.callId!,
                name: ev.name,
                summary: ev.summary,
                detail: ev.detail,
              },
            ])
            if (category !== 'remote-web' && category !== 'subagent') {
              const next = addActivity(activityRef.current, ev.name)
              activityRef.current = next
              setActivity(next)
            }
          } else {
            preserveTail(true)
            appendTranscript(ev.callId ? 'tool' : 'system', ev.summary, {
              phase: ev.phase,
              name: ev.name,
              callId: ev.callId,
              batchId: ev.batchId,
              detail: ev.detail,
            })
            if (ev.callId) setActiveTools(prev => prev.filter(tool => tool.callId !== ev.callId))
            if (ev.callId && ev.batchId) {
              const batch = toolBatchesRef.current.get(ev.batchId)
              const tool = batch?.tools.get(ev.callId)
              if (batch && tool) {
                tool.result = ev.summary
                tool.resultDetail = ev.detail
                tool.failed = ev.phase === 'failure'
                const completedUrl = toolUrl(tool.name, tool.inputDetail, tool.resultDetail)
                if (completedUrl) {
                  tool.rawUrl = completedUrl
                  lastCopyableUrlRef.current = completedUrl
                }
                const finished = [...batch.tools.values()].filter(item => item.result).length
                if (batch.tools.size === batch.expected && finished === batch.expected) {
                  const tools = [...batch.tools.values()]
                  const isRemoteWebBatch = tools.every(
                    item => item.name === 'WebSearch' || item.name === 'WebFetch',
                  )
                  if (isRemoteWebBatch) {
                    // 对标 Claude Code：永久保留“工具名(完整参数)”和下一行结果，
                    // 不把 start 行替换成一条失去查询词/URL 的完成摘要。
                    setMessages(prev => [
                      ...prev,
                      ...tools.map(item => ({
                        id: ++idRef.current,
                        role: 'remote-tool' as const,
                        content: '',
                        toolCard: {
                          name: item.name,
                          title: item.title,
                          result: item.result ?? (item.failed ? 'Error' : 'Completed'),
                          failed: Boolean(item.failed),
                          rawUrl: item.rawUrl ?? toolUrl(item.name, item.inputDetail, item.resultDetail),
                          preview: semanticToolPreview(
                            item.name,
                            item.inputDetail,
                            item.resultDetail,
                            Boolean(item.failed),
                          ),
                          remote: true,
                        },
                      })),
                    ])
                    toolBatchesRef.current.delete(ev.batchId)
                    continue
                  }
                  const isAgentBatch = tools.every(item => item.name === 'run_agent')
                  if (isAgentBatch) {
                    setMessages(prev => [
                      ...prev,
                      {
                        id: ++idRef.current,
                        role: 'agent-batch',
                        content: '',
                        agentCard: tools.map(item =>
                          parseAgentCardItem(item.title, item.resultDetail, Boolean(item.failed))),
                      },
                    ])
                    toolBatchesRef.current.delete(ev.batchId)
                    continue
                  }
                  const keyTools = tools.filter(item =>
                    item.failed || (
                      isKeyTool(item.name) &&
                      item.name !== 'run_bash' &&
                      item.name !== 'run_admin'
                    ))
                  if (keyTools.length) {
                    setMessages(prev => [
                      ...prev,
                      ...keyTools.map(item => {
                        const browserCard = !item.failed
                          ? conciseBrowserToolCard(item.name, item.resultDetail)
                          : undefined
                        const recoverableFailure = item.failed
                          ? recoverableToolFailure(item.name, item.result, item.resultDetail)
                          : undefined
                        const rawUrl = item.rawUrl
                          ?? toolUrl(item.name, item.inputDetail, item.resultDetail)
                          ?? browserCard?.finalUrl
                        return {
                          id: ++idRef.current,
                          role: 'tool-card' as const,
                          content: '',
                          toolCard: {
                            name: item.name,
                            title: item.title,
                            result: browserCard?.result
                              ?? recoverableFailure?.result
                              ?? (!item.failed && item.name === 'web_fetch'
                                ? conciseWebFetchResult(item.result, item.resultDetail)
                                : item.failed && (
                                  item.name === 'run_bash' || item.name === 'run_admin'
                                )
                                  ? conciseShellFailure(
                                      conciseToolCardResult(item.title, item.result, true),
                                      item.resultDetail,
                                    )
                                  : conciseToolCardResult(
                                      item.title,
                                      item.result,
                                      Boolean(item.failed),
                                    )),
                            failed: Boolean(item.failed),
                            preview: browserCard?.preview ?? (recoverableFailure
                              ? undefined
                              : semanticToolPreview(
                                  item.name,
                                  item.inputDetail,
                                  item.resultDetail,
                                  Boolean(item.failed),
                                )),
                            rawUrl,
                            quietFailure: recoverableFailure?.quiet,
                          },
                        }
                      }),
                    ])
                  }
                  toolBatchesRef.current.delete(ev.batchId)
                }
              } else if (activityCategory(ev.name) !== 'subagent') {
                pushRow('tool', ev.summary)
              }
            } else if (activityCategory(ev.name) !== 'subagent') {
              pushRow('tool', ev.summary)
            }
          }
        }
        traceHistory(historyTrace, 'after-run-agent', history)
        persistActivity()
        pushRow('tool', formatWorkedFor(Date.now() - startedAt), true)
        logChat({ channel: 'terminal', sessionId: 'terminal', question: text, answer: answers.join('\n') })
      } catch (e: any) {
        if (controller.signal.aborted) {
          traceHistory(historyTrace, 'run-agent-aborted', history)
          preserveTail(true) // 中断前先把已生成的尾巴留住
          persistActivity()
          setActiveTools([])
          toolBatchesRef.current.clear()
          pushRow('assistant', '[已中断]')
          appendTranscript('system', '已中断', { phase: 'failure' })
          logChat({ channel: 'terminal', sessionId: 'terminal', question: text, answer: '[已中断]' })
        } else {
          traceHistory(historyTrace, 'run-agent-error', history, { note: e?.message ?? String(e) })
          preserveTail(true)
          persistActivity()
          setError(e?.message ?? String(e))
          appendTranscript('system', e?.message ?? String(e), { phase: 'failure' })
          logChat({ channel: 'terminal', sessionId: 'terminal', question: text, answer: `[错误] ${e?.message ?? String(e)}` })
        }
      } finally {
        preserveTail(true) // 兜底：任何残留尾巴都不丢
        const nextPrompt = queuedPromptsRef.current.shift()
        setQueuedPrompts([...queuedPromptsRef.current])
        setBusy(false)
        setBusyStartedAt(null)
        setModelStatus(null)
        streamTailRef.current = ''
        setStreaming('')
        setActiveTools([])
        toolBatchesRef.current.clear()
        abortRef.current = null
        // 保持 busyRef 到当前任务完全收口；微任务中再交给下一轮，避免两个
        // runAgent 并发修改同一份 history。
        if (nextPrompt !== undefined) {
          queueMicrotask(() => {
            busyRef.current = false
            void sendRef.current?.(nextPrompt)
          })
        } else {
          busyRef.current = false
        }
      }
    },
    [apiKey, modelConfig, askBtw, recordTranscript, recordTranscriptDelta],
  )
  sendRef.current = send

  // header props 用 useMemo 稳定引用，避免传给 memo(Header) 时每帧都是新对象
  const headerProps = useMemo(
    () => ({
      model: modelConfig.model,
      baseURL: modelConfig.baseURL,
      columns: terminalSize.columns,
    }),
    [modelConfig.model, modelConfig.baseURL, terminalSize.columns],
  )

  // Static 的数据源：头部固定为第一行，其后是所有历史消息。
  // 每个元素只会被 Ink 写入终端一次，因此这部分永远不参与重绘。
  type StaticRow = { kind: 'header' } | { kind: 'msg'; msg: UIMessage }
  const staticRows = useMemo<StaticRow[]>(
    () => [
      ...(staticHeaderVisible ? [{ kind: 'header' as const }] : []),
      ...messages
        .slice(staticBaseMessageCount)
        .map(msg => ({ kind: 'msg' as const, msg })),
    ],
    [messages, staticBaseMessageCount, staticHeaderVisible],
  )

  const finishTranscriptRestore = useCallback(() => {
    // The main terminal buffer already contains everything that was static when
    // Ctrl+O opened. Only append messages completed while the alt screen was up.
    setStaticBaseMessageCount(transcriptEntryMessageCountRef.current)
    setStaticHeaderVisible(false)
    setStaticEpoch(epoch => epoch + 1)
  }, [])

  // 流式尾巴正常只有一行；但模型若长时间不吐换行，这一「逻辑行」也可能很长，
  // 自动换行后撑高动态区。按终端高度兜底截断，保证动态区永不超出屏幕、输入框不跳顶。
  // 预留 ~9 行给 spinner、错误行、带边框输入框、页脚提示和各处 margin。
  const termRows = terminalSize.rows
  const termCols = terminalSize.columns - 2 // 容器 paddingX=1，左右各 1
  const stream = streaming
    ? tailByRows(streaming, Math.max(3, termRows - 9), termCols)
    : { shown: '', truncated: false }
  const projectedTranscriptLines = useMemo(
    () => showTranscript
      ? transcriptLines(transcriptEvents, termCols, { showRaw: transcriptShowRaw })
      : [],
    [showTranscript, transcriptEvents, termCols, transcriptShowRaw],
  )
  useEffect(() => {
    const previous = transcriptLineCountRef.current
    const next = projectedTranscriptLines.length
    transcriptLineCountRef.current = next
    if (!showTranscript || next <= previous) return
    setTranscriptOffset(offset => anchoredTranscriptOffset(offset, previous, next))
  }, [showTranscript, projectedTranscriptLines.length])
  const transcriptWindow = transcriptViewport(
    projectedTranscriptLines,
    Math.max(3, termRows - 5),
    transcriptOffset,
  )

  // 缺少 key：启动时引导用户输入并保存
  if (!apiKey && modelNeedsApiKey(modelConfig)) {
    return (
      <KeyPrompt
        onSave={k => {
          saveApiKey(k)
          setApiKey(k)
        }}
      />
    )
  }

  const staticHistory = (
    <Static key={staticEpoch} items={staticRows}>
      {row =>
        row.kind === 'header' ? (
          <Header key="header" {...headerProps} />
        ) : (
          <MessageRow
            key={row.msg.id}
            role={row.msg.role}
            content={row.msg.content}
            gap={row.msg.gap}
            toolCard={row.msg.toolCard}
            agentCard={row.msg.agentCard}
          />
        )
      }
    </Static>
  )

  if (showTranscript) {
    return (
      <Box flexDirection="column" paddingX={1}>
        {staticHistory}
        <TranscriptAlternateScreen rows={termRows} onRestored={finishTranscriptRestore}>
          <Box flexDirection="column" height={Math.max(3, termRows - 1)} overflow="hidden" flexShrink={0}>
        <Box marginBottom={1}>
          <Text color={activeUiTheme.accent} bold>完整转录</Text>
          <Text dimColor>
            {' '}· {transcriptShowRaw ? 'raw' : 'expanded'} · events {transcriptEvents.length} · lines {projectedTranscriptLines.length
              ? `${transcriptWindow.start + 1}-${transcriptWindow.end}/${projectedTranscriptLines.length}`
              : '0/0'}
          </Text>
        </Box>
        <Box
          flexDirection="column"
          height={Math.max(1, termRows - 5)}
          overflow="hidden"
          flexShrink={0}
        >
          {transcriptWindow.visible.length ? (
            // One Yoga text node is substantially safer than dozens of flex children
            // when the ledger contains large Web/PDF payloads and wide CJK text.
            <Text>
              {transcriptWindow.visible.map((line, index) => (
                <Text
                  key={line.key}
                  color={
                    line.tone === 'failure'
                      ? 'magenta'
                      : line.tone === 'thinking'
                          ? 'yellow'
                          : undefined
                  }
                  dimColor={line.tone === 'dim' || line.tone === 'thinking'}
                  italic={line.tone === 'thinking'}
                >
                  <TranscriptLineContent line={line} />{index < transcriptWindow.visible.length - 1 ? '\n' : ''}
                </Text>
              ))}
            </Text>
          ) : <Text dimColor>还没有转录事件。</Text>}
        </Box>
        <Text dimColor>
          touchpad/↑/↓ scroll · PgUp/PgDn · g/G · P copy URL · Ctrl+E {transcriptShowRaw ? 'expanded' : 'raw'} · click footer/Ctrl+O/Esc/q close
          {transcriptOffset === 0 ? ' · following live output' : ''}
          {transcriptNotice ? ` · ${transcriptNotice}` : ''}
        </Text>
          </Box>
        </TranscriptAlternateScreen>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      {/* 头部 + 历史消息 — 用 Static 渲染：每条只往终端写一次，永不重绘。
          这才是根除闪烁的关键：Spinner 每 120ms 触发的重渲染只会重画下方
          的动态区（spinner + 输入框），不再连带重画整段历史。 */}
      {staticHistory}

      {/* —— 动态区：高度恒定的底栏，已生成内容都已逐行沉淀进上方 Static —— */}

      {/* 流式尾巴 — 当前正在打字、尚未凑满一整行的最后一截（已成行的都在上方历史里）。 */}
      {streaming && (
        <Box marginBottom={1}>
          <InlineMarkdown>{stream.shown}</InlineMarkdown>
        </Box>
      )}

      {/* Active tools have their own unresolved rows below. Show the aggregate only
          between batches, otherwise "running 1 command" is repeated twice. */}
      {busy && activeTools.length === 0 && hasActivity(activity) && (
        <Box>
          <Text dimColor>{formatActivity(activity, false)}</Text>
        </Box>
      )}

      {/* 当前具体目标始终可见；活动摘要只负责说明累计工作量。 */}
      {activeTools.slice(-3).map(tool => (
        <ActiveToolRow key={tool.callId} tool={tool} />
      ))}

      {busy && (
        <Box marginBottom={streaming ? 0 : 1}>
          <Text>
            <Text color={activeUiTheme.accent}><Spinner /></Text>{' '}
            <Text>
              {modelStatus
                ? formatModelStatus(modelStatus, Date.now(), modelConfig.model)
                : '准备下一步'}
            </Text>
            <Text dimColor>
              {' '}({Math.max(1, Math.floor(elapsedMs / 1000))}s
              {' · '}↓ {formatTokenCount(Math.max(0, tokenUsage.outputTokens - turnOutputStartRef.current))} tokens
              {' · '}Esc to interrupt)
            </Text>
          </Text>
        </Box>
      )}

      {/* 错误 */}
      {error && (
        <Box marginBottom={1}>
          <Text color="red">⚠ {error}</Text>
        </Box>
      )}

      {queuedPrompts.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          {queuedPrompts.map((prompt, index) => (
            <Text key={`${index}-${prompt}`} dimColor>
              {index === 0 ? '排队中 › ' : '       › '}{prompt}
            </Text>
          ))}
        </Box>
      )}

      {btw && (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={activeUiTheme.accent}
          paddingX={1}
          marginBottom={1}
        >
          <Text>
            <Text color={activeUiTheme.accent} bold>/btw </Text>
            <Text dimColor>{btw.question}</Text>
          </Text>
          <Box marginTop={1}>
            {btw.status === 'loading' ? (
              <Text color={activeUiTheme.accent}><Spinner /> 正在旁路回答…</Text>
            ) : (
              <Text color={btw.status === 'error' ? 'red' : undefined}>{btw.answer}</Text>
            )}
          </Box>
          <Text dimColor>Space / Enter / Esc 关闭；不会写入主对话</Text>
        </Box>
      )}

      {/* 输入框：主任务运行中仍保持可输入；/btw 弹层打开时由弹层接管键盘。 */}
      {!btw && (
        <MultilineInput
          onSubmit={send}
          topRightLabel={
            busy
              ? `${queuedPrompts.length} queued · /btw 可旁问`
              : `${formatTokenCount(tokenUsage.totalTokens)} tokens`
          }
          accentColor={activeUiTheme.accent}
          cursorColor={activeUiTheme.cursorText}
          compact={activeUiTheme.scheme === 'light'}
          width={Math.max(20, terminalSize.columns - 4)}
        />
      )}

      {/* 常驻页脚提示 */}
      {!btw && <Box paddingX={1}>
        <Text dimColor>
          {modelConfig.model}
          {' · '}↑{formatTokenCount(tokenUsage.inputTokens)}
          {' · '}↓{formatTokenCount(tokenUsage.outputTokens)}
          {' · '}Ctrl+O details · Esc interrupt
          {busy ? ' · Enter queues next prompt' : ''}
        </Text>
      </Box>}
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
        <Text color={activeUiTheme.accent} bold>
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
        <Text color={activeUiTheme.accent}>key › </Text>
        <MultilineInput
          onSubmit={submit}
          placeholder="粘贴 API key…"
          accentColor={activeUiTheme.accent}
          cursorColor={activeUiTheme.cursorText}
          compact={activeUiTheme.scheme === 'light'}
        />
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
  // Filter SGR mouse reports before Ink's keyboard parser receives them. A custom
  // stdout also removes Ink's automatic CSI 3J so view changes preserve scrollback.
  // Enable raw input on the actual TTY before inserting the decoder stream. Ink's
  // raw-mode support detection only sees the decoder and some PTYs otherwise leave
  // VDISCARD (Ctrl+O) active, so the kernel consumes the shortcut before JavaScript.
  if (process.stdin.isTTY) process.stdin.setRawMode?.(true)
  if (process.stdin.isTTY && process.stdout.isTTY) {
    activeUiTheme = UI_THEMES[await detectTerminalColorScheme(process.stdin, process.stdout)]
  }
  // Like Claude Code, explicitly request bracketed-paste markers from the terminal.
  // Raw mode alone does not enable them; without CSI ? 2004 h a large physical paste
  // is indistinguishable from several ordinary stdin reads and gets collapsed once
  // per read. restoreTerminalModes() sends CSI ? 2004 l on every exit path.
  if (process.stdin.isTTY && process.stdout.isTTY) {
    // Normalize the initial cursor position before Ink paints a full-width frame.
    // This is required by some Debian SSH PTYs even when stty reports onlcr.
    prepareTerminalForInk(process.stdout)
    enableBracketedPasteMode(process.stdout)
  }
  const inkStdout = createScrollbackPreservingStdout(process.stdout)
  const restoreTerminal = () => restoreTerminalModes(process.stdout)
  let instance: ReturnType<typeof render> | undefined
  let inputBridge: ReturnType<typeof createInkInputBridge> | undefined
  let terminalInputClosed = false
  inputBridge = createInkInputBridge(process.stdin, {
    onEio: error => {
      if (terminalInputClosed) return
      terminalInputClosed = true
      const logPath = writeCrash('terminal-input-eio', error)
      restoreTerminal()
      try {
        instance?.unmount()
      } catch {
        /* Terminal restoration is already complete. */
      }
      inputBridge?.dispose()
      console.error(`\nai 的终端输入连接已关闭，界面已安全退出。日志：${logPath}`)
      process.exitCode = 1
    },
  })
  // Last-resort protection for uncaught errors and process.exit(): never return to
  // the user's shell while SGR mouse tracking is still enabled.
  process.once('exit', restoreTerminal)
  instance = render(<App />, {
    exitOnCtrlC: false,
    stdin: inputBridge.stdin,
    stdout: inkStdout,
  })
  const renderedInstance = instance
  // useApp().exit() unmounts Ink but does not know about our upstream pipe.
  // Dispose it as part of the same lifecycle so a clean exit cannot leave stdin alive.
  // Ink intentionally leaves <Static> output behind; clear the visible frame after
  // restoring terminal modes so the next shell prompt cannot overwrite that output.
  void renderedInstance.waitUntilExit().then(
    () => {
      inputBridge?.dispose()
      restoreTerminal()
      clearTerminalAfterInk(process.stdout)
      process.off('exit', restoreTerminal)
    },
    () => {
      inputBridge?.dispose()
      restoreTerminal()
      process.off('exit', restoreTerminal)
    },
  )

  const bail = (label: string) => (err: unknown) => {
    const logPath = writeCrash(label, err)
    // Do this before Ink.unmount(): the renderer itself may be the failing component.
    restoreTerminal()
    try {
      renderedInstance.unmount()
    } catch {
      /* 卸载失败也要继续恢复终端 */
    }
    inputBridge?.dispose()
    console.error(`\nai 遇到了意外错误（${label}）。详细日志（含最近按键）已写入：`)
    console.error(`  ${logPath}`)
    console.error(err instanceof Error ? err.stack ?? err.message : String(err))
    process.exit(1)
  }
  process.on('uncaughtException', bail('uncaughtException'))
  process.on('unhandledRejection', bail('unhandledRejection'))
}
