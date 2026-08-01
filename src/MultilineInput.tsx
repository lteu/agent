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
import {
  expandPastedTextRefs,
  formatPastedTextRef,
  normalizePastedText,
  prunePastedTextRefs,
  shouldCollapsePaste,
} from './pasted-text.js'
import { stripSgrMouseSequences } from './ui-transcript.js'

type Props = {
  onSubmit: (value: string) => void
  disabled?: boolean
  placeholder?: string
  topRightLabel?: string
  accentColor?: string
  width?: number
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

const DEFAULT_ACCENT = '#9A7418'
type InputHistoryEntry = {
  display: string
  pastedContents: Map<number, string>
}

export default function MultilineInput({
  onSubmit,
  disabled,
  placeholder,
  topRightLabel,
  accentColor = DEFAULT_ACCENT,
  width,
}: Props) {
  // ref 是同步的「真相源」，state 仅用来触发重渲染。
  const valueRef = useRef('')
  const cursorRef = useRef(0)
  const pastedContentsRef = useRef(new Map<number, string>())
  const nextPasteIdRef = useRef(1)
  const [, bump] = useReducer((n: number) => n + 1, 0)

  // —— 命令历史 ——
  // historyRef：已提交过的输入，最新的在末尾。
  // histPosRef：当前浏览位置；等于 history.length 表示「正在编辑新内容」。
  // draftRef：进入历史浏览前，把正在编辑的草稿暂存起来，翻回最底时还原。
  const historyRef = useRef<InputHistoryEntry[]>([])
  const histPosRef = useRef(0)
  const draftRef = useRef<InputHistoryEntry>({
    display: '',
    pastedContents: new Map(),
  })

  // 统一的状态写入：钳制光标到合法范围，再触发一次重渲染。
  const set = (
    value: string,
    cursor: number,
    pastedContents: ReadonlyMap<number, string> = pastedContentsRef.current,
  ) => {
    valueRef.current = value
    cursorRef.current = Math.max(0, Math.min(cursor, value.length))
    pastedContentsRef.current = prunePastedTextRefs(value, pastedContents)
    bump()
  }

  // 翻历史：dir = -1 往旧翻，+1 往新翻。返回 true 表示已处理。
  const navigateHistory = (dir: -1 | 1): boolean => {
    const history = historyRef.current
    if (history.length === 0) return false
    let pos = histPosRef.current
    // 第一次往上翻时，把当前草稿存起来
    if (pos === history.length) {
      draftRef.current = {
        display: valueRef.current,
        pastedContents: new Map(pastedContentsRef.current),
      }
    }
    pos = Math.max(0, Math.min(history.length, pos + dir))
    histPosRef.current = pos
    const next = pos === history.length ? draftRef.current : history[pos]
    set(next.display, next.display.length, new Map(next.pastedContents))
    return true
  }

  useInput(
    (input, key) => {
      // 全局启用 SGR mouse 后，Ink 可能把滚轮报告去掉 ESC 再交给输入框。
      // 必须在粘贴/普通字符逻辑之前过滤，否则触控板滚动会写入“[<64;…M”。
      input = stripSgrMouseSequences(input)
      // Ink may coalesce repeated control keys into one chunk and then fail to mark
      // key.ctrl. Never allow C0 controls (except tab/newline/return) into editable text.
      input = input.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
      if (!input && !key.return && !key.leftArrow && !key.rightArrow && !key.upArrow &&
          !key.downArrow && !key.backspace && !key.delete && !key.escape) return
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
        if (history[history.length - 1]?.display !== value) {
          history.push({
            display: value,
            pastedContents: new Map(pastedContentsRef.current),
          })
        }
        histPosRef.current = history.length
        draftRef.current = { display: '', pastedContents: new Map() }
        const expanded = expandPastedTextRefs(value, pastedContentsRef.current)
        set('', 0, new Map())
        onSubmit(expanded)
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
        // Claude Code 的 paste pill 是原子项：在占位符末尾按退格时整项删除，
        // 不留下一个无法再展开的半截 “[Pasted text …]”。
        for (const [id, content] of pastedContentsRef.current) {
          const ref = formatPastedTextRef(id, content)
          if (value.slice(0, cursor).endsWith(ref)) {
            const start = cursor - ref.length
            const nextPastes = new Map(pastedContentsRef.current)
            nextPastes.delete(id)
            set(value.slice(0, start) + value.slice(cursor), start, nextPastes)
            return
          }
        }
        set(value.slice(0, cursor - 1) + value.slice(cursor), cursor - 1)
        return
      }

      if (key.escape) {
        set('', 0, new Map())
        return
      }

      // —— 普通字符 / 粘贴 ——（忽略其他控制键）
      if (input && !key.ctrl && !key.meta) {
        const pasted = normalizePastedText(input)
        if (shouldCollapsePaste(pasted)) {
          const id = nextPasteIdRef.current++
          const ref = formatPastedTextRef(id, pasted)
          const nextPastes = new Map(pastedContentsRef.current)
          nextPastes.set(id, pasted)
          set(
            value.slice(0, cursor) + ref + value.slice(cursor),
            cursor + ref.length,
            nextPastes,
          )
          return
        }
        set(value.slice(0, cursor) + pasted + value.slice(cursor), cursor + pasted.length)
      }
    },
    { isActive: !disabled },
  )

  const value = valueRef.current
  const cursor = cursorRef.current
  // 显式锁定宽度，避免 topRightLabel 的右对齐布局与输入行 flexGrow 在 Ink
  // 启动阶段互相反馈，连续算出不同宽度并把多套边框残留在终端上。
  // 预留 4 列也避免右端正好顶到终端最后一列触发自动换行。
  const dialogWidth = width ?? Math.max(20, (process.stdout.columns || 80) - 4)

  return (
    <Box flexDirection="column" width={dialogWidth}>
      {topRightLabel && (
        <Box justifyContent="flex-end" paddingRight={1}>
          <Text dimColor>{topRightLabel}</Text>
        </Box>
      )}
      <Box
        borderStyle="single"
        borderColor={disabled ? 'gray' : accentColor}
        borderLeft={false}
        borderRight={false}
        paddingX={0}
      >
        <Text color={disabled ? 'gray' : accentColor} bold>{'› '}</Text>
        <Box flexGrow={1}>
          {value.length === 0 && !disabled ? (
            <Text>
              <Text backgroundColor={accentColor} color="black"> </Text>
              <Text dimColor>{placeholder ?? ''}</Text>
            </Text>
          ) : (
            <CursorText
              value={value}
              cursor={cursor}
              showCursor={!disabled}
              accentColor={accentColor}
            />
          )}
        </Box>
      </Box>
    </Box>
  )
}

function CursorText({
  value,
  cursor,
  showCursor,
  accentColor,
}: {
  value: string
  cursor: number
  showCursor: boolean
  accentColor: string
}) {
  if (!showCursor) return <Text>{value}</Text>

  const before = value.slice(0, cursor)
  const ch = value[cursor]
  const after = value.slice(cursor + 1)

  if (ch === undefined) {
    return (
      <Text>
        {before}
        <Text backgroundColor={accentColor} color="black"> </Text>
      </Text>
    )
  }
  if (ch === '\n') {
    return (
      <Text>
        {before}
        <Text backgroundColor={accentColor} color="black"> </Text>
        {'\n'}
        {after}
      </Text>
    )
  }
  return (
    <Text>
      {before}
      <Text backgroundColor={accentColor} color="black">{ch}</Text>
      {after}
    </Text>
  )
}
