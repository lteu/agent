import { relative, sep } from 'node:path'
import { terminalWidth } from './ui-activity.js'

export type FileDiffSnapshot = {
  path: string
  before: string
  after: string
  created: boolean
}

export type FileDiffLine = {
  kind: 'context' | 'add' | 'remove'
  text: string
  oldLine?: number
  newLine?: number
}

export type FileDiffHunk = {
  lines: FileDiffLine[]
}

export type FileDiffCard = {
  path: string
  displayPath: string
  operation: 'Create' | 'Update'
  additions: number
  removals: number
  hunks: FileDiffHunk[]
}

type DiffOperation = {
  kind: FileDiffLine['kind']
  text: string
}

const CONTEXT_LINES = 3
// A dense LCS table produces the most familiar unified diff for normal source
// files. Larger blocks use patience anchors so an accidental generated file
// cannot turn one tool completion into hundreds of MB of temporary state.
const MAX_LCS_CELLS = 1_000_000

function fileLines(content: string): string[] {
  const normalized = content.replace(/\r\n?/g, '\n')
  if (!normalized) return []
  const lines = normalized.split('\n')
  if (normalized.endsWith('\n')) lines.pop()
  return lines
}

function lcsDiff(oldLines: string[], newLines: string[]): DiffOperation[] {
  const rows = oldLines.length + 1
  const columns = newLines.length + 1
  const table = new Uint32Array(rows * columns)

  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex--) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex--) {
      const offset = oldIndex * columns + newIndex
      table[offset] = oldLines[oldIndex] === newLines[newIndex]
        ? table[(oldIndex + 1) * columns + newIndex + 1] + 1
        : Math.max(
            table[(oldIndex + 1) * columns + newIndex],
            table[oldIndex * columns + newIndex + 1],
          )
    }
  }

  const operations: DiffOperation[] = []
  let oldIndex = 0
  let newIndex = 0
  while (oldIndex < oldLines.length || newIndex < newLines.length) {
    if (
      oldIndex < oldLines.length &&
      newIndex < newLines.length &&
      oldLines[oldIndex] === newLines[newIndex]
    ) {
      operations.push({ kind: 'context', text: oldLines[oldIndex] })
      oldIndex++
      newIndex++
    } else if (
      oldIndex < oldLines.length &&
      (newIndex >= newLines.length ||
        table[(oldIndex + 1) * columns + newIndex] >= table[oldIndex * columns + newIndex + 1])
    ) {
      operations.push({ kind: 'remove', text: oldLines[oldIndex++] })
    } else {
      operations.push({ kind: 'add', text: newLines[newIndex++] })
    }
  }
  return operations
}

function longestIncreasingPairs(pairs: Array<[number, number]>): Array<[number, number]> {
  if (!pairs.length) return []
  const tails: number[] = []
  const tailIndices: number[] = []
  const previous = new Int32Array(pairs.length).fill(-1)

  pairs.forEach((pair, index) => {
    let low = 0
    let high = tails.length
    while (low < high) {
      const middle = (low + high) >> 1
      if (tails[middle] < pair[1]) low = middle + 1
      else high = middle
    }
    if (low > 0) previous[index] = tailIndices[low - 1]
    tails[low] = pair[1]
    tailIndices[low] = index
  })

  const result: Array<[number, number]> = []
  let index = tailIndices[tails.length - 1]
  while (index >= 0) {
    result.push(pairs[index])
    index = previous[index]
  }
  return result.reverse()
}

function patienceAnchors(
  oldLines: string[],
  oldStart: number,
  oldEnd: number,
  newLines: string[],
  newStart: number,
  newEnd: number,
): Array<[number, number]> {
  const oldPositions = new Map<string, number[]>()
  const newPositions = new Map<string, number[]>()
  for (let index = oldStart; index < oldEnd; index++) {
    const positions = oldPositions.get(oldLines[index]) ?? []
    positions.push(index)
    oldPositions.set(oldLines[index], positions)
  }
  for (let index = newStart; index < newEnd; index++) {
    const positions = newPositions.get(newLines[index]) ?? []
    positions.push(index)
    newPositions.set(newLines[index], positions)
  }
  const pairs: Array<[number, number]> = []
  for (const [line, oldIndexes] of oldPositions) {
    const newIndexes = newPositions.get(line)
    if (oldIndexes.length === 1 && newIndexes?.length === 1) {
      pairs.push([oldIndexes[0], newIndexes[0]])
    }
  }
  pairs.sort((left, right) => left[0] - right[0])
  return longestIncreasingPairs(pairs)
}

function diffRange(
  oldLines: string[],
  oldStart: number,
  oldEnd: number,
  newLines: string[],
  newStart: number,
  newEnd: number,
  output: DiffOperation[],
): void {
  while (
    oldStart < oldEnd &&
    newStart < newEnd &&
    oldLines[oldStart] === newLines[newStart]
  ) {
    output.push({ kind: 'context', text: oldLines[oldStart] })
    oldStart++
    newStart++
  }

  const suffix: string[] = []
  while (
    oldStart < oldEnd &&
    newStart < newEnd &&
    oldLines[oldEnd - 1] === newLines[newEnd - 1]
  ) {
    suffix.unshift(oldLines[oldEnd - 1])
    oldEnd--
    newEnd--
  }

  const oldLength = oldEnd - oldStart
  const newLength = newEnd - newStart
  if (oldLength === 0) {
    for (let index = newStart; index < newEnd; index++) {
      output.push({ kind: 'add', text: newLines[index] })
    }
  } else if (newLength === 0) {
    for (let index = oldStart; index < oldEnd; index++) {
      output.push({ kind: 'remove', text: oldLines[index] })
    }
  } else if (oldLength * newLength <= MAX_LCS_CELLS) {
    output.push(...lcsDiff(oldLines.slice(oldStart, oldEnd), newLines.slice(newStart, newEnd)))
  } else {
    const anchors = patienceAnchors(oldLines, oldStart, oldEnd, newLines, newStart, newEnd)
    if (!anchors.length) {
      for (let index = oldStart; index < oldEnd; index++) {
        output.push({ kind: 'remove', text: oldLines[index] })
      }
      for (let index = newStart; index < newEnd; index++) {
        output.push({ kind: 'add', text: newLines[index] })
      }
    } else {
      let previousOld = oldStart
      let previousNew = newStart
      for (const [anchorOld, anchorNew] of anchors) {
        diffRange(
          oldLines,
          previousOld,
          anchorOld,
          newLines,
          previousNew,
          anchorNew,
          output,
        )
        output.push({ kind: 'context', text: oldLines[anchorOld] })
        previousOld = anchorOld + 1
        previousNew = anchorNew + 1
      }
      diffRange(oldLines, previousOld, oldEnd, newLines, previousNew, newEnd, output)
    }
  }

  for (const line of suffix) output.push({ kind: 'context', text: line })
}

function numberedOperations(before: string, after: string): FileDiffLine[] {
  const oldLines = fileLines(before)
  const newLines = fileLines(after)
  const operations: DiffOperation[] = []
  diffRange(oldLines, 0, oldLines.length, newLines, 0, newLines.length, operations)
  let oldLine = 1
  let newLine = 1
  return operations.map(operation => {
    if (operation.kind === 'context') {
      return { ...operation, oldLine: oldLine++, newLine: newLine++ }
    }
    if (operation.kind === 'remove') {
      return { ...operation, oldLine: oldLine++ }
    }
    return { ...operation, newLine: newLine++ }
  })
}

function changedHunks(lines: FileDiffLine[]): FileDiffHunk[] {
  const changes = lines
    .map((line, index) => line.kind === 'context' ? -1 : index)
    .filter(index => index >= 0)
  if (!changes.length) return []

  const ranges: Array<{ start: number; end: number }> = []
  for (const change of changes) {
    const start = Math.max(0, change - CONTEXT_LINES)
    const end = Math.min(lines.length, change + CONTEXT_LINES + 1)
    const previous = ranges.at(-1)
    if (previous && start <= previous.end) previous.end = Math.max(previous.end, end)
    else ranges.push({ start, end })
  }
  return ranges.map(range => ({ lines: lines.slice(range.start, range.end) }))
}

export function buildFileDiffCard(
  snapshot: FileDiffSnapshot,
  cwd = process.cwd(),
): FileDiffCard {
  const lines = numberedOperations(snapshot.before, snapshot.after)
  const localPath = relative(cwd, snapshot.path)
  const displayPath = localPath && !localPath.startsWith(`..${sep}`) && localPath !== '..'
    ? localPath.split(sep).join('/')
    : snapshot.path
  return {
    path: snapshot.path,
    displayPath,
    operation: snapshot.created ? 'Create' : 'Update',
    additions: lines.filter(line => line.kind === 'add').length,
    removals: lines.filter(line => line.kind === 'remove').length,
    hunks: changedHunks(lines),
  }
}

export function truncateDiffLine(text: string, cells: number): string {
  const width = Math.max(1, cells)
  if (terminalWidth(text) <= width) return text
  let output = ''
  let used = 0
  for (const character of text) {
    const characterWidth = terminalWidth(character)
    if (used + characterWidth > Math.max(0, width - 1)) break
    output += character
    used += characterWidth
  }
  return `${output}…`
}

export type SyntaxSegment = {
  text: string
  kind: 'plain' | 'keyword' | 'string' | 'number' | 'comment'
}

const KEYWORDS = new Set([
  'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue',
  'create', 'default', 'delete', 'do', 'drop', 'else', 'end', 'export', 'extends',
  'false', 'finally', 'for', 'from', 'function', 'if', 'import', 'in', 'insert',
  'interface', 'into', 'join', 'let', 'limit', 'new', 'not', 'null', 'on', 'or',
  'order', 'return', 'select', 'set', 'switch', 'then', 'true', 'try', 'type',
  'union', 'update', 'values', 'when', 'where', 'while', 'with', 'yield',
])

/** Lightweight terminal highlighting; diff semantics remain readable without it. */
export function syntaxSegments(line: string): SyntaxSegment[] {
  const segments: SyntaxSegment[] = []
  let index = 0
  const push = (text: string, kind: SyntaxSegment['kind']) => {
    const previous = segments.at(-1)
    if (previous?.kind === kind) previous.text += text
    else segments.push({ text, kind })
  }

  while (index < line.length) {
    if (
      line.startsWith('//', index) ||
      line.startsWith('--', index) ||
      (line[index] === '#' && (index === 0 || /\s/.test(line[index - 1])))
    ) {
      push(line.slice(index), 'comment')
      break
    }
    const quote = line[index]
    if (quote === "'" || quote === '"' || quote === '`') {
      let end = index + 1
      while (end < line.length) {
        if (line[end] === '\\') {
          end += 2
          continue
        }
        if (line[end] === quote) {
          // SQL escapes a quote by doubling it.
          if (line[end + 1] === quote) {
            end += 2
            continue
          }
          end++
          break
        }
        end++
      }
      push(line.slice(index, end), 'string')
      index = end
      continue
    }
    const word = /^[A-Za-z_$][\w$]*/.exec(line.slice(index))
    if (word) {
      push(word[0], KEYWORDS.has(word[0].toLowerCase()) ? 'keyword' : 'plain')
      index += word[0].length
      continue
    }
    const number = /^(?:0x[\da-f]+|\d+(?:\.\d+)?)/i.exec(line.slice(index))
    if (number) {
      push(number[0], 'number')
      index += number[0].length
      continue
    }
    push(line[index], 'plain')
    index++
  }
  return segments
}
