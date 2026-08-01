export type InlineMarkdownSegment = {
  text: string
  style: 'plain' | 'italic' | 'bold' | 'code' | 'link'
  href?: string
}

export type MarkdownLinePresentation = {
  content: string
  heading: boolean
}

export function markdownLinePresentation(value: string): MarkdownLinePresentation {
  const heading = value.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/)
  return heading
    ? { content: heading[1], heading: true }
    : { content: value, heading: false }
}

export function terminalHyperlink(url: string, text: string): string {
  const safeUrl = url.replace(/[\x00-\x1f\x7f]/g, '')
  const safeText = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
  if (!/^https?:\/\//i.test(safeUrl)) return safeText
  return `\x1b]8;;${safeUrl}\x07${safeText}\x1b]8;;\x07`
}

/**
 * Parse the small inline-markdown subset used by streamed assistant prose.
 * Keeping this independent from React makes the behaviour easy to test while
 * still letting Ink render emphasis without showing the marker characters.
 */
export function inlineMarkdownSegments(value: string): InlineMarkdownSegment[] {
  const segments: InlineMarkdownSegment[] = []
  let plain = ''

  const append = (text: string, style: InlineMarkdownSegment['style'], href?: string) => {
    if (!text) return
    const previous = segments.at(-1)
    if (previous?.style === style && previous.href === href) previous.text += text
    else segments.push({ text, style, ...(href ? { href } : {}) })
  }
  const flushPlain = () => {
    append(plain, 'plain')
    plain = ''
  }

  for (let index = 0; index < value.length;) {
    if (
      value[index] === '\\' &&
      ['*', '_', '[', ']', '`', '\\'].includes(value[index + 1] ?? '')
    ) {
      plain += value[index + 1]
      index += 2
      continue
    }

    if (value[index] === '[') {
      const link = value.slice(index).match(/^\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/i)
      if (link) {
        flushPlain()
        append(link[1], 'link', link[2])
        index += link[0].length
        continue
      }
    }

    if (/^https?:\/\//i.test(value.slice(index))) {
      const candidate = value.slice(index).match(/^https?:\/\/[^\s<>()]+/i)?.[0]
      if (candidate) {
        const url = candidate.replace(/[.,;:!?]+$/, '')
        flushPlain()
        append(url, 'link', url)
        index += url.length
        continue
      }
    }

    if (value[index] === '`') {
      const end = value.indexOf('`', index + 1)
      if (end > index + 1) {
        flushPlain()
        append(value.slice(index + 1, end), 'code')
        index = end + 1
        continue
      }
    }

    const marker = value.startsWith('**', index)
      ? '**'
      : value[index] === '*' ? '*' : undefined
    if (!marker) {
      plain += value[index]
      index += 1
      continue
    }

    const end = value.indexOf(marker, index + marker.length)
    if (end === -1 || end === index + marker.length) {
      plain += marker
      index += marker.length
      continue
    }

    flushPlain()
    append(
      value.slice(index + marker.length, end),
      marker === '**' ? 'bold' : 'italic',
    )
    index = end + marker.length
  }

  flushPlain()
  return segments
}

export function splitRemoteWebTitle(
  value: string,
): { tool: 'Web Search' | 'Fetch'; argument: string } | undefined {
  const match = value.match(/^(Web Search|Fetch)(\([\s\S]*\))$/)
  if (!match) return undefined
  return { tool: match[1] as 'Web Search' | 'Fetch', argument: match[2] }
}

export function localWebFetchUrl(value: string): string | undefined {
  return value.match(/^抓取\s+(https?:\/\/\S+)/)?.[1]
}
