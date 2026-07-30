export const PASTE_THRESHOLD = 800
export const MAX_VISIBLE_PASTE_NEWLINES = 2

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
