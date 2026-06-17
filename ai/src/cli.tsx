import { useState, useRef, useCallback, useEffect } from 'react'
import { render, Box, Text, useApp, useInput } from 'ink'
import MultilineInput from './MultilineInput.js'
import { type ChatMessage } from './deepseek.js'
import {
  loadConfig,
  saveApiKey,
  saveQQConfig,
  addQQAllow,
  CONFIG_PATH,
  DEFAULT_MODEL,
} from './config.js'
import { runAgent } from './agent/engine.js'
import { buildSystemPrompt } from './agent/session.js'

const SYSTEM_PROMPT = buildSystemPrompt(process.cwd(), 'terminal')

// ———————————————————————————————————————————————
// 命令行参数（在渲染界面之前处理）
// ———————————————————————————————————————————————
const argv = process.argv.slice(2)

if (argv[0] === '--help' || argv[0] === '-h') {
  console.log(`ai — 终端里的可编辑对话框（接入 DeepSeek），也能通过 QQ 远程操控

用法:
  ai                       进入交互对话框（缺少 key 时会在启动时引导输入）
  ai serve                 启动 QQ 官方机器人（q.qq.com 开放平台，白名单内可操控 agent）
  ai --set-key <KEY>       保存 DeepSeek API key 到 ${CONFIG_PATH}
  ai --set-qq-app <ID> <SECRET>  保存 QQ 机器人 AppID 和 AppSecret
  ai --qq-allow <openid>   往 QQ 白名单追加一个 openid（可多次；未授权用户发消息会回显其 openid）
  ai --help                显示帮助

配置（优先级从高到低）:
  环境变量 DEEPSEEK_API_KEY / AI_MODEL / DEEPSEEK_BASE_URL
  配置文件 ${CONFIG_PATH}

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

if (argv[0] === '--set-key') {
  const key = argv[1]
  if (!key) {
    console.error('用法: ai --set-key <KEY>')
    process.exit(1)
  }
  saveApiKey(key)
  console.log(`已保存到 ${CONFIG_PATH}`)
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

const config = loadConfig()

// ———————————————————————————————————————————————
// 界面
// ———————————————————————————————————————————————
type UIMessage = { role: 'user' | 'assistant' | 'tool'; content: string }

function App() {
  const { exit } = useApp()
  // apiKey 改为状态：缺失时先走「输入 key」引导，存好后无缝进入对话
  const [apiKey, setApiKey] = useState<string | undefined>(config.apiKey)
  const [messages, setMessages] = useState<UIMessage[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const lastCtrlC = useRef(0)
  const abortRef = useRef<AbortController | null>(null)
  // 完整的 API 对话历史（含 system / 工具调用 / 工具结果），跨轮累积
  const historyRef = useRef<ChatMessage[]>([{ role: 'system', content: SYSTEM_PROMPT }])

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
      setMessages(prev => [...prev, { role: 'user', content: text }])
      setBusy(true)

      const history = historyRef.current
      history.push({ role: 'user', content: text })

      const controller = new AbortController()
      abortRef.current = controller
      try {
        // 共享的 agent 引擎：消费它产出的事件流来更新界面。
        for await (const ev of runAgent(history, {
          apiKey: apiKey!,
          model: config.model,
          baseURL: config.baseURL,
          signal: controller.signal,
        })) {
          if (ev.type === 'text') {
            setMessages(prev => [...prev, { role: 'assistant', content: ev.content }])
          } else {
            setMessages(prev => [...prev, { role: 'tool', content: ev.summary }])
          }
        }
      } catch (e: any) {
        if (controller.signal.aborted) {
          setMessages(prev => [...prev, { role: 'assistant', content: '[已中断]' }])
        } else {
          setError(e?.message ?? String(e))
        }
      } finally {
        setBusy(false)
        abortRef.current = null
      }
    },
    [apiKey],
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
      {/* 头部 */}
      <Box marginBottom={1} flexDirection="column">
        <Text color="cyan" bold>
          ✦ ai
        </Text>
        <Text dimColor>
          DeepSeek · {config.model}
          {config.model === DEFAULT_MODEL ? '' : ''} — Enter 发送，行尾 \ 换行，Ctrl+C 两次退出
        </Text>
      </Box>

      {/* 历史消息 */}
      {messages.map((m, i) => (
        <Box key={i} flexDirection="column" marginBottom={m.role === 'tool' ? 0 : 1}>
          {m.role === 'user' ? (
            <Text color="cyan" bold>
              › {m.content}
            </Text>
          ) : m.role === 'tool' ? (
            <Text color="yellow" dimColor>
              ⚙ {m.content}
            </Text>
          ) : (
            <Text>{m.content}</Text>
          )}
        </Box>
      ))}

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
      if (!key.startsWith('sk-')) {
        setErr('看起来不像 DeepSeek key（通常以 sk- 开头）。如确认无误，可忽略——再次回车继续')
        // 第二次回车放行：把错误清掉，但仍保存
        onSave(key)
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
        <Text dimColor>没有检测到 DeepSeek API key，先把它填进来吧。</Text>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <Text>1. 到 </Text>
        <Text color="cyan">https://platform.deepseek.com</Text>
        <Text> 申请并复制你的 API key（以 sk- 开头）。</Text>
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
        <MultilineInput onSubmit={submit} placeholder="sk-..." />
      </Box>
    </Box>
  )
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

function Spinner() {
  const [i, setI] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setI(x => (x + 1) % SPINNER_FRAMES.length), 80)
    return () => clearInterval(id)
  }, [])
  return <Text color="cyan">{SPINNER_FRAMES[i]}</Text>
}

if (argv[0] === 'serve') {
  // QQ 机器人是常驻进程，不进 Ink 界面。动态 import 避免渲染相关依赖被无谓加载。
  const { startQQ } = await import('./channels/qq.js')
  startQQ()
} else {
  render(<App />)
}
