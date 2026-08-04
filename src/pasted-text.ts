export const PASTE_THRESHOLD = 800
export const MAX_VISIBLE_PASTE_NEWLINES = 2

// bracketed-paste 起止标记：终端粘贴大段文本时会把内容包在这两个序列之间。
// 大段粘贴常被 stdin 拆成多个数据块、分别触发多次 useInput 回调，
// MultilineInput 用这两个常量在多次回调之间重新拼接出完整的粘贴内容，
// 避免一次粘贴被拆成好几个 "[Pasted text #N]" 片段。
export const PASTE_START_MARKER = '\x1b[200~'
export const PASTE_END_MARKER = '\x1b[201~'

export function normalizePastedText(text: string): string {
  return text
    .replace(/^\x1b\[200~/, '')
    .replace(/\x1b\[201~$/, '')
    .replace(/\r\n?|\n/g, '\n')
    .replaceAll('\t', '    ')
}

export function pastedNewlineCount(text: string): number {
  return (text.match(/\n/g) ?? []).length
}

export function shouldCollapsePaste(text: string): boolean {
  return text.length > PASTE_THRESHOLD || pastedNewlineCount(text) > MAX_VISIBLE_PASTE_NEWLINES
}

export function formatPastedTextRef(id: number, text: string): string {
  const lines = pastedNewlineCount(text)
  return lines
    ? `[Pasted text #${id} +${lines} lines]`
    : `[Pasted text #${id}]`
}

export function expandPastedTextRefs(input: string, contents: ReadonlyMap<number, string>): string {
  let expanded = input
  for (const [id, content] of [...contents.entries()].reverse()) {
    expanded = expanded.replace(formatPastedTextRef(id, content), content)
  }
  return expanded
}

export function prunePastedTextRefs(
  input: string,
  contents: ReadonlyMap<number, string>,
): Map<number, string> {
  return new Map(
    [...contents].filter(([id, content]) => input.includes(formatPastedTextRef(id, content))),
  )
}
