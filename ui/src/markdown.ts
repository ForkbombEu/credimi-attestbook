// A deliberately small Markdown parser for the bundled product guide
// (`docs/guides/*.md`). It covers the subset the guide needs — headings,
// paragraphs, ordered and unordered lists, fenced code blocks, inline code,
// emphasis and inline links — and never emits raw HTML. React renders every
// token as text or a known element, so embedded markup such as `<script>` stays
// literal text instead of becoming DOM.

export interface MarkdownHeading {
  readonly type: 'heading'
  readonly level: number
  readonly text: string
}

export interface MarkdownParagraph {
  readonly type: 'paragraph'
  readonly text: string
}

export interface MarkdownList {
  readonly type: 'list'
  readonly ordered: boolean
  readonly items: readonly string[]
}

export interface MarkdownCode {
  readonly type: 'code'
  readonly language: string | null
  readonly code: string
}

export type MarkdownBlock = MarkdownHeading | MarkdownParagraph | MarkdownList | MarkdownCode

export type InlineToken =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'code'; readonly text: string }
  | { readonly type: 'strong'; readonly text: string }
  | { readonly type: 'emphasis'; readonly text: string }
  | { readonly type: 'link'; readonly text: string; readonly href: string }

const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})[ \t]*([A-Za-z0-9_-]*)[ \t]*$/
const HEADING_PATTERN = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*$/
const LIST_PATTERN = /^[ \t]*(?:([-+*])|(\d{1,9})[.)])[ \t]+(.+?)[ \t]*$/

function isClosingFence(line: string, opening: string): boolean {
  const trimmed = line.trim()
  if (trimmed.length < opening.length) {
    return false
  }
  const marker = opening[0]
  if (marker === undefined) {
    return false
  }
  return [...trimmed].every((character) => character === marker)
}

function startsBlock(line: string): boolean {
  return (
    line.trim() === '' ||
    FENCE_PATTERN.test(line) ||
    HEADING_PATTERN.test(line) ||
    LIST_PATTERN.test(line)
  )
}

/** Parses the supported Markdown subset into ordered block tokens. */
export function parseMarkdown(source: string): MarkdownBlock[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const blocks: MarkdownBlock[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (line.trim() === '') {
      index += 1
      continue
    }

    const fence = FENCE_PATTERN.exec(line)
    if (fence !== null) {
      const opening = fence[1] ?? '```'
      const language = (fence[2] ?? '') === '' ? null : (fence[2] ?? null)
      const code: string[] = []
      index += 1
      while (index < lines.length) {
        const candidate = lines[index] ?? ''
        if (isClosingFence(candidate, opening)) {
          index += 1
          break
        }
        code.push(candidate)
        index += 1
      }
      blocks.push({ type: 'code', language, code: code.join('\n') })
      continue
    }

    const heading = HEADING_PATTERN.exec(line)
    if (heading !== null) {
      const hashes = heading[1] ?? '#'
      const text = (heading[2] ?? '').replace(/[ \t]+#+[ \t]*$/, '')
      blocks.push({ type: 'heading', level: hashes.length, text })
      index += 1
      continue
    }

    const list = LIST_PATTERN.exec(line)
    if (list !== null) {
      const ordered = list[2] !== undefined
      const items: string[] = []
      while (index < lines.length) {
        const item = LIST_PATTERN.exec(lines[index] ?? '')
        if (item === null || (item[2] !== undefined) !== ordered) {
          break
        }
        let itemText = item[3] ?? ''
        index += 1
        // A wrapped item continues on the following indented lines until a
        // blank line, another block or a new item starts.
        while (index < lines.length) {
          const continuation = lines[index] ?? ''
          if (
            continuation.trim() === '' ||
            !/^[ \t]+/.test(continuation) ||
            startsBlock(continuation)
          ) {
            break
          }
          itemText += ` ${continuation.trim()}`
          index += 1
        }
        items.push(itemText)
      }
      blocks.push({ type: 'list', ordered, items })
      continue
    }

    const paragraph: string[] = [line.trim()]
    index += 1
    while (index < lines.length && !startsBlock(lines[index] ?? '')) {
      paragraph.push((lines[index] ?? '').trim())
      index += 1
    }
    blocks.push({ type: 'paragraph', text: paragraph.join(' ') })
  }

  return blocks
}

/**
 * Returns a URL that is safe to place in an `href`, or `null` when the
 * destination must not become a link. Only root-relative application paths,
 * same-page fragments, `http(s)` and `mailto` are accepted; protocol-relative,
 * backslash, control-character and script/data destinations are rejected.
 */
export function safeLinkHref(destination: string): string | null {
  const href = destination.trim()
  // Whitespace, control characters and backslashes inside a destination are
  // rejected: browsers may normalise them into a protocol-relative or
  // otherwise different target.
  const hasUnsafeCharacter = [...href].some((character) => {
    const code = character.codePointAt(0) ?? 0
    return code <= 0x20 || code === 0x7f || character === '\\'
  })
  if (href === '' || hasUnsafeCharacter) {
    return null
  }
  if (href.startsWith('//')) {
    return null
  }
  if (href.startsWith('/') || href.startsWith('#')) {
    return href
  }
  if (/^https?:\/\//i.test(href) || /^mailto:/i.test(href)) {
    return href
  }
  return null
}

function matchLink(
  source: string,
  start: number,
): { readonly label: string; readonly destination: string; readonly end: number } | null {
  const labelEnd = source.indexOf(']', start + 1)
  if (labelEnd < 0 || source[labelEnd + 1] !== '(') {
    return null
  }
  const destinationEnd = source.indexOf(')', labelEnd + 2)
  if (destinationEnd < 0) {
    return null
  }
  const label = source.slice(start + 1, labelEnd)
  if (label === '') {
    return null
  }
  return {
    label,
    destination: source.slice(labelEnd + 2, destinationEnd),
    end: destinationEnd + 1,
  }
}

/** Parses inline formatting and links. Unsafe link destinations stay text. */
export function parseInline(source: string): InlineToken[] {
  const tokens: InlineToken[] = []
  let text = ''
  let index = 0

  const flushText = (): void => {
    if (text !== '') {
      tokens.push({ type: 'text', text })
      text = ''
    }
  }

  while (index < source.length) {
    const character = source[index]

    if (character === '`') {
      const end = source.indexOf('`', index + 1)
      if (end > index + 1) {
        flushText()
        tokens.push({ type: 'code', text: source.slice(index + 1, end) })
        index = end + 1
        continue
      }
    }

    if (character === '[') {
      const link = matchLink(source, index)
      if (link !== null) {
        const href = safeLinkHref(link.destination)
        if (href === null) {
          text += source.slice(index, link.end)
        } else {
          flushText()
          tokens.push({ type: 'link', text: link.label, href })
        }
        index = link.end
        continue
      }
    }

    if (character === '*') {
      if (source[index + 1] === '*') {
        const end = source.indexOf('**', index + 2)
        if (end > index + 2) {
          flushText()
          tokens.push({ type: 'strong', text: source.slice(index + 2, end) })
          index = end + 2
          continue
        }
      } else {
        const end = source.indexOf('*', index + 1)
        if (end > index + 1) {
          flushText()
          tokens.push({ type: 'emphasis', text: source.slice(index + 1, end) })
          index = end + 1
          continue
        }
      }
    }

    text += character ?? ''
    index += 1
  }

  flushText()
  return tokens
}
