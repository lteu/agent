import { memo, type ReactNode } from 'react'
import { Box, Text } from 'ink'
import {
  syntaxSegments,
  truncateDiffLine,
  type FileDiffCard as FileDiffCardData,
  type FileDiffLine,
} from './ui-diff.js'
import { terminalWidth } from './ui-activity.js'

function HighlightedLine({ text, light }: { text: string; light: boolean }): ReactNode {
  return (
    <>
      {syntaxSegments(text).map((segment, index) => (
        <Text
          key={`${index}-${segment.kind}`}
          color={
            segment.kind === 'keyword'
              ? light ? '#9b1558' : '#ff4d94'
              : segment.kind === 'string'
                ? light ? '#765b00' : '#e6dc72'
                : segment.kind === 'number'
                  ? light ? '#006a82' : 'cyan'
                  : undefined
          }
          dimColor={segment.kind === 'comment'}
        >
          {segment.text}
        </Text>
      ))}
    </>
  )
}

function DiffRow({
  line,
  width,
  numberWidth,
  light,
}: {
  line: FileDiffLine
  width: number
  numberWidth: number
  light: boolean
}) {
  const number = line.kind === 'remove' ? line.oldLine : line.newLine
  const marker = line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '
  const gutter = `${String(number ?? '').padStart(numberWidth)} ${marker} `
  const available = Math.max(1, width - terminalWidth(gutter))
  const code = truncateDiffLine(line.text.replaceAll('\t', '  '), available)
  const padding = ' '.repeat(Math.max(0, available - terminalWidth(code)))
  const backgroundColor = line.kind === 'add'
    ? light ? '#d9f2df' : '#003a13'
    : line.kind === 'remove'
      ? light ? '#f6d9d9' : '#4a0808'
      : undefined
  const gutterColor = line.kind === 'add'
    ? light ? '#08752e' : '#55d46a'
    : line.kind === 'remove'
      ? light ? '#a12626' : '#ff6b6b'
      : undefined
  return (
    <Text backgroundColor={backgroundColor} color={light && backgroundColor ? 'black' : undefined}>
      <Text color={gutterColor} dimColor={line.kind === 'context'}>{gutter}</Text>
      <HighlightedLine text={code} light={light} />{padding}
    </Text>
  )
}

export const FileDiffCard = memo(({
  card,
  columns,
  light = false,
}: {
  card: FileDiffCardData
  columns: number
  light?: boolean
}) => {
  const width = Math.max(8, columns - 6)
  const maxLineNumber = Math.max(
    1,
    ...card.hunks.flatMap(hunk =>
      hunk.lines.map(line => Math.max(line.oldLine ?? 0, line.newLine ?? 0))),
  )
  const numberWidth = String(maxLineNumber).length
  const additions = card.additions > 0
    ? <><Text>Added </Text><Text bold>{card.additions}</Text><Text> {card.additions === 1 ? 'line' : 'lines'}</Text></>
    : null
  const removals = card.removals > 0
    ? <><Text>{card.additions > 0 ? 'removed' : 'Removed'} </Text><Text bold>{card.removals}</Text><Text> {card.removals === 1 ? 'line' : 'lines'}</Text></>
    : null

  return (
    <Box marginBottom={1} flexDirection="column">
      <Text>
        <Text color="green">●</Text>{' '}
        <Text bold>{card.operation}</Text><Text dimColor>({card.displayPath})</Text>
      </Text>
      <Text>
        {'  └ '}
        {additions}{card.additions > 0 && card.removals > 0 ? ', ' : null}{removals}
        {card.additions === 0 && card.removals === 0 ? <Text dimColor>No changes</Text> : null}
      </Text>
      {card.hunks.map((hunk, hunkIndex) => (
        <Box key={`${hunkIndex}-${hunk.lines[0]?.oldLine}-${hunk.lines[0]?.newLine}`} flexDirection="column" marginLeft={4}>
          {hunkIndex > 0 ? <Text dimColor>…</Text> : null}
          {hunk.lines.map((line, lineIndex) => (
            <DiffRow
              key={`${lineIndex}-${line.kind}-${line.oldLine}-${line.newLine}`}
              line={line}
              width={width}
              numberWidth={numberWidth}
              light={light}
            />
          ))}
        </Box>
      ))}
    </Box>
  )
})
