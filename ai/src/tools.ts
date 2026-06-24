// 本地工具：让模型能真正在这台机器上干活（建文件、读文件、列目录、跑命令）。
// 模型通过 function calling 请求这些工具，由本进程在本地执行后把结果回传。

import { execFile } from 'node:child_process'
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  type Dirent,
} from 'node:fs'
import { resolve, dirname, relative, sep } from 'node:path'
import { loadSmtpConfig } from './config.js'
import { sendMail } from './smtp.js'
import { getQuotes, formatQuote } from './stocks.js'
import type { ChatMessage } from './llm.js'

/** 执行工具时主进程注入的上下文：让 run_agent 这类工具能反过来调用模型。 */
export type ToolContext = {
  apiKey: string
  model: string
  baseURL: string
  provider?: string
  signal?: AbortSignal
  /** 子 agent 递归深度，防止 run_agent 无限自我派生。 */
  depth?: number
}

// 遍历/检索时跳过的目录，避免把 node_modules、.git 等翻个底朝天。
const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'out',
  'coverage', '.cache', '.turbo', '.venv', '__pycache__',
])

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
      description: '读取本地一个文本文件的内容。',
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
        '在本地 shell 执行一条命令并返回 stdout/stderr。用于建目录(mkdir)、移动、运行脚本等。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的 shell 命令' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_email',
      description:
        '通过已配置的 SMTP 邮箱发送一封纯文本邮件。用于「发邮件/把结果邮件给我」等需求。需先用 ai --set-smtp 配置发件邮箱。',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: '收件人邮箱；多个用英文逗号分隔' },
          subject: { type: 'string', description: '邮件主题' },
          body: { type: 'string', description: '邮件正文（纯文本）' },
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
        '派生一个子 agent 独立完成一项较复杂的子任务（它自带全套本地工具，会自己读写文件、跑命令、检索代码），完成后返回结果摘要。适合「调研/多步骤搜索」这类需要展开但你只想要结论的工作。',
      parameters: {
        type: 'object',
        properties: {
          description: { type: 'string', description: '子任务的简短描述（3-5 个词）' },
          prompt: { type: 'string', description: '交给子 agent 的完整任务说明' },
        },
        required: ['description', 'prompt'],
      },
    },
  },
] as const

export type ToolCall = {
  id: string
  name: string
  arguments: string // JSON 字符串
}

// 执行单个工具调用，返回给模型看的纯文本结果。
// ctx 仅 run_agent 这类需要回调模型的工具用得到，其余工具忽略它。
export async function runTool(
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
      const text = readFileSync(path, 'utf8')
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
      return await new Promise<string>(res => {
        execFile(
          '/bin/sh',
          ['-c', command],
          { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 },
          (err, stdout, stderr) => {
            const out = [stdout, stderr].filter(Boolean).join('\n').trim()
            if (err && (err as any).code !== 0) {
              res(`命令退出码 ${(err as any).code ?? 1}\n${out || (err as Error).message}`)
            } else {
              res(out || '(无输出)')
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
      try {
        const sent = await sendMail(
          { host: smtp.host, port: smtp.port, secure: smtp.secure, user: smtp.user, pass: smtp.pass, from: smtp.from! },
          { to, subject: String(args.subject ?? ''), text: String(args.body ?? '') },
        )
        return `邮件已发送给 ${sent.join(', ')}`
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
      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': 'ai-cli/0.1 (+local agent)' },
          signal: AbortSignal.timeout(30_000),
        })
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
      } catch (e: any) {
        return `抓取失败: ${e?.message ?? String(e)}`
      }
    }
    case 'run_agent': {
      if (!ctx) return '当前环境不支持子 agent（缺少模型上下文）'
      if ((ctx.depth ?? 0) >= 2) return '子 agent 嵌套过深，已拒绝继续派生'
      const { runAgent } = await import('./agent/engine.js')
      const sys =
        `你是被主 agent 派生的子 agent，需独立完成下面这项子任务，完成后用简洁中文汇报结论。` +
        `当前工作目录 ${process.cwd()}。你具备全套本地工具（读写/编辑文件、列目录、执行命令、glob/grep 检索、抓网页等），需要时直接调用，不要拒绝本地操作。`
      const history: ChatMessage[] = [
        { role: 'system', content: sys },
        { role: 'user', content: String(args.prompt ?? args.description ?? '') },
      ]
      const texts: string[] = []
      for await (const ev of runAgent(history, {
        apiKey: ctx.apiKey,
        model: ctx.model,
        baseURL: ctx.baseURL,
        provider: ctx.provider,
        signal: ctx.signal,
        maxSteps: 15,
        depth: (ctx.depth ?? 0) + 1,
      })) {
        if (ev.type === 'text' && ev.content) texts.push(ev.content)
      }
      return texts.join('\n').trim() || '(子 agent 无输出)'
    }
    default:
      return `未知工具: ${name}`
  }
}

// 给状态栏/历史显示用的一句话摘要。
export function describeToolCall(name: string, args: Record<string, any>): string {
  switch (name) {
    case 'write_file':
      return `写文件 ${args.path}`
    case 'read_file':
      return `读文件 ${args.path}`
    case 'list_dir':
      return `列目录 ${args.path ?? '.'}`
    case 'run_bash':
      return `运行 \`${String(args.command ?? '').slice(0, 80)}\``
    case 'send_email':
      return `发邮件给 ${args.to}`
    case 'stock_quote':
      return `查行情 ${args.symbols}`
    case 'edit_file':
      return `编辑 ${args.path}`
    case 'glob':
      return `查找 ${args.pattern}`
    case 'grep':
      return `检索 /${String(args.pattern ?? '').slice(0, 60)}/`
    case 'web_fetch':
      return `抓取 ${args.url}`
    case 'run_agent':
      return `子 agent：${args.description ?? ''}`
    default:
      return name
  }
}
