// 可编辑的多行输入框。支持：
//   - 方向键移动光标（上下左右）
//   - Backspace/Delete 删除
//   - Ctrl+A / Ctrl+E 行首/行尾，Ctrl+U 删到行首
//   - Enter 发送；行尾以 "\" 结尾再按 Enter 则换行
//   - 粘贴多行文本
//   - Esc 清空

import { useState } from 'react'
import { Box, Text, useInput } from 'ink'

type Props = {
  onSubmit: (value: string) => void
  disabled?: boolean
  placeholder?: string
}

// 把光标偏移量换算成 [行, 列]
function offsetToLineCol(value: string, offset: number): [number, number] {
  const before = value.slice(0, offset)
  const lines = before.split('\n')
  return [lines.length - 1, lines[lines.length - 1].length]
}

// 把 [行, 列] 换算回偏移量（列会被钳制在该行长度内）
function lineColToOffset(value: string, line: number, col: number): number {
  const lines = value.split('\n')
  const clampedLine = Math.max(0, Math.min(line, lines.length - 1))
  let offset = 0
  for (let i = 0; i < clampedLine; i++) offset += lines[i].length + 1
  offset += Math.min(col, lines[clampedLine].length)
  return offset
}

export default function MultilineInput({ onSubmit, disabled, placeholder }: Props) {
  const [value, setValue] = useState('')
  const [cursor, setCursor] = useState(0)

  useInput(
    (input, key) => {
      // —— 提交 / 换行 ——
      if (key.return) {
        // 行尾反斜杠 => 换行而非发送
        if (value.slice(0, cursor).endsWith('\\')) {
          const next = value.slice(0, cursor - 1) + '\n' + value.slice(cursor)
          setValue(next)
          setCursor(cursor) // 删了 '\'(-1) 又加了 '\n'(+1)
          return
        }
        if (value.trim().length === 0) return
        onSubmit(value)
        setValue('')
        setCursor(0)
        return
      }

      // —— 光标移动 ——
      if (key.leftArrow) {
        setCursor(Math.max(0, cursor - 1))
        return
      }
      if (key.rightArrow) {
        setCursor(Math.min(value.length, cursor + 1))
        return
      }
      if (key.upArrow || key.downArrow) {
        const [line, col] = offsetToLineCol(value, cursor)
        setCursor(lineColToOffset(value, line + (key.upArrow ? -1 : 1), col))
        return
      }

      // —— 行首 / 行尾 / 删除 ——
      if (key.ctrl && input === 'a') {
        const [line] = offsetToLineCol(value, cursor)
        setCursor(lineColToOffset(value, line, 0))
        return
      }
      if (key.ctrl && input === 'e') {
        const [line] = offsetToLineCol(value, cursor)
        setCursor(lineColToOffset(value, line, Infinity))
        return
      }
      if (key.ctrl && input === 'u') {
        const [line, col] = offsetToLineCol(value, cursor)
        const start = lineColToOffset(value, line, 0)
        setValue(value.slice(0, start) + value.slice(cursor))
        setCursor(start)
        void col
        return
      }

      if (key.backspace || key.delete) {
        if (cursor === 0) return
        setValue(value.slice(0, cursor - 1) + value.slice(cursor))
        setCursor(cursor - 1)
        return
      }

      if (key.escape) {
        setValue('')
        setCursor(0)
        return
      }

      // —— 普通字符 / 粘贴 ——（忽略其他控制键）
      if (input && !key.ctrl && !key.meta) {
        setValue(value.slice(0, cursor) + input + value.slice(cursor))
        setCursor(cursor + input.length)
      }
    },
    { isActive: !disabled },
  )

  return (
    <Box borderStyle="round" borderColor={disabled ? 'gray' : 'cyan'} paddingX={1}>
      <Text color="cyan">{'› '}</Text>
      <Box flexGrow={1}>
        {value.length === 0 && !disabled ? (
          <Text>
            <Text inverse> </Text>
            <Text dimColor>{placeholder ?? ''}</Text>
          </Text>
        ) : (
          <CursorText value={value} cursor={cursor} showCursor={!disabled} />
        )}
      </Box>
    </Box>
  )
}

function CursorText({
  value,
  cursor,
  showCursor,
}: {
  value: string
  cursor: number
  showCursor: boolean
}) {
  if (!showCursor) return <Text>{value}</Text>

  const before = value.slice(0, cursor)
  const ch = value[cursor]
  const after = value.slice(cursor + 1)

  if (ch === undefined) {
    return (
      <Text>
        {before}
        <Text inverse> </Text>
      </Text>
    )
  }
  if (ch === '\n') {
    return (
      <Text>
        {before}
        <Text inverse> </Text>
        {'\n'}
        {after}
      </Text>
    )
  }
  return (
    <Text>
      {before}
      <Text inverse>{ch}</Text>
      {after}
    </Text>
  )
}
