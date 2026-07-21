/**
 * 有些命令用非零退出码表达正常结果，而不是执行失败。
 * 例如 grep/rg 的 1 表示“没有匹配”，diff 的 1 表示“文件不同”。
 */
export type CommandResultInterpretation = {
  isError: boolean
  message?: string
}

type CommandSemantic = (exitCode: number) => CommandResultInterpretation

const DEFAULT_SEMANTIC: CommandSemantic = exitCode => ({
  isError: exitCode !== 0,
})

const COMMAND_SEMANTICS = new Map<string, CommandSemantic>([
  ['grep', exitCode => ({ isError: exitCode >= 2, message: exitCode === 1 ? '未找到匹配' : undefined })],
  ['rg', exitCode => ({ isError: exitCode >= 2, message: exitCode === 1 ? '未找到匹配' : undefined })],
  ['find', exitCode => ({ isError: exitCode >= 2, message: exitCode === 1 ? '部分目录不可访问' : undefined })],
  ['diff', exitCode => ({ isError: exitCode >= 2, message: exitCode === 1 ? '文件存在差异' : undefined })],
  ['test', exitCode => ({ isError: exitCode >= 2, message: exitCode === 1 ? '条件为假' : undefined })],
  ['[', exitCode => ({ isError: exitCode >= 2, message: exitCode === 1 ? '条件为假' : undefined })],
])

/**
 * 按未被引号包裹的 shell 控制符切分，取决定最终退出码的最后一段命令。
 * 这只是结果语义识别，不参与权限或安全判断。
 */
function lastCommandSegment(command: string): string {
  let start = 0
  let lastNonEmpty = ''
  let quote: "'" | '"' | '`' | null = null
  let escaped = false

  for (let i = 0; i < command.length; i++) {
    const char = command[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\' && quote !== "'") {
      escaped = true
      continue
    }
    if (quote) {
      if (char === quote) quote = null
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char
      continue
    }
    if (char === '|' || char === ';' || char === '\n' || (char === '&' && command[i + 1] === '&')) {
      const segment = command.slice(start, i).trim()
      if (segment) lastNonEmpty = segment
      start = i + (char === '&' ? 2 : 1)
      if (char === '&') i++
    }
  }

  return command.slice(start).trim() || lastNonEmpty
}

function baseCommand(command: string): string {
  const firstWord = lastCommandSegment(command).match(/^\s*([^\s]+)/)?.[1] ?? ''
  return firstWord.slice(firstWord.lastIndexOf('/') + 1)
}

export function interpretShellCommandResult(
  command: string,
  exitCode: number,
): CommandResultInterpretation {
  return (COMMAND_SEMANTICS.get(baseCommand(command)) ?? DEFAULT_SEMANTIC)(exitCode)
}
