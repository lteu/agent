// 本地工具：让模型能真正在这台机器上干活（建文件、读文件、列目录、跑命令）。
// 模型通过 function calling 请求这些工具，由本进程在本地执行后把结果回传。

import { execFile } from 'node:child_process'
import { isUtf8 } from 'node:buffer'
import { createHash } from 'node:crypto'
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  type Dirent,
} from 'node:fs'
import { resolve, dirname, relative, sep, basename } from 'node:path'
import { loadSmtpConfig } from './config.js'
import { writeToolDebugEvent } from './crashlog.js'
import { sendMail, type Attachment } from './smtp.js'
import { getQuotes, formatQuote } from './stocks.js'
import { termOpen, termSend, termRead, termList, termKill } from './term.js'
import {
  browserOpen,
  browserGoto,
  browserSnapshot,
  browserClick,
  browserFill,
  browserSelect,
  browserPress,
  browserScreenshot,
  browserList,
  browserClose,
} from './browser.js'
import { interpretShellCommandResult } from './shell-command-semantics.js'
import { classifyVerificationCommand, type VerificationCheckKind } from './agent/verification-policy.js'
import { managedSubagents, type ManagedSubagentResult } from './agent/subagent-manager.js'
import type { TokenUsage } from './token-usage.js'
import type { LocalToolContentBlock } from './llm.js'
import { compactUrlForDisplay } from './ui-format.js'
import type { FileDiffSnapshot } from './ui-diff.js'
import { PDFParse } from 'pdf-parse'
import XLSX from 'xlsx'
import JSZip from 'jszip'

/** 执行工具时主进程注入的上下文：让 run_agent 这类工具能反过来调用模型。 */
export type ToolContext = {
  apiKey: string
  model: string
  baseURL: string
  provider?: string
  signal?: AbortSignal
  /** 子 agent 递归深度，防止 run_agent 无限自我派生。 */
  depth?: number
  /** 主会话 token 累计器；子 agent 请求也汇总到同一会话。 */
  onUsage?: (usage: TokenUsage) => void
  /** 最近一次 read_file/本进程写入后的文件快照，用于阻止盲写和覆盖外部修改。 */
  readSnapshots?: Map<string, FileReadSnapshot>
  /** 同一路径的写操作串行化，防止同一批并发工具互相覆盖。 */
  fileMutationLocks?: Map<string, Promise<void>>
  /** 单次执行的内部元数据容器；由结构化包装器创建，不在不同调用间共享。 */
  executionMeta?: ToolExecutionMeta
  /** 看图任务的证据闸；成功 view_image 前禁止结构化文件修改。 */
  visualEvidence?: { required: boolean; available: boolean }
}

export type FileReadSnapshot = {
  mtimeMs: number
  size: number
  sha256: string
}

type ToolExecutionMeta = {
  command?: string
  exitCode?: number
  commandIsError?: boolean
  timedOut?: boolean
  cancelled?: boolean
  httpStatus?: number
  fetchAttempts?: number
  fetchError?: string
  fetchErrorCode?: string
  fetchCancelled?: boolean
  readSnapshot?: FileReadSnapshot
}

export type ToolEvidence = {
  kind: 'file_read' | 'image_read' | 'file_write' | 'file_edit' | 'command' | 'test' | 'http' | 'legacy'
  path?: string
  bytes?: number
  replacements?: number
  command?: string
  exitCode?: number
  checkKind?: VerificationCheckKind
  statusCode?: number
  attempts?: number
}

export type ToolResult = {
  ok: boolean
  output: string
  error?: {
    code: string
    /** 给模型和调试日志的完整错误。 */
    message: string
    /** 给普通 UI 的稳定摘要；省略时直接显示 message。 */
    userMessage?: string
  }
  evidence?: ToolEvidence
  /** 只回灌给模型的非文本内容；普通 UI 永远不渲染其中的 base64。 */
  modelContent?: LocalToolContentBlock[]
  /** Before/after text captured inside the file mutation lock for an accurate UI diff. */
  fileDiff?: FileDiffSnapshot
  durationMs: number
}

// 遍历/检索时跳过的目录，避免把 node_modules、.git 等翻个底朝天。
const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'out',
  'coverage', '.cache', '.turbo', '.venv', '__pycache__',
])

// 邮件附件按扩展名猜 MIME 类型，猜不到就用通用二进制类型。
const MIME_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  zip: 'application/zip',
}

const WEB_FETCH_MAX_ATTEMPTS = 3
const MAX_IMAGE_BYTES = 4 * 1024 * 1024
const WEB_FETCH_RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])

function fetchErrorDetails(error: unknown): { message: string; code?: string } {
  const messages: string[] = []
  let code: string | undefined
  let current: unknown = error
  const seen = new Set<unknown>()

  for (let depth = 0; current && depth < 4 && !seen.has(current); depth++) {
    seen.add(current)
    if (current instanceof Error && current.message && !messages.includes(current.message)) {
      messages.push(current.message)
    }
    if (typeof current === 'object') {
      const record = current as Record<string, unknown>
      if (!code && typeof record.code === 'string') code = record.code
      current = record.cause
    } else {
      break
    }
  }

  return {
    message: (messages.join(': ') || String(error)) + (code ? ` [${code}]` : ''),
    code,
  }
}

function waitForWebFetchRetry(attempt: number): Promise<void> {
  return new Promise(resolveWait => setTimeout(resolveWait, 300 * attempt))
}
function guessMime(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  return MIME_TYPES[ext] ?? 'application/octet-stream'
}

function imageMime(buffer: Buffer): LocalToolContentBlock['mediaType'] | undefined {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png'
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg'
  }
  if (buffer.length >= 6 && (buffer.subarray(0, 6).toString('ascii') === 'GIF87a' || buffer.subarray(0, 6).toString('ascii') === 'GIF89a')) {
    return 'image/gif'
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp'
  }
  return undefined
}

/** 递归列出目录下所有文件的绝对路径（自动跳过 IGNORE_DIRS）。 */
function* walkFiles(dir: string): Generator<string> {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const full = resolve(dir, e.name)
    if (e.isDirectory()) {
      if (IGNORE_DIRS.has(e.name)) continue
      yield* walkFiles(full)
    } else if (e.isFile()) {
      yield full
    }
  }
}

/** 把 glob 模式（支持 ** / * / ? 以及字符类）编译成匹配「相对路径」的正则。 */
function globToRegExp(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*' // ** 跨目录
        i++
        if (glob[i + 1] === '/') i++ // 顺带吃掉 **/ 的斜杠
      } else {
        re += '[^/]*' // * 不跨目录
      }
    } else if (c === '?') {
      re += '[^/]'
    } else if ('+.^$()|{}\\'.includes(c)) {
      re += '\\' + c
    } else {
      re += c // 普通字符、/、[]（字符类）原样保留
    }
  }
  return new RegExp('^' + re + '$')
}

// 发给模型的工具声明（OpenAI 兼容格式）。
export const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        '在本地磁盘创建或覆盖一个文件（自动创建所需父目录）。用于「建文档/写文件」这类需求。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径，相对路径相对于当前工作目录' },
          content: { type: 'string', description: '文件完整内容，可为空字符串' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取本地一个文本文件的内容。图片必须改用 view_image；二进制文件会被拒绝，避免把乱码塞入模型上下文。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'view_image',
      description:
        '查看并分析本地图片的真实像素内容（PNG/JPEG/GIF/WebP）。用户提到截图、图片或要求根据画面判断时必须使用；不要用 read_file 或 OCR 代替。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '图片文件路径' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'excel_read',
      description:
        '读取本地 Excel 文件（.xlsx/.xls/.csv）内容，按工作表转成文本表格返回。用于「看看这份表格里有什么/汇总这份 Excel」这类需求。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径' },
          sheet: { type: 'string', description: '只读取指定工作表名，默认读取全部工作表' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pdf_read',
      description:
        '提取本地 PDF 文件的文本内容。用于「看看这份 PDF 写了什么/总结这份 PDF」这类需求。扫描版（图片）PDF 可能提取不到文字。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'powerpoint_read',
      description:
        '提取本地 PowerPoint 文件（.pptx）每页幻灯片的文本内容。用于「看看这份 PPT 讲了什么」这类需求。不支持旧版二进制 .ppt。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: '列出某个目录下的文件与子目录。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '目录路径，默认当前目录', default: '.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_bash',
      description:
        '在本地 shell 执行一条不需要管理员权限的命令并返回 stdout/stderr。用于建目录(mkdir)、移动、运行脚本等。不要在这里使用 sudo；需要管理员权限时改用 run_admin。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的 shell 命令' },
          intent: {
            type: 'string',
            description:
              '这条命令想达成什么，用一句简短中文说明（≤16 字），如「安装缺失依赖」「查看阶段四报错详情」。会显示给用户，让进度可读。',
          },
        },
        required: ['command', 'intent'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_admin',
      description:
        '在 macOS 上执行确实需要管理员权限的 shell 命令。调用后会弹出系统密码授权框，密码只交给 macOS，不会传给 Agent。command 中不要写 sudo；用户取消授权时命令不会执行。',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: '需要以管理员身份执行的命令（不要包含 sudo）',
          },
          intent: {
            type: 'string',
            description:
              '为什么需要管理员权限，用一句简短中文说明（≤16 字），如「更新 hosts 映射」。会在弹框前显示给用户。',
          },
        },
        required: ['command', 'intent'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_email',
      description:
        '通过已配置的 SMTP 邮箱发送一封邮件，可选带附件（如 PDF）。用于「发邮件/把结果邮件给我/把 PDF 发到邮箱」等需求。需先用 ai --set-smtp 配置发件邮箱。',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: '收件人邮箱；多个用英文逗号分隔' },
          subject: { type: 'string', description: '邮件主题' },
          body: { type: 'string', description: '邮件正文（纯文本）' },
          attachment_path: {
            type: 'string',
            description: '可选：要附带发送的本地文件路径（如 PDF），多个用英文逗号分隔',
          },
        },
        required: ['to', 'subject', 'body'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'stock_quote',
      description:
        '查询美股实时报价（数据来自 Yahoo Finance）。用于「某只股票多少钱/涨跌如何」这类需求。',
      parameters: {
        type: 'object',
        properties: {
          symbols: {
            type: 'string',
            description: '股票代码，多个用英文逗号分隔，如 AAPL,TSLA,NVDA',
          },
        },
        required: ['symbols'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        '对已存在文件做精确字符串替换（不重写整个文件）。改动现有代码/文档时优先用它。old_string 必须与文件内容逐字匹配；默认要求唯一匹配，replace_all=true 时替换全部。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径' },
          old_string: { type: 'string', description: '要被替换的原文（含缩进，需逐字匹配）' },
          new_string: { type: 'string', description: '替换后的新内容' },
          replace_all: { type: 'boolean', description: '是否替换全部出现，默认 false' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'glob',
      description:
        '按通配模式查找文件，返回匹配的文件路径（按修改时间从新到旧）。支持 **（跨目录）、*、?。用于「找某类文件」这类需求。',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: '通配模式，如 **/*.ts、src/**/*.tsx' },
          path: { type: 'string', description: '搜索根目录，默认当前目录' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description:
        '在文件内容里按正则搜索，返回命中的 文件:行号:内容。用于「在代码里找某个符号/字符串」这类需求。',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: '正则表达式（JS 语法）' },
          path: { type: 'string', description: '搜索根目录或单个文件，默认当前目录' },
          glob: { type: 'string', description: '只搜匹配此通配模式的文件，如 *.ts' },
          ignore_case: { type: 'boolean', description: '忽略大小写，默认 false' },
          max_results: { type: 'number', description: '最多返回多少行，默认 200' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description:
        '抓取一个网页/接口的内容并返回文本（HTML 会被粗略转成纯文本）。用于「看看这个网址/查在线资料」这类需求。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '要抓取的 URL（http/https）' },
          max_chars: { type: 'number', description: '返回正文最大字符数，默认 20000' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_agent',
      description:
        '启动或续跑一个受管子 agent。每个新 agent 拥有独立上下文和默认 200 步预算，并返回 agent_id、完成状态和结果；达到上限时用同一 agent_id 续跑。用户要求并行时，必须在同一条 assistant 消息中发出多个 run_agent 调用。',
      parameters: {
        type: 'object',
        properties: {
          description: { type: 'string', description: '子任务的简短描述（3-5 个词）' },
          prompt: { type: 'string', description: '交给子 agent 的完整任务说明' },
          agent_id: { type: 'string', description: '可选：续跑先前子 agent 时传回它的 agent_id；新任务不要传' },
          max_steps: { type: 'number', description: '本次最多运行步数，默认 200，范围 1-500' },
        },
        required: ['description', 'prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'skill',
      description:
        '读取一个已安装「技能」(skill) 的完整操作说明。系统提示里列出了可用技能的名字与用途；当用户需求匹配其中某个技能时，先用本工具按名字把手册取进上下文，再照其步骤执行。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '技能名（见系统提示中的技能清单）' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'term_open',
      description:
        '开一个「常驻终端会话」（基于 tmux），跨多轮对话存活。用于启动 claude code 等交互式/长跑程序——run_bash 是一次性、60 秒就超时、每次新 shell，撑不住这类场景，这时改用本工具。开好后用 term_read 看输出、term_send 发后续指令。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '会话名（自取，如 cc、build）。同名已存在则不重开。' },
          command: { type: 'string', description: '可选：开好会话后立即在其中执行的命令，如 claude。留空则只开一个空 shell。' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'term_send',
      description:
        '向某个常驻终端会话发送输入（相当于在它键盘上打字）。默认把 input 当字面文本敲并补一个回车；要发控制键（如 C-c 中断、Up 上一条历史）时把 literal 设为 false。发完通常配合 term_read 看反应。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '会话名（term_open 时取的名字）' },
          input: { type: 'string', description: '要发送的文本；literal=false 时是 tmux 键名，如 C-c、Up、Enter' },
          enter: { type: 'boolean', description: '发完是否补一个回车，默认 true' },
          literal: { type: 'boolean', description: 'true(默认)=按字面文本敲；false=按 tmux 键名敲（发控制键用）' },
        },
        required: ['name', 'input'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'term_read',
      description:
        '读取某个常驻终端会话的当前屏幕 + 最近若干行历史（纯文本），用于「查看执行日志/程序现在输出了什么」。程序输出有延迟时，可用 wait_ms 先等一会儿再抓。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '会话名' },
          lines: { type: 'number', description: '往回取多少行历史，默认 200（上限 5000）' },
          wait_ms: { type: 'number', description: '抓取前先等待的毫秒数，默认 0（上限 10000），给程序留出输出时间' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'term_list',
      description: '列出当前所有常驻终端会话及其状态。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'term_kill',
      description: '结束一个常驻终端会话（会杀掉其中正在运行的程序）。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '会话名' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'screenshot',
      description:
        '截取 macOS 全屏截图（静默，无需人工确认）。返回截图文件路径。用于"截图/截屏/把屏幕发给我"等需求。参数 path 可选，默认保存到 /tmp/screenshot.png。注意：本工具已内置，切勿通过 run_bash 调 screencapture，后者可能触发交互式窗口选择而卡住。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '截图保存路径，默认 /tmp/screenshot.png' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_open',
      description:
        '开一个具名浏览器会话（真实 Chromium 窗口），可选直接打开某个网址。同名会话已存在则不重开。' +
        '打开后会返回当前页面的可交互元素快照（每个元素带一个 ref，如 e1、e2），后续点击/填写都靠这个 ref 定位。' +
        '用于「打开某个网站/帮我在网页上填表/点一下某个按钮」这类需要真实操作浏览器的需求。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '会话名（自取，如 form、login）' },
          url: { type: 'string', description: '可选：打开后立即导航到的网址' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_goto',
      description: '让已有浏览器会话跳转到某个网址，返回跳转后页面的可交互元素快照。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '会话名（browser_open 时取的名字）' },
          url: { type: 'string', description: '要跳转到的网址' },
        },
        required: ['name', 'url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_snapshot',
      description:
        '重新扫描某个浏览器会话当前页面，返回最新的可交互元素快照（ref 列表）。' +
        '你看不到页面截图，只能靠这份文本判断页面上有什么；点击/填写前必须先有一份该会话的最新快照，' +
        '页面因 JS 操作发生变化（如弹出下拉、展开面板）但没有跳转网址时，用它刷新。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '会话名' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_click',
      description: '点击某个浏览器会话里、快照给出的某个 ref 对应的元素（如按钮、链接）。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '会话名' },
          ref: { type: 'string', description: '快照里的元素引用，如 e3' },
        },
        required: ['name', 'ref'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_fill',
      description: '在某个浏览器会话里、快照给出的某个 ref 对应的输入框/文本域中填入文字（会先清空原有内容）。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '会话名' },
          ref: { type: 'string', description: '快照里的元素引用，如 e3' },
          value: { type: 'string', description: '要填入的文字' },
        },
        required: ['name', 'ref', 'value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_select',
      description: '在某个浏览器会话里、快照给出的某个下拉框（select）ref 中选中一个选项（按显示文字匹配）。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '会话名' },
          ref: { type: 'string', description: '快照里的下拉框元素引用，如 e5' },
          value: { type: 'string', description: '要选中的选项文字' },
        },
        required: ['name', 'ref', 'value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_press',
      description:
        '在某个浏览器会话里按下一个键盘按键，如 Enter（提交表单）、Escape（关闭下拉/弹层）、Tab。' +
        '给了 ref 就在该元素上按，不给 ref 就按在页面当前焦点上。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '会话名' },
          key: { type: 'string', description: '按键名，如 Enter、Escape、Tab' },
          ref: { type: 'string', description: '可选：快照里的元素引用，不填则按在当前焦点上' },
        },
        required: ['name', 'key'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_screenshot',
      description: '截取某个浏览器会话当前页面的截图（非全屏，只截页面内容），保存到本地供人查看或后续发送。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '会话名' },
          path: { type: 'string', description: '保存路径，默认 /tmp/browser-<会话名>.png' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_list',
      description: '列出当前所有浏览器会话及其当前标题/网址。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_close',
      description: '关闭一个浏览器会话（结束对应的 Chromium 窗口）。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '会话名' },
        },
        required: ['name'],
      },
    },
  },
] as const

export type ToolCall = {
  id: string
  name: string
  arguments: string // JSON 字符串
}

function fileSnapshot(path: string): FileReadSnapshot {
  const content = readFileSync(path)
  const stat = statSync(path)
  return {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    sha256: createHash('sha256').update(content).digest('hex'),
  }
}

function sameSnapshot(a: FileReadSnapshot, b: FileReadSnapshot): boolean {
  return a.size === b.size && a.sha256 === b.sha256
}

async function withFileMutationLock<T>(
  path: string,
  locks: Map<string, Promise<void>> | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (!locks) return fn()
  const previous = locks.get(path) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>(resolveGate => { release = resolveGate })
  const tail = previous.then(() => gate)
  locks.set(path, tail)
  await previous
  try {
    return await fn()
  } finally {
    release()
    if (locks.get(path) === tail) locks.delete(path)
  }
}

export function validateToolInput(name: string, args: Record<string, unknown>): string | null {
  const schema = (TOOL_SCHEMAS as readonly any[]).find(tool => tool.function.name === name)?.function?.parameters
  if (!schema) return `未知工具: ${name}`
  if (!args || typeof args !== 'object' || Array.isArray(args)) return '工具参数必须是 JSON 对象'

  for (const required of schema.required ?? []) {
    if (!(required in args) || args[required] === undefined || args[required] === null) {
      return `缺少必填参数 ${required}`
    }
  }
  for (const [key, value] of Object.entries(args)) {
    const expected = schema.properties?.[key]?.type
    if (!expected || value === undefined || value === null) continue
    if (expected === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) {
      return `参数 ${key} 必须是有限数字`
    }
    if (expected !== 'number' && typeof value !== expected) return `参数 ${key} 必须是 ${expected}`
  }

  if ((name === 'run_bash' || name === 'run_admin') && !String(args.command ?? '').trim()) {
    return 'command 不能为空'
  }
  if (name === 'run_admin' && containsSudoCommand(String(args.command ?? ''))) {
    return 'run_admin 已经以管理员身份执行，command 中不要再写 sudo'
  }
  if (name === 'edit_file') {
    if (!String(args.old_string ?? '')) return 'old_string 不能为空'
    if (args.old_string === args.new_string) return 'old_string 与 new_string 相同，无需修改'
  }
  if (name === 'web_fetch' && !/^https?:\/\//i.test(String(args.url ?? ''))) {
    return 'url 必须以 http:// 或 https:// 开头'
  }
  return null
}

// sudo 依赖交互式终端输入密码，而 run_bash 的 stdin 是管道；让它继续执行只会报
// “a terminal is required”或一直等到超时。只识别真正位于命令起始/控制符后的 sudo，
// 避免把 `echo sudo` 这类普通文本误判成提权命令。
function containsSudoCommand(command: string): boolean {
  return /(?:^|[;&|(\n]\s*)sudo(?:\s|$)/.test(command)
}

const ADMIN_APPLE_SCRIPT = `
on run argv
  set commandText to item 1 of argv
  set workingDirectory to item 2 of argv
  set privilegedCommand to "cd " & quoted form of workingDirectory & " && " & commandText
  do shell script privilegedCommand with prompt "AI 请求执行管理员命令。请确认这是你刚刚要求的操作。" with administrator privileges
end run
`

function failedToolResult(
  code: string,
  message: string,
  startedAt: number,
  userMessage?: string,
): ToolResult {
  return {
    ok: false,
    output: `错误: ${message}`,
    error: { code, message, userMessage },
    durationMs: Date.now() - startedAt,
  }
}

export function formatToolResult(result: ToolResult): string {
  if (result.ok) return result.output
  const header = `错误[${result.error?.code ?? 'tool_failed'}]: ${result.error?.message ?? '工具执行失败'}`
  return result.output && result.output !== `错误: ${result.error?.message}`
    ? `${header}\n${result.output}`
    : header
}

// 具体工具的文本执行体。结构化状态、证据和运行前校验由下方导出的 runTool 包装。
async function runToolText(
  name: string,
  args: Record<string, any>,
  ctx?: ToolContext,
): Promise<string> {
  switch (name) {
    case 'write_file': {
      const path = resolve(String(args.path))
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, String(args.content ?? ''))
      return `已写入 ${path}（${Buffer.byteLength(String(args.content ?? ''))} 字节）`
    }
    case 'read_file': {
      const path = resolve(String(args.path))
      const content = readFileSync(path)
      const stat = statSync(path)
      if (ctx?.executionMeta) {
        ctx.executionMeta.readSnapshot = {
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          sha256: createHash('sha256').update(content).digest('hex'),
        }
      }
      const text = content.toString('utf8')
      return text.length > 20000 ? text.slice(0, 20000) + '\n…（已截断）' : text
    }
    case 'excel_read': {
      const path = resolve(String(args.path))
      const wb = XLSX.readFile(path)
      const only = String(args.sheet ?? '').trim()
      const names = only ? wb.SheetNames.filter(n => n === only) : wb.SheetNames
      if (!names.length) {
        return only
          ? `未找到工作表「${only}」，可用工作表：${wb.SheetNames.join('、')}`
          : '(工作簿无工作表)'
      }
      const text = names
        .map(n => `# 工作表：${n}\n` + XLSX.utils.sheet_to_csv(wb.Sheets[n]))
        .join('\n\n')
      return text.length > 20000 ? text.slice(0, 20000) + '\n…（已截断）' : text
    }
    case 'pdf_read': {
      const path = resolve(String(args.path))
      const parser = new PDFParse({ data: readFileSync(path) })
      try {
        const result = await parser.getText()
        const text = result.text.trim()
        if (!text) return '(未提取到文本，可能是扫描版 PDF)'
        return text.length > 20000 ? text.slice(0, 20000) + '\n…（已截断）' : text
      } finally {
        await parser.destroy()
      }
    }
    case 'powerpoint_read': {
      const path = resolve(String(args.path))
      const zip = await JSZip.loadAsync(readFileSync(path))
      const slideFiles = Object.keys(zip.files)
        .filter(f => /^ppt\/slides\/slide\d+\.xml$/.test(f))
        .sort((a, b) => {
          const na = Number(a.match(/slide(\d+)\.xml$/)?.[1] ?? 0)
          const nb = Number(b.match(/slide(\d+)\.xml$/)?.[1] ?? 0)
          return na - nb
        })
      if (!slideFiles.length) return '(未找到幻灯片，请确认文件是 .pptx 格式)'
      const decodeXmlEntities = (s: string) =>
        s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      const parts: string[] = []
      for (let i = 0; i < slideFiles.length; i++) {
        const xml = await zip.files[slideFiles[i]].async('string')
        const texts = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map(m => decodeXmlEntities(m[1]))
        parts.push(`# 幻灯片 ${i + 1}\n` + (texts.join('\n') || '(无文本)'))
      }
      const text = parts.join('\n\n')
      return text.length > 20000 ? text.slice(0, 20000) + '\n…（已截断）' : text
    }
    case 'list_dir': {
      const path = resolve(String(args.path ?? '.'))
      const entries = readdirSync(path).map(name => {
        const isDir = statSync(resolve(path, name)).isDirectory()
        return isDir ? name + '/' : name
      })
      return entries.length ? entries.join('\n') : '(空目录)'
    }
    case 'run_bash': {
      const command = String(args.command ?? '')
      if (ctx?.executionMeta) ctx.executionMeta.command = command
      if (ctx?.signal?.aborted) {
        if (ctx.executionMeta) ctx.executionMeta.cancelled = true
        return '（已中断，未执行）'
      }
      return await new Promise<string>(res => {
        execFile(
          '/bin/sh',
          ['-c', command],
          // 把 signal 传给 execFile：用户按 Esc/Ctrl+C 时 Node 会直接 kill 掉子进程（含其子孙），
          // 否则长跑脚本（如 python 训练）会一直占着、loop 卡在 await 上，Esc 形同虚设。
          { timeout: 60_000, maxBuffer: 10 * 1024 * 1024, signal: ctx?.signal, killSignal: 'SIGKILL' },
          (err, stdout, stderr) => {
            // 输出量不设上限的话，一条命令就可能把整轮上下文撑爆（比如误打印了整个大文件）；
            // 和 read_file 等工具一样截断，避免单条工具结果拖垮后续模型调用。
            const cap = (s: string) => (s.length > 20000 ? s.slice(0, 20000) + '\n…（已截断）' : s)
            const out = cap([stdout, stderr].filter(Boolean).join('\n').trim())
            // 被 Esc 中断（AbortError）：明确告知，别把它当成普通命令失败。
            if (err && (err as any).name === 'AbortError') {
              if (ctx?.executionMeta) ctx.executionMeta.cancelled = true
              res(`命令已被用户中断${out ? `\n${out}` : ''}`)
            } else if (err && (err as any).code !== 0) {
              const exitCode = typeof (err as any).code === 'number' ? (err as any).code : 1
              const interpretation = interpretShellCommandResult(command, exitCode)
              if (ctx?.executionMeta) {
                ctx.executionMeta.exitCode = exitCode
                ctx.executionMeta.commandIsError = interpretation.isError
                ctx.executionMeta.timedOut = Boolean((err as any).killed && (err as any).signal === 'SIGKILL')
              }
              if (interpretation.isError) {
                res(`命令退出码 ${exitCode}\n${out || (err as Error).message}`)
              } else {
                res(out || interpretation.message || '(无输出)')
              }
            } else {
              if (ctx?.executionMeta) {
                ctx.executionMeta.exitCode = 0
                ctx.executionMeta.commandIsError = false
              }
              res(out || '(无输出)')
            }
          },
        )
      })
    }
    case 'run_admin': {
      const command = String(args.command ?? '')
      if (ctx?.executionMeta) ctx.executionMeta.command = command
      if (ctx?.signal?.aborted) {
        if (ctx.executionMeta) ctx.executionMeta.cancelled = true
        return '（已中断，未执行）'
      }
      return await new Promise<string>(res => {
        execFile(
          '/usr/bin/osascript',
          ['-e', ADMIN_APPLE_SCRIPT, command, process.cwd()],
          // 给用户留出看到并处理系统授权框的时间；Esc/Ctrl+C 仍会立即终止等待。
          {
            timeout: 300_000,
            maxBuffer: 10 * 1024 * 1024,
            signal: ctx?.signal,
            killSignal: 'SIGKILL',
            // 部分非英文 locale 下，osascript 无法识别 Standard Additions 的英文参数名
            // （如 administrator privileges），固定解析 locale 不影响中文弹框文本。
            env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
          },
          (err, stdout, stderr) => {
            const cap = (s: string) => (s.length > 20000 ? s.slice(0, 20000) + '\n…（已截断）' : s)
            const out = cap([stdout, stderr].filter(Boolean).join('\n').trim())
            if (err && (err as any).name === 'AbortError') {
              if (ctx?.executionMeta) ctx.executionMeta.cancelled = true
              res(`管理员命令已被用户中断${out ? `\n${out}` : ''}`)
            } else if (err) {
              const exitCode = typeof (err as any).code === 'number' ? (err as any).code : 1
              if (ctx?.executionMeta) {
                ctx.executionMeta.exitCode = exitCode
                ctx.executionMeta.commandIsError = true
                ctx.executionMeta.timedOut = Boolean((err as any).killed && (err as any).signal === 'SIGKILL')
              }
              res(`命令退出码 ${exitCode}\n${out || (err as Error).message}`)
            } else {
              if (ctx?.executionMeta) {
                ctx.executionMeta.exitCode = 0
                ctx.executionMeta.commandIsError = false
              }
              res(out || '(管理员命令执行成功，无输出)')
            }
          },
        )
      })
    }
    case 'send_email': {
      const smtp = loadSmtpConfig()
      if (!smtp.user || !smtp.pass) {
        return '未配置发件邮箱。先运行: ai --set-smtp <邮箱> <应用专用密码> [host] [port]'
      }
      const to = String(args.to ?? '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
      if (!to.length) return '收件人为空'
      const attachmentPaths = String(args.attachment_path ?? '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
      let attachments: Attachment[] | undefined
      if (attachmentPaths.length) {
        try {
          attachments = attachmentPaths.map(p => {
            const full = resolve(p)
            return { filename: full.split(sep).pop() || full, content: readFileSync(full), contentType: guessMime(full) }
          })
        } catch (e: any) {
          return `附件读取失败: ${e?.message ?? String(e)}`
        }
      }
      try {
        const sent = await sendMail(
          { host: smtp.host, port: smtp.port, secure: smtp.secure, user: smtp.user, pass: smtp.pass, from: smtp.from! },
          { to, subject: String(args.subject ?? ''), text: String(args.body ?? ''), attachments },
        )
        return `邮件已发送给 ${sent.join(', ')}${attachments ? `（附件 ${attachments.length} 个）` : ''}`
      } catch (e: any) {
        return `发送失败: ${e?.message ?? String(e)}`
      }
    }
    case 'stock_quote': {
      const symbols = String(args.symbols ?? '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
      if (!symbols.length) return '未提供股票代码'
      const results = await getQuotes(symbols)
      return results
        .map(r => (r.quote ? formatQuote(r.quote) : `${r.symbol}: ${r.error}`))
        .join('\n')
    }
    case 'edit_file': {
      const path = resolve(String(args.path))
      const oldStr = String(args.old_string ?? '')
      const newStr = String(args.new_string ?? '')
      if (oldStr === newStr) return 'old_string 与 new_string 相同，无需修改'
      const text = readFileSync(path, 'utf8')
      const count = oldStr ? text.split(oldStr).length - 1 : 0
      if (count === 0) return `未找到要替换的内容（old_string 在 ${path} 中不存在）`
      if (count > 1 && !args.replace_all) {
        return `old_string 在文件中出现 ${count} 次（不唯一）。请提供更多上下文使其唯一，或设 replace_all=true。`
      }
      const next = args.replace_all ? text.split(oldStr).join(newStr) : text.replace(oldStr, newStr)
      writeFileSync(path, next)
      return `已编辑 ${path}（替换 ${args.replace_all ? count : 1} 处）`
    }
    case 'glob': {
      const root = resolve(String(args.path ?? '.'))
      const re = globToRegExp(String(args.pattern ?? '*'))
      const hits: { path: string; mtime: number }[] = []
      for (const f of walkFiles(root)) {
        const rel = relative(root, f).split(sep).join('/')
        if (re.test(rel)) {
          try {
            hits.push({ path: f, mtime: statSync(f).mtimeMs })
          } catch {
            hits.push({ path: f, mtime: 0 })
          }
        }
        if (hits.length > 1000) break
      }
      hits.sort((a, b) => b.mtime - a.mtime)
      return hits.length ? hits.map(h => h.path).join('\n') : '(无匹配文件)'
    }
    case 'grep': {
      const flags = 'g' + (args.ignore_case ? 'i' : '')
      let re: RegExp
      try {
        re = new RegExp(String(args.pattern ?? ''), flags)
      } catch (e: any) {
        return `无效正则: ${e?.message ?? String(e)}`
      }
      const target = resolve(String(args.path ?? '.'))
      const fileFilter = args.glob ? globToRegExp(String(args.glob)) : null
      const max = Number(args.max_results) > 0 ? Number(args.max_results) : 200
      let isFile = false
      try {
        isFile = statSync(target).isFile()
      } catch {
        return `路径不存在: ${target}`
      }
      const files = isFile ? [target] : [...walkFiles(target)]
      const out: string[] = []
      outer: for (const f of files) {
        if (fileFilter) {
          const rel = isFile ? f : relative(target, f).split(sep).join('/')
          const base = f.split(sep).pop() ?? f
          if (!fileFilter.test(rel) && !fileFilter.test(base)) continue
        }
        let text: string
        try {
          text = readFileSync(f, 'utf8')
        } catch {
          continue
        }
        if (text.includes(' ')) continue // 跳过二进制
        const lines = text.split('\n')
        for (let i = 0; i < lines.length; i++) {
          re.lastIndex = 0
          if (re.test(lines[i])) {
            out.push(`${f}:${i + 1}:${lines[i].slice(0, 300)}`)
            if (out.length >= max) break outer
          }
        }
      }
      return out.length ? out.join('\n') : '(无匹配)'
    }
    case 'web_fetch': {
      const url = String(args.url ?? '')
      if (!/^https?:\/\//i.test(url)) return 'url 必须以 http:// 或 https:// 开头'
      const max = Number(args.max_chars) > 0 ? Number(args.max_chars) : 20000
      for (let attempt = 1; attempt <= WEB_FETCH_MAX_ATTEMPTS; attempt++) {
        if (ctx?.executionMeta) ctx.executionMeta.fetchAttempts = attempt
        try {
          const timeoutSignal = AbortSignal.timeout(30_000)
          const signal = ctx?.signal
            ? AbortSignal.any([ctx.signal, timeoutSignal])
            : timeoutSignal
          const res = await fetch(url, {
            headers: { 'User-Agent': 'ai-cli/0.1 (+local agent)' },
            signal,
          })
          if (ctx?.executionMeta) ctx.executionMeta.httpStatus = res.status

          if (WEB_FETCH_RETRYABLE_STATUS.has(res.status) && attempt < WEB_FETCH_MAX_ATTEMPTS) {
            await res.body?.cancel().catch(() => undefined)
            await waitForWebFetchRetry(attempt)
            continue
          }

          const ctype = res.headers.get('content-type') ?? ''
          let body = await res.text()
          if (ctype.includes('html')) {
            body = body
              .replace(/<script[\s\S]*?<\/script>/gi, '')
              .replace(/<style[\s\S]*?<\/style>/gi, '')
              .replace(/<[^>]+>/g, ' ')
              .replace(/&nbsp;/g, ' ')
              .replace(/&amp;/g, '&')
              .replace(/&lt;/g, '<')
              .replace(/&gt;/g, '>')
              .replace(/[ \t]+/g, ' ')
              .replace(/\n\s*\n\s*\n+/g, '\n\n')
              .trim()
          }
          const head = `HTTP ${res.status} ${ctype}\n`
          return head + (body.length > max ? body.slice(0, max) + '\n…（已截断）' : body)
        } catch (error: unknown) {
          if (ctx?.signal?.aborted) {
            if (ctx.executionMeta) ctx.executionMeta.fetchCancelled = true
            return '抓取已中断'
          }

          const detail = fetchErrorDetails(error)
          if (attempt < WEB_FETCH_MAX_ATTEMPTS) {
            await waitForWebFetchRetry(attempt)
            continue
          }

          if (ctx?.executionMeta) {
            ctx.executionMeta.fetchError = detail.message
            ctx.executionMeta.fetchErrorCode = detail.code
          }
          return `抓取失败: ${detail.message}`
        }
      }
      return '抓取失败: 已耗尽重试次数'
    }
    case 'run_agent': {
      if (!ctx) return '当前环境不支持子 agent（缺少模型上下文）'
      if ((ctx.depth ?? 0) >= 2) return '子 agent 嵌套过深，已拒绝继续派生'
      const { runAgent } = await import('./agent/engine.js')
      const result = await managedSubagents.run({
        description: String(args.description ?? ''),
        prompt: String(args.prompt ?? ''),
        agentId: args.agent_id == null ? undefined : String(args.agent_id),
        maxSteps: args.max_steps == null ? undefined : Number(args.max_steps),
        cwd: process.cwd(),
      }, (history, maxSteps) => runAgent(history, {
        apiKey: ctx.apiKey,
        model: ctx.model,
        baseURL: ctx.baseURL,
        provider: ctx.provider,
        signal: ctx.signal,
        maxSteps,
        depth: (ctx.depth ?? 0) + 1,
        onUsage: ctx.onUsage,
        verifyLevel: 0, // 子 agent 自行完成并结构化报告；避免递归调用裁判模型
      }))
      return JSON.stringify(result, null, 2)
    }
    case 'skill': {
      const { readSkill } = await import('./skills.js')
      const skillName = String(args.name ?? '').trim()
      if (!skillName) return '未提供技能名'
      const found = readSkill(skillName)
      if (!found) return `未找到技能「${skillName}」。可用 ai --skills 查看已安装技能。`
      const skillDir = dirname(found.meta.path)
      return (
        `# 技能：${found.meta.name}\n` +
        `（技能目录：${skillDir}，正文里提到的脚本/资源可用相对路径在此目录下引用）\n\n` +
        found.body
      )
    }
    case 'term_open':
      return await termOpen(String(args.name ?? ''), args.command != null ? String(args.command) : undefined)
    case 'term_send':
      return await termSend(
        String(args.name ?? ''),
        String(args.input ?? ''),
        args.enter !== false,
        args.literal !== false,
      )
    case 'term_read':
      return await termRead(String(args.name ?? ''), Number(args.lines) || 200, Number(args.wait_ms) || 0)
    case 'term_list':
      return await termList()
    case 'term_kill':
      return await termKill(String(args.name ?? ''))
    case 'screenshot': {
      const dest = resolve(String(args.path || '/tmp/screenshot.png'))
      const dir = dirname(dest)
      try { mkdirSync(dir, { recursive: true }) } catch { /* 目录已存在则忽略 */ }
      // -x 静默（不发声）、-C 连光标一起截（方便定位）、不传 -i/-w/-s/-W 等任何交互参数
      return await new Promise<string>(res => {
        execFile(
          '/usr/sbin/screencapture',
          ['-x', '-C', dest],
          { timeout: 15_000, signal: ctx?.signal, killSignal: 'SIGKILL' },
          (err, _stdout, stderr) => {
            if (err && (err as any).name === 'AbortError') {
              res('截图已中断')
            } else if (err) {
              const msg = stderr?.trim() || (err as Error).message
              res(`截图失败 (退出码 ${(err as any).code ?? 1}): ${msg}`)
            } else {
              res(`截图已保存至 ${dest}`)
            }
          },
        )
      })
    }
    case 'browser_open':
      return await browserOpen(String(args.name ?? ''), args.url != null ? String(args.url) : undefined)
    case 'browser_goto':
      return await browserGoto(String(args.name ?? ''), String(args.url ?? ''))
    case 'browser_snapshot':
      return await browserSnapshot(String(args.name ?? ''))
    case 'browser_click':
      return await browserClick(String(args.name ?? ''), String(args.ref ?? ''))
    case 'browser_fill':
      return await browserFill(String(args.name ?? ''), String(args.ref ?? ''), String(args.value ?? ''))
    case 'browser_select':
      return await browserSelect(String(args.name ?? ''), String(args.ref ?? ''), String(args.value ?? ''))
    case 'browser_press':
      return await browserPress(String(args.name ?? ''), String(args.key ?? ''), args.ref != null ? String(args.ref) : undefined)
    case 'browser_screenshot':
      return await browserScreenshot(String(args.name ?? ''), args.path != null ? String(args.path) : undefined)
    case 'browser_list':
      return await browserList()
    case 'browser_close':
      return await browserClose(String(args.name ?? ''))
    default:
      return `未知工具: ${name}`
  }
}

/**
 * 执行内置工具并返回机器可判定的状态与证据。
 * 给模型看的字符串由 formatToolResult 单独生成，控制流不再依赖输出文案。
 */
export async function runTool(
  name: string,
  args: Record<string, any>,
  ctx?: ToolContext,
): Promise<ToolResult> {
  const startedAt = Date.now()
  const validationError = validateToolInput(name, args)
  if (validationError) {
    writeToolDebugEvent('tool_input_validation_failed', { toolName: name, error: validationError })
    return failedToolResult('invalid_input', validationError, startedAt, '工具参数无效')
  }

  if (name === 'run_bash' && containsSudoCommand(String(args.command ?? ''))) {
    return failedToolResult(
      'use_admin_dialog',
      'run_bash 无法交互式读取 sudo 密码；请改用 run_admin，并从 command 中去掉 sudo',
      startedAt,
      '需要管理员权限，将改用 macOS 系统授权框',
    )
  }
  if (name === 'run_admin' && process.platform !== 'darwin') {
    return failedToolResult(
      'unsupported_platform',
      'run_admin 的系统授权框目前只支持 macOS',
      startedAt,
    )
  }

  const snapshots = ctx?.readSnapshots ?? new Map<string, FileReadSnapshot>()
  const locks = ctx?.fileMutationLocks
  const meta: ToolExecutionMeta = {}
  const executionContext = ctx ? { ...ctx, readSnapshots: snapshots, executionMeta: meta } : { readSnapshots: snapshots, executionMeta: meta }

  try {
    if (name === 'view_image') {
      const path = resolve(String(args.path))
      const content = readFileSync(path)
      const mediaType = imageMime(content)
      if (!mediaType) {
        return failedToolResult(
          'unsupported_image',
          `不支持的图片格式：${path}；仅支持 PNG/JPEG/GIF/WebP`,
          startedAt,
          '图片格式不受支持',
        )
      }
      if (content.length > MAX_IMAGE_BYTES) {
        return failedToolResult(
          'image_too_large',
          `图片大小 ${(content.length / 1024 / 1024).toFixed(1)} MB，超过 ${MAX_IMAGE_BYTES / 1024 / 1024} MB 上限；请先缩小图片`,
          startedAt,
          '图片过大，需要先缩小',
        )
      }
      if (ctx?.visualEvidence) ctx.visualEvidence.available = true
      return {
        ok: true,
        output: `已加载图片 ${basename(path)}（${mediaType}，${content.length} 字节）；请根据随工具结果传入的真实图片像素进行分析。`,
        modelContent: [{ type: 'image', mediaType, data: content.toString('base64') }],
        evidence: { kind: 'image_read', path, bytes: content.length },
        durationMs: Date.now() - startedAt,
      }
    }

    if (name === 'read_file') {
      const path = resolve(String(args.path))
      const content = readFileSync(path)
      if (imageMime(content)) {
        return failedToolResult(
          'image_requires_view_image',
          `read_file 只能读取文本；图片 ${path} 必须使用 view_image 才能把真实像素传给模型`,
          startedAt,
          '图片请使用 view_image',
        )
      }
      if (!isUtf8(content) || content.includes(0)) {
        return failedToolResult(
          'binary_file',
          `read_file 拒绝读取二进制文件：${path}；请使用对应的专用工具`,
          startedAt,
          '不能把二进制文件作为文本读取',
        )
      }
      const stat = statSync(path)
      const snapshot = {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        sha256: createHash('sha256').update(content).digest('hex'),
      }
      snapshots.set(path, snapshot)
      const text = content.toString('utf8')
      const output = text.length > 20000 ? text.slice(0, 20000) + '\n…（已截断）' : text
      return {
        ok: true,
        output,
        evidence: { kind: 'file_read', path, bytes: snapshot.size },
        durationMs: Date.now() - startedAt,
      }
    }

    if (name === 'write_file' || name === 'edit_file') {
      const path = resolve(String(args.path))
      if (ctx?.visualEvidence?.required && !ctx.visualEvidence.available) {
        return failedToolResult(
          'visual_evidence_required',
          '当前任务要求分析图片；必须先成功调用 view_image 查看真实像素，不能根据文件名或文字描述猜测后修改文件',
          startedAt,
          '需要先成功查看图片',
        )
      }
      return await withFileMutationLock(path, locks, async () => {
        let before: FileReadSnapshot | null = null
        try { before = fileSnapshot(path) } catch { /* 新文件 */ }
        const beforeContent = before ? readFileSync(path, 'utf8') : ''

        if (before) {
          const known = snapshots.get(path)
          if (!known) {
            return failedToolResult(
              'file_not_read',
              `修改已有文件前必须先用 read_file 读取：${path}`,
              startedAt,
            )
          }
          if (!sameSnapshot(known, before)) {
            return failedToolResult(
              'stale_file',
              `文件在读取后已被其他进程修改，请重新 read_file 后再编辑：${path}`,
              startedAt,
            )
          }
        } else if (name === 'edit_file') {
          return failedToolResult('file_not_found', `目标文件不存在：${path}`, startedAt)
        }

        let replacements: number | undefined
        if (name === 'edit_file') {
          const text = readFileSync(path, 'utf8')
          const oldString = String(args.old_string)
          const count = text.split(oldString).length - 1
          if (count === 0) return failedToolResult('no_match', `old_string 在 ${path} 中不存在`, startedAt)
          if (count > 1 && !args.replace_all) {
            return failedToolResult(
              'ambiguous_match',
              `old_string 在文件中出现 ${count} 次；请增加上下文或设置 replace_all=true`,
              startedAt,
            )
          }
          replacements = args.replace_all ? count : 1
        }

        const output = await runToolText(name, args, executionContext)
        const after = fileSnapshot(path)
        const afterContent = readFileSync(path, 'utf8')
        snapshots.set(path, after)
        return {
          ok: true,
          output,
          evidence: {
            kind: name === 'write_file' ? 'file_write' : 'file_edit',
            path,
            bytes: after.size,
            replacements,
          },
          fileDiff: {
            path,
            before: beforeContent,
            after: afterContent,
            created: before === null,
          },
          durationMs: Date.now() - startedAt,
        }
      })
    }

    const output = await runToolText(name, args, executionContext)

    if (name === 'run_agent') {
      let agentResult: ManagedSubagentResult
      try {
        agentResult = JSON.parse(output) as ManagedSubagentResult
      } catch {
        return failedToolResult('agent_protocol_error', '子 agent 返回了无效状态数据', startedAt)
      }
      const ok = agentResult.status === 'completed'
      return {
        ok,
        output,
        error: ok ? undefined : {
          code: `agent_${agentResult.status}`,
          message: agentResult.message ?? `子 agent 状态：${agentResult.status}`,
          userMessage: agentResult.status === 'max_steps'
            ? '子 agent 达到轮次上限，可从原上下文续跑'
            : `子 agent 未完成：${agentResult.status}`,
        },
        evidence: { kind: 'legacy' },
        durationMs: Date.now() - startedAt,
      }
    }

    if (name === 'run_bash' || name === 'run_admin') {
      const command = String(args.command)
      const checkKind = classifyVerificationCommand(command) ?? undefined
      const ok = !meta.cancelled && !meta.timedOut && meta.commandIsError !== true
      const code = meta.cancelled ? 'cancelled' : meta.timedOut ? 'timed_out' : 'non_zero_exit'
      return {
        ok,
        output,
        error: ok ? undefined : { code, message: output.split('\n')[0] || '命令执行失败' },
        evidence: {
          kind: checkKind ? 'test' : 'command',
          command,
          exitCode: meta.exitCode,
          checkKind,
        },
        durationMs: Date.now() - startedAt,
      }
    }

    if (name === 'web_fetch') {
      if (meta.fetchCancelled) {
        return {
          ok: false,
          output,
          error: { code: 'cancelled', message: '网页抓取已取消', userMessage: '网页抓取已取消' },
          evidence: { kind: 'http', attempts: meta.fetchAttempts },
          durationMs: Date.now() - startedAt,
        }
      }
      if (meta.fetchError) {
        let hostname = ''
        try { hostname = new URL(String(args.url)).hostname } catch { /* 已在输入校验处理 */ }
        writeToolDebugEvent('web_fetch_failed', {
          hostname,
          attempts: meta.fetchAttempts,
          errorCode: meta.fetchErrorCode,
          error: meta.fetchError,
        })
        return {
          ok: false,
          output,
          error: {
            code: 'network_error',
            message: meta.fetchError,
            userMessage: '网页抓取失败，Agent 将尝试其他方式',
          },
          evidence: { kind: 'http', attempts: meta.fetchAttempts },
          durationMs: Date.now() - startedAt,
        }
      }

      const statusCode = meta.httpStatus
      const ok = statusCode !== undefined && statusCode >= 200 && statusCode < 400
      return {
        ok,
        output,
        error: ok ? undefined : {
          code: 'http_error',
          message: statusCode === undefined ? '网页抓取未返回 HTTP 状态' : `HTTP ${statusCode}`,
          userMessage: '网页抓取失败，Agent 将尝试其他方式',
        },
        evidence: { kind: 'http', statusCode, attempts: meta.fetchAttempts },
        durationMs: Date.now() - startedAt,
      }
    }

    // 尚未逐个结构化的外部/交互工具先统一包装；软失败只在这个兼容层识别。
    const legacyFailure = summarizeToolFailure(name, output)
    return {
      ok: legacyFailure === null,
      output,
      error: legacyFailure ? { code: 'legacy_failure', message: legacyFailure } : undefined,
      evidence: { kind: 'legacy' },
      durationMs: Date.now() - startedAt,
    }
  } catch (error: any) {
    return failedToolResult('exception', error?.message ?? String(error), startedAt)
  }
}

// 把命令裁到 max 字符，超出补省略号（让用户知道还有后续）。
function clip(s: string, max: number): string {
  s = s.trim()
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

// 把 run_bash 命令渲染成命令标签：模型每次都在新 shell 里跑，习惯加 `cd <长路径> && 真命令` 前缀，
// 直接截断会把所有行都截成同一段 cd、把真正干的事全切掉。这里把 cd 前缀剥成「目录名」标签，
// 余下的真命令完整展示，让每一行都各有其义。分隔符 `&&`、`;`、换行都认（模型也常用换行串多条命令）。
// 只返回命令部分，不含「运行」动词——动词留给 describeToolCall 按是否有 intent 决定。
function bashLabel(raw: string): string {
  const command = raw.trim()
  // 匹配前导 `cd <路径>` + 分隔符（&&、; 或换行），路径支持引号包裹。
  // 分隔符前只吃同行空白（[ \t]*），这样裸换行也能当分隔符，不会被 \s* 提前吞掉。
  const m = command.match(/^cd\s+(?:'([^']*)'|"([^"]*)"|(\S+))[ \t]*(?:&&|;|\n)\s*([\s\S]+)$/)
  if (m) {
    const dir = (m[1] ?? m[2] ?? m[3] ?? '').replace(/\/+$/, '')
    const base = dir.split('/').filter(Boolean).pop() || dir || '/'
    // 余下若还是多行脚本，只取第一条有内容的命令，省略号示意还有后续。
    const rest = m[4].split('\n').map(s => s.trim()).filter(Boolean)
    const head = rest[0] + (rest.length > 1 ? ' …' : '')
    return `[${base}] \`${clip(head, 72)}\``
  }
  // 纯 cd（没有后续命令）本身没什么信息量，直接说进了哪个目录。
  const onlyCd = command.match(/^cd\s+(?:'([^']*)'|"([^"]*)"|(\S+))\s*$/)
  if (onlyCd) {
    const dir = (onlyCd[1] ?? onlyCd[2] ?? onlyCd[3] ?? '').replace(/\/+$/, '')
    return `进入目录 ${dir.split('/').filter(Boolean).pop() || dir}`
  }
  return `\`${clip(command, 80)}\``
}

// 从工具结果里判断是否「失败」并提炼一句给用户看的原因；非失败返回 null。
// 工具结果本来只回灌给模型，用户在终端只看到调用前的进度行，脚本一旦失败就只剩一片茫然。
// 这里把失败原因捞出来，供 UI 紧跟在进度行后面显示。
export function summarizeToolFailure(name: string, result: string): string | null {
  const r = result.trim()
  if (!r) return null
  // run_bash：失败时是 `命令退出码 N\n<stdout+stderr>`，真正的原因一般在输出最后一行
  // （Python traceback 的最后一行就是异常本身）。
  const exit = r.match(/^命令退出码\s+(\S+)\n([\s\S]*)$/)
  if (exit) {
    const lines = exit[2].split('\n').map(s => s.trim()).filter(Boolean)
    const reason = lines[lines.length - 1] ?? ''
    return `退出码 ${exit[1]}` + (reason ? `：${clip(reason, 100)}` : '')
  }
  // execTool 捕获的抛错，以及各工具返回的软失败文案（取首行即可）。
  if (
    /^错误[:：]/.test(r) ||
    /^(发送失败|抓取失败|无效正则|未找到|路径不存在|打开浏览器失败|跳转失败|点击失败|填写失败|选择失败|按键失败)/.test(r)
  ) {
    return clip(r.split('\n')[0], 120)
  }
  return null
}

// 给状态栏/历史显示用的一句话摘要。
export function describeToolCall(name: string, args: Record<string, any>): string {
  switch (name) {
    case 'write_file':
      return `写文件 ${args.path}`
    case 'read_file':
      return `读文件 ${args.path}`
    case 'view_image':
      return `查看图片 ${args.path}`
    case 'excel_read':
      return `读表格 ${args.path}`
    case 'pdf_read':
      return `读 PDF ${args.path}`
    case 'powerpoint_read':
      return `读 PPT ${args.path}`
    case 'list_dir':
      return `列目录 ${args.path ?? '.'}`
    case 'run_bash': {
      // intent 是普通视图的标题。存在时不再把原始命令拼进标题；
      // 完整命令仍保存在工具 detail 中，可在 Ctrl+O transcript 查看。
      const intent = String(args.intent ?? '').trim()
      const label = bashLabel(String(args.command ?? ''))
      if (label.startsWith('进入目录')) return label // 纯 cd 本身已自解释，无需再缀意图
      return intent || `运行 ${label}`
    }
    case 'run_admin': {
      const intent = String(args.intent ?? '').trim()
      return intent
        ? `${intent}（系统授权）`
        : `执行管理员命令 ${bashLabel(String(args.command ?? ''))}（系统授权）`
    }
    case 'send_email':
      return `发邮件给 ${args.to}`
    case 'send_image':
      return `发图片 ${args.path}`
    case 'send_file':
      return `发文件 ${args.path}`
    case 'stock_quote':
      return `查行情 ${args.symbols}`
    case 'edit_file':
      return `编辑 ${args.path}`
    case 'glob':
      return `查找 ${args.pattern}`
    case 'grep':
      return `检索 /${String(args.pattern ?? '').slice(0, 60)}/`
    case 'web_fetch':
      return `抓取 ${compactUrlForDisplay(String(args.url ?? ''))}`
    case 'run_agent':
      return args.agent_id
        ? `续跑子 agent ${args.agent_id}：${args.description ?? ''}`
        : `启动子 agent：${args.description ?? ''}`
    case 'skill':
      return `技能 ${args.name ?? ''}`
    case 'term_open':
      return args.command ? `开终端 ${args.name} ▶ ${clip(String(args.command), 40)}` : `开终端 ${args.name}`
    case 'term_send':
      return `→ 终端 ${args.name}: ${clip(String(args.input ?? ''), 40)}`
    case 'term_read':
      return `读终端 ${args.name}`
    case 'term_list':
      return '列出终端会话'
    case 'term_kill':
      return `结束终端 ${args.name}`
    case 'browser_open':
      return args.url
        ? `开浏览器 ${args.name} ▶ ${compactUrlForDisplay(String(args.url))}`
        : `开浏览器 ${args.name}`
    case 'browser_goto':
      return `浏览器 ${args.name} 跳转 ${compactUrlForDisplay(String(args.url ?? ''))}`
    case 'browser_snapshot':
      return `浏览器 ${args.name} 快照`
    case 'browser_click':
      return `浏览器 ${args.name} 点击 ${args.ref}`
    case 'browser_fill':
      return `浏览器 ${args.name} 填写 ${args.ref}`
    case 'browser_select':
      return `浏览器 ${args.name} 选择 ${args.ref}`
    case 'browser_press':
      return `浏览器 ${args.name} 按键 ${args.key}`
    case 'browser_screenshot':
      return `浏览器 ${args.name} 截图`
    case 'browser_list':
      return '列出浏览器会话'
    case 'browser_close':
      return `关闭浏览器 ${args.name}`
    case 'list_mcp_resources':
      return args.server ? `列 MCP resources · ${args.server}` : '列 MCP resources'
    case 'read_mcp_resource':
      return `读 MCP resource · ${args.server ?? ''} ${args.uri ?? ''}`.trim()
    default:
      if (name.startsWith('mcp__')) {
        const [, server = '', ...toolParts] = name.split('__')
        return `MCP ${server} · ${toolParts.join('__') || name}`
      }
      return name
  }
}

/** 工具结束后的 UI 摘要。默认界面只沉淀这一行，运行中的同一调用由 UI 原地更新。 */
export function describeToolSuccess(
  name: string,
  args: Record<string, any>,
  result: ToolResult,
): string {
  const evidence = result.evidence
  const details: string[] = []
  if (evidence?.kind === 'http' && evidence.statusCode !== undefined) {
    details.push(`HTTP ${evidence.statusCode}`)
  }
  if ((evidence?.attempts ?? 0) > 1) {
    details.push(`${evidence!.attempts} 次尝试`)
  }
  const suffix = details.length ? `（${details.join('，')}）` : ''
  return `✓ ${describeToolCall(name, args)}${suffix}`
}

/** 失败摘要必须保留调用标题，否则并行调用时“退出码 1”无法对应到原命令。 */
export function describeToolFailure(
  name: string,
  args: Record<string, any>,
  result: ToolResult,
): string {
  const reason = result.error?.userMessage ?? result.error?.message ?? '工具执行失败'
  return `✗ ${describeToolCall(name, args)} · ${reason}`
}
