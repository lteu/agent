// 本地工具：让模型能真正在这台机器上干活（建文件、读文件、列目录、跑命令）。
// 模型通过 function calling 请求这些工具，由本进程在本地执行后把结果回传。

import { execFile } from 'node:child_process'
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  statSync,
} from 'node:fs'
import { resolve, dirname } from 'node:path'

// 发给 DeepSeek 的工具声明（OpenAI 兼容格式）。
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
] as const

export type ToolCall = {
  id: string
  name: string
  arguments: string // JSON 字符串
}

// 执行单个工具调用，返回给模型看的纯文本结果。
export async function runTool(name: string, args: Record<string, any>): Promise<string> {
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
    default:
      return name
  }
}
