// 可编辑的多行输入框。支持：
//   - 方向键移动光标（上下左右）
//   - Backspace/Delete 删除
//   - Ctrl+A / Ctrl+E 行首/行尾，Ctrl+U 删到行首
//   - Enter 发送；行尾以 "\" 结尾再按 Enter 则换行
//   - 粘贴多行文本
//   - Esc 清空
//
// 状态用 ref 承载、再 bump 触发重渲染：因为 Ink 在一次 stdin 数据块里可能
// 连续触发多次 useInput（快速输入 / 粘贴 / 方向键和字符混在一起时），若直接
// 读闭包里的 value/cursor，React 18 的批处理会让这几次回调都基于同一份「旧」
// 状态计算，导致后写覆盖前写——字符丢失、光标错位。ref 是同步的，每次回调都
// 能拿到上一次的结果，从根上消除这个竞态。

import { useRef, useReducer } from 'react'
import { Box, Text, useInput } from 'ink'
import { recordInput } from './crashlog.js'

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
  // ref 是同步的「真相源」，state 仅用来触发重渲染。
  const valueRef = useRef('')
  const cursorRef = useRef(0)
  const [, bump] = useReducer((n: number) => n + 1, 0)

  // —— 命令历史 ——
  // historyRef：已提交过的输入，最新的在末尾。
  // histPosRef：当前浏览位置；等于 history.length 表示「正在编辑新内容」。
  // draftRef：进入历史浏览前，把正在编辑的草稿暂存起来，翻回最底时还原。
  const historyRef = useRef<string[]>([])
  const histPosRef = useRef(0)
  const draftRef = useRef('')

  // 统一的状态写入：钳制光标到合法范围，再触发一次重渲染。
  const set = (value: string, cursor: number) => {
    valueRef.current = value
    cursorRef.current = Math.max(0, Math.min(cursor, value.length))
    bump()
  }

  // 翻历史：dir = -1 往旧翻，+1 往新翻。返回 true 表示已处理。
  const navigateHistory = (dir: -1 | 1): boolean => {
    const history = historyRef.current
    if (history.length === 0) return false
    let pos = histPosRef.current
    // 第一次往上翻时，把当前草稿存起来
    if (pos === history.length) draftRef.current = valueRef.current
    pos = Math.max(0, Math.min(history.length, pos + dir))
    histPosRef.current = pos
    const next = pos === history.length ? draftRef.current : history[pos]
    set(next, next.length)
    return true
  }

  useInput(
    (input, key) => {
      recordInput(input, key as unknown as Record<string, unknown>)
      const value = valueRef.current
      const cursor = cursorRef.current

      // —— 提交 / 换行 ——
      if (key.return) {
        // 行尾反斜杠 => 换行而非发送
        if (value.slice(0, cursor).endsWith('\\')) {
          set(value.slice(0, cursor - 1) + '\n' + value.slice(cursor), cursor) // 删 '\'(-1) 加 '\n'(+1)
          return
        }
        if (value.trim().length === 0) return
        // 记入历史（与上一条相同则不重复），并把浏览位置复位到底部
        const history = historyRef.current
        if (history[history.length - 1] !== value) history.push(value)
        histPosRef.current = history.length
        draftRef.current = ''
        set('', 0)
        onSubmit(value)
        return
      }

      // —— 光标移动 ——
      if (key.leftArrow) {
        set(value, cursor - 1)
        return
      }
      if (key.rightArrow) {
        set(value, cursor + 1)
        return
      }
      if (key.upArrow || key.downArrow) {
        const [line, col] = offsetToLineCol(value, cursor)
        const lastLine = value.split('\n').length - 1
        // 光标在第一行按 ↑ / 在最后一行按 ↓：翻命令历史；否则在多行内移动光标。
        if (key.upArrow && line === 0) {
          if (navigateHistory(-1)) return
        }
        if (key.downArrow && line === lastLine) {
          if (navigateHistory(1)) return
        }
        set(value, lineColToOffset(value, line + (key.upArrow ? -1 : 1), col))
        return
      }

      // —— 行首 / 行尾 / 删除 ——
      if (key.ctrl && input === 'a') {
        const [line] = offsetToLineCol(value, cursor)
        set(value, lineColToOffset(value, line, 0))
        return
      }
      if (key.ctrl && input === 'e') {
        const [line] = offsetToLineCol(value, cursor)
        set(value, lineColToOffset(value, line, Infinity))
        return
      }
      if (key.ctrl && input === 'u') {
        const [line] = offsetToLineCol(value, cursor)
        const start = lineColToOffset(value, line, 0)
        set(value.slice(0, start) + value.slice(cursor), start)
        return
      }

      if (key.backspace || key.delete) {
        if (cursor === 0) return
        set(value.slice(0, cursor - 1) + value.slice(cursor), cursor - 1)
        return
      }

      if (key.escape) {
        set('', 0)
        return
      }

      // —— 普通字符 / 粘贴 ——（忽略其他控制键）
      if (input && !key.ctrl && !key.meta) {
        set(value.slice(0, cursor) + input + value.slice(cursor), cursor + input.length)
      }
    },
    { isActive: !disabled },
  )

  const value = valueRef.current
  const cursor = cursorRef.current

  return (
    <Box borderStyle="round" borderColor={disabled ? 'gray' : 'cyan'} paddingX={1}>
      <Text color={disabled ? 'gray' : 'cyan'} bold>{'❯ '}</Text>
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
