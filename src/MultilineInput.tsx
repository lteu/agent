// 可编辑的多行输入框。支持：
//   - 方向键移动光标（上下左右）
//   - Backspace/Delete 删除
//   - Ctrl+A / Ctrl+E 行首/行尾，Ctrl+U 删到行首
//   - Cmd+Z / Cmd+Y 撤销/重做；Cmd+方向键按 macOS 文本编辑习惯跳转
//   - Enter 发送；行尾以 "\" 结尾再按 Enter 则换行
//   - 粘贴多行文本
//   - Esc 清空
//
// 状态用 ref 承载、再 bump 触发重渲染：因为 Ink 在一次 stdin 数据块里可能
// 连续触发多次 useInput（快速输入 / 粘贴 / 方向键和字符混在一起时），若直接
// 读闭包里的 value/cursor，React 18 的批处理会让这几次回调都基于同一份「旧」
// 状态计算，导致后写覆盖前写——字符丢失、光标错位。ref 是同步的，每次回调都
// 能拿到上一次的结果，从根上消除这个竞态。

import { useEffect, useRef, useReducer } from 'react'
import { Box, Text, useInput } from 'ink'
import { recordInput } from './crashlog.js'
import {
  expandPastedTextRefs,
  formatPastedTextRef,
  normalizePastedText,
  PASTE_END_MARKER,
  PASTE_START_MARKER,
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
// 见下方 useInput 内「跨多个完整 bracketed-paste 序列合并」的说明：合并静默窗口。
// 这个项目还有一条远程中继链路（src/remote.ts / server.ts）：键盘数据要经网络转发，
// 一次物理粘贴很容易被中继按网络包/网络延迟切成好几个完整的 \x1b[200~...\x1b[201~
// 序列，相邻序列之间的间隔可能是几百毫秒甚至更久。之前用过 300ms / 1500ms，实测粘贴
// 100 行代码仍会拆成 10 个片段——真正的根因其实不在这个「序列之间」的静默窗口，而在
// 下面 pasteFlushTimerRef 那个「单个序列内部还没等到终止符」的兜底超时：一旦它先于真正
// 的 \x1b[201~ 触发，就会把还没收完的半截内容错误地当成「完整一段」提前落地，
// 之后姗姗来迟的剩余部分因为不再带 \x1b[200~ 起始标记，会被当成普通按键而不是粘贴续传，
// 这才是片段被拆得比预期更多的主因。这里把两层超时都放宽到足以覆盖真实网络/终端延迟：
// 真正决定何时把挂起的粘贴落地成一个占位符的，是「后面来了一个不属于粘贴序列的
// 真实按键」（见下方 flushPendingPaste 的调用点），此定时器只是防止用户粘贴后完全不再
// 操作时输入框一直空白的兜底，放宽不会拖慢“粘贴后立刻回车发送”的手感。
const PASTE_COALESCE_MS = 4000
type InputHistoryEntry = {
  display: string
  pastedContents: Map<number, string>
}

type EditorSnapshot = {
  value: string
  cursor: number
  pastedContents: Map<number, string>
}

const MAX_UNDO_DEPTH = 200

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
  const undoStackRef = useRef<EditorSnapshot[]>([])
  const redoStackRef = useRef<EditorSnapshot[]>([])
  const [, bump] = useReducer((n: number) => n + 1, 0)

  // 跨多次 useInput 回调重组一次大段粘贴：见下方 useInput 内的说明。
  const pasteBufferRef = useRef<string | null>(null)
  const pasteFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

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

  const snapshot = (): EditorSnapshot => ({
    value: valueRef.current,
    cursor: cursorRef.current,
    pastedContents: new Map(pastedContentsRef.current),
  })

  // 内容编辑才进入撤销栈；单纯移动光标、浏览命令历史不会制造撤销步骤。
  const edit = (
    value: string,
    cursor: number,
    pastedContents: ReadonlyMap<number, string> = pastedContentsRef.current,
  ) => {
    if (value === valueRef.current) {
      set(value, cursor, pastedContents)
      return
    }
    const undo = undoStackRef.current
    undo.push(snapshot())
    if (undo.length > MAX_UNDO_DEPTH) undo.shift()
    redoStackRef.current = []
    set(value, cursor, pastedContents)
  }

  const undo = () => {
    const previous = undoStackRef.current.pop()
    if (!previous) return
    redoStackRef.current.push(snapshot())
    set(previous.value, previous.cursor, previous.pastedContents)
  }

  const redo = () => {
    const next = redoStackRef.current.pop()
    if (!next) return
    undoStackRef.current.push(snapshot())
    set(next.value, next.cursor, next.pastedContents)
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

  // 把一段完整的粘贴文本插入光标处：够长/够多行就折叠成占位符，否则原样插入。
  // 供 useInput 里「单块粘贴」和「多块拼接后的粘贴」两条路径共用，
  // 确保同一次物理粘贴、不管被 stdin 拆成几块，最终只生成一个片段。
  const insertPastedText = (raw: string) => {
    const value = valueRef.current
    const cursor = cursorRef.current
    const pasted = normalizePastedText(raw)
    if (shouldCollapsePaste(pasted)) {
      const id = nextPasteIdRef.current++
      const ref = formatPastedTextRef(id, pasted)
      const nextPastes = new Map(pastedContentsRef.current)
      nextPastes.set(id, pasted)
      edit(value.slice(0, cursor) + ref + value.slice(cursor), cursor + ref.length, nextPastes)
    } else {
      edit(value.slice(0, cursor) + pasted + value.slice(cursor), cursor + pasted.length)
    }
  }

  // —— 跨多个「完整 bracketed-paste 序列」合并 ——
  // 上面的 pasteBufferRef 只能拼好「一个」\x1b[200~...\x1b[201~ 序列内被 stdin 拆开的分块；
  // 但有些终端/复用器会把一次物理粘贴本身拆成好几个各自完整的 bracketed-paste 序列
  // （典型症状：粘贴一段代码后出现 [Pasted text #21]...[Pasted text #30] 好几个片段，
  // 而不是一个）。这里再加一层：每收全一个完整序列先攒进 pendingPasteRawRef，并重置一个
  // 很短的静默定时器；只有连续 PASTE_COALESCE_MS 内没有新的序列到达，才真正落地成一个
  // "[Pasted text #N +M lines]" 占位符。
  const pendingPasteRawRef = useRef<string | null>(null)
  const pendingPasteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flushPendingPaste = () => {
    if (pendingPasteTimerRef.current) {
      clearTimeout(pendingPasteTimerRef.current)
      pendingPasteTimerRef.current = null
    }
    const raw = pendingPasteRawRef.current
    pendingPasteRawRef.current = null
    if (raw) insertPastedText(raw)
  }

  const queuePendingPaste = (raw: string) => {
    pendingPasteRawRef.current = (pendingPasteRawRef.current ?? '') + raw
    if (pendingPasteTimerRef.current) clearTimeout(pendingPasteTimerRef.current)
    pendingPasteTimerRef.current = setTimeout(flushPendingPaste, PASTE_COALESCE_MS)
  }

  // 组件卸载时清掉未触发的兜底定时器，避免悬空回调操作已卸载的 ref。
  useEffect(() => {
    return () => {
      if (pasteFlushTimerRef.current) clearTimeout(pasteFlushTimerRef.current)
      if (pendingPasteTimerRef.current) clearTimeout(pendingPasteTimerRef.current)
    }
  }, [])

  useInput(
    (input, key) => {
      // 全局启用 SGR mouse 后，Ink 可能把滚轮报告去掉 ESC 再交给输入框。
      // 必须在粘贴/普通字符逻辑之前过滤，否则触控板滚动会写入“[<64;…M”。
      input = stripSgrMouseSequences(input)

      // Ink 的 useInput 内部会把「以 ESC 开头」的 input 无条件砍掉那一个前导 ESC
      // （node_modules/ink/build/hooks/use-input.js: input.startsWith('') 就
      // slice(1)），这是它自己处理 meta/alt 组合键遗留的逻辑，跟 bracketed-paste 无关，
      // 但副作用是：一次物理粘贴的起始块几乎总是独占一次 stdin 读取、天然以 ESC 打头，
      // 于是 PASTE_START_MARKER（\x1b[200~）到我们这里时 ESC 已经没了，变成裸的
      // "[200~"，下面的 includes(PASTE_START_MARKER) 永远匹配不上，整套分片重组/多序列
      // 合并逻辑根本不会被触发——这才是"粘贴一次却出现好几个 [Pasted text #N]"的
      // 真正根因（此前两版修复都建立在“标记本身能被识别”的假设上，从未验证过这个前提）。
      // 只在 input 恰好整块都被吞掉这一个 ESC 时才补回来，避免误伤用户真的打出的
      // "[200~" 之类字面文本（那种情况下 input 不会精确等于裸标记开头）。
      if (!input.startsWith(PASTE_START_MARKER) && input.startsWith(PASTE_START_MARKER.slice(1))) {
        input = PASTE_START_MARKER + input.slice(PASTE_START_MARKER.slice(1).length)
      } else if (!input.startsWith(PASTE_END_MARKER) && input.startsWith(PASTE_END_MARKER.slice(1))) {
        input = PASTE_END_MARKER + input.slice(PASTE_END_MARKER.slice(1).length)
      }

      // —— 粘贴分片重组 ——
      // 大段粘贴常被 stdin 拆成多个数据块，每块各自触发一次 useInput；
      // 旧逻辑逐块处理，每一块只要够长/够多行就会各自生成一个
      // "[Pasted text #N +M lines]" 占位符——粘贴一段文本却出现好几个片段，
      // 这正是本次要修的问题。这里以 bracketed-paste 的起止标记为界，把
      // 跨多次回调的分片先攒到 pasteBufferRef 里，收全后再当一次粘贴处理；
      // 少数终端不发终止符时用超时兜底，避免输入框卡死等不到收尾。
      // 用 while 而非 if：一次 stdin 数据块里可能背靠背拼着两个甚至更多个完整的
      // bracketed-paste 序列（\x1b[200~A\x1b[201~\x1b[200~B\x1b[201~）。之前用 if 只处理
      // 第一个，剩下的 remainder 里第二段的 \x1b[200~ 不会被识别为新粘贴——ESC(0x1b) 还会被
      // 后面过滤 C0 控制符的正则当垃圾吃掉，导致第二段粘贴既没被识别为粘贴、又污染了正文，
      // 且会把此刻已排队的第一段提前 flush，破坏合并。循环到「既无残留 buffer 也无新
      // START 标记」为止，才把剩下的部分交给下面的普通按键逻辑。
      let handledBracketedPaste = false
      while (pasteBufferRef.current !== null || input.includes(PASTE_START_MARKER)) {
        handledBracketedPaste = true
        if (pasteFlushTimerRef.current) {
          clearTimeout(pasteFlushTimerRef.current)
          pasteFlushTimerRef.current = null
        }
        let chunk = input
        if (pasteBufferRef.current === null) {
          pasteBufferRef.current = ''
          chunk = chunk.slice(chunk.indexOf(PASTE_START_MARKER) + PASTE_START_MARKER.length)
        }
        const endIdx = chunk.indexOf(PASTE_END_MARKER)
        if (endIdx === -1) {
          pasteBufferRef.current += chunk
          // 这是上面注释里点名的根因所在：只要还没等到本序列自己的终止符，就必须继续把
          // 后续数据块当作同一序列的续传（哪怕它们不带 \x1b[200~）。之前这里只给 300ms，
          // 网络/终端延迟一旦超过这个数，就会把半截内容误判成"终止符大概率不会来了"而提前
          // 落地——真正的终止符和剩余内容随后到达时，因为找不到匹配的起始标记，会被当成
          // 普通按键input直接污染正文。这个超时只应该在「terminal 真的坏了、永远不发终止符」
          // 时才兜底触发，所以要给得足够久，正常粘贴不应该碰到它。
          pasteFlushTimerRef.current = setTimeout(() => {
            const buffered = pasteBufferRef.current
            pasteBufferRef.current = null
            pasteFlushTimerRef.current = null
            if (buffered) queuePendingPaste(buffered)
          }, 4000)
          return
        }
        const full = pasteBufferRef.current + chunk.slice(0, endIdx)
        pasteBufferRef.current = null
        queuePendingPaste(full)
        input = chunk.slice(endIdx + PASTE_END_MARKER.length)
      }
      // Ink reports keys such as Backspace/Delete/arrows with an empty `input` and
      // carries their identity only in `key`.  Returning for every empty input here
      // therefore disables those keys.  Only stop when this callback actually
      // consumed a complete bracketed-paste sequence and left no remainder.
      if (handledBracketedPaste && !input) return

      // 本次输入不是「未闭合的粘贴序列内部数据」：如果还有尚未合并完成的粘贴挂起
      // （多段 bracketed-paste 序列之间的静默期还没到），先落地，保证显示顺序，
      // 以及紧随其后的操作（比如粘贴完直接回车发送）都基于合并后的最新内容。
      if (pendingPasteRawRef.current !== null) flushPendingPaste()

      // Ink may coalesce repeated control keys into one chunk and then fail to mark
      // key.ctrl. Never allow C0 controls (except tab/newline/return) into editable text.
      input = input.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
      if (!input && !key.return && !key.leftArrow && !key.rightArrow && !key.upArrow &&
          !key.downArrow && !key.backspace && !key.delete && !key.escape) return
      recordInput(input, key as unknown as Record<string, unknown>)
      const value = valueRef.current
      const cursor = cursorRef.current

      // —— macOS 风格编辑快捷键 ——
      // 终端把 Command/Meta 传给应用时，Ink 会标记为 key.meta。部分终端需要在
      // profile 中把 Cmd 组合键配置为发送 Meta/Escape 序列。
      if (key.meta && input.toLowerCase() === 'z') {
        undo()
        return
      }
      if (key.meta && input.toLowerCase() === 'y') {
        redo()
        return
      }
      if (key.meta && key.upArrow) {
        set(value, 0)
        return
      }
      if (key.meta && key.downArrow) {
        set(value, value.length)
        return
      }
      if (key.meta && key.leftArrow) {
        const [line] = offsetToLineCol(value, cursor)
        set(value, lineColToOffset(value, line, 0))
        return
      }
      if (key.meta && key.rightArrow) {
        const [line] = offsetToLineCol(value, cursor)
        set(value, lineColToOffset(value, line, Infinity))
        return
      }

      // —— 提交 / 换行 ——
      if (key.return) {
        // 行尾反斜杠 => 换行而非发送
        if (value.slice(0, cursor).endsWith('\\')) {
          edit(value.slice(0, cursor - 1) + '\n' + value.slice(cursor), cursor) // 删 '\'(-1) 加 '\n'(+1)
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
        undoStackRef.current = []
        redoStackRef.current = []
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
        edit(value.slice(0, start) + value.slice(cursor), start)
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
            edit(value.slice(0, start) + value.slice(cursor), start, nextPastes)
            return
          }
        }
        edit(value.slice(0, cursor - 1) + value.slice(cursor), cursor - 1)
        return
      }

      if (key.escape) {
        edit('', 0, new Map())
        return
      }

      // —— 普通字符 / 粘贴 ——（忽略其他控制键）
      if (input && !key.ctrl && !key.meta) {
        insertPastedText(input)
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
