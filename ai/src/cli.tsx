import { useState, useRef, useCallback, useEffect } from 'react'
import { render, Box, Text, useApp, useInput } from 'ink'
import MultilineInput from './MultilineInput.js'
import { streamChat, type ChatMessage } from './deepseek.js'
import { loadConfig, saveApiKey, CONFIG_PATH, DEFAULT_MODEL } from './config.js'

// ———————————————————————————————————————————————
// 命令行参数（在渲染界面之前处理）
// ———————————————————————————————————————————————
const argv = process.argv.slice(2)

if (argv[0] === '--help' || argv[0] === '-h') {
  console.log(`ai — 终端里的可编辑对话框（接入 DeepSeek）

用法:
  ai                  进入交互对话框
  ai --set-key <KEY>  保存 DeepSeek API key 到 ${CONFIG_PATH}
  ai --help           显示帮助

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

const config = loadConfig()

if (!config.apiKey) {
  console.error(`没有找到 DeepSeek API key。

请用以下任一方式设置：
  1) ai --set-key <你的KEY>
  2) export DEEPSEEK_API_KEY=<你的KEY>

到 https://platform.deepseek.com 获取 API key。`)
  process.exit(1)
}

// ———————————————————————————————————————————————
// 界面
// ———————————————————————————————————————————————
type UIMessage = { role: 'user' | 'assistant'; content: string }

function App() {
  const { exit } = useApp()
  const [messages, setMessages] = useState<UIMessage[]>([])
  const [streaming, setStreaming] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const lastCtrlC = useRef(0)
  const abortRef = useRef<AbortController | null>(null)

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
      const history: UIMessage[] = [...messages, { role: 'user', content: text }]
      setMessages(history)
      setBusy(true)
      setStreaming('')

      const apiMessages: ChatMessage[] = history.map(m => ({
        role: m.role,
        content: m.content,
      }))

      const controller = new AbortController()
      abortRef.current = controller
      let acc = ''
      try {
        for await (const delta of streamChat(apiMessages, {
          apiKey: config.apiKey!,
          model: config.model,
          baseURL: config.baseURL,
          signal: controller.signal,
        })) {
          acc += delta
          setStreaming(acc)
        }
        setMessages([...history, { role: 'assistant', content: acc }])
      } catch (e: any) {
        if (controller.signal.aborted) {
          // 用户主动中断：把已生成的部分保留下来
          if (acc) setMessages([...history, { role: 'assistant', content: acc + ' [已中断]' }])
        } else {
          setError(e?.message ?? String(e))
        }
      } finally {
        setStreaming('')
        setBusy(false)
        abortRef.current = null
      }
    },
    [messages],
  )

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
        <Box key={i} flexDirection="column" marginBottom={1}>
          {m.role === 'user' ? (
            <Text color="cyan" bold>
              › {m.content}
            </Text>
          ) : (
            <Text>{m.content}</Text>
          )}
        </Box>
      ))}

      {/* 正在生成 */}
      {busy && (
        <Box flexDirection="column" marginBottom={1}>
          {streaming ? (
            <Text>{streaming}</Text>
          ) : (
            <Text dimColor>
              <Spinner /> 思考中…
            </Text>
          )}
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

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

function Spinner() {
  const [i, setI] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setI(x => (x + 1) % SPINNER_FRAMES.length), 80)
    return () => clearInterval(id)
  }, [])
  return <Text color="cyan">{SPINNER_FRAMES[i]}</Text>
}

render(<App />)
