import { useMemo, type ReactNode } from 'react'

import { parseInline, parseMarkdown, type InlineToken } from './markdown'
import { AppLink, isClientRoute } from './router'

/**
 * Renders the supported Markdown subset as React elements. There is no
 * `dangerouslySetInnerHTML`: raw HTML in a document is displayed as text, and
 * an unsafe link destination stays literal text instead of an anchor.
 */
function inlineNodes(
  tokens: readonly InlineToken[],
  onNavigate: (path: string) => void,
  keyPrefix: string,
): ReactNode[] {
  return tokens.map((token, index) => {
    const key = `${keyPrefix}-${index}`
    switch (token.type) {
      case 'text':
        return token.text
      case 'code':
        return <code key={key}>{token.text}</code>
      case 'strong':
        return <strong key={key}>{token.text}</strong>
      case 'emphasis':
        return <em key={key}>{token.text}</em>
      case 'link':
        if (token.href.startsWith('/')) {
          // Only routes the SPA draws use the in-app router. Server documents
          // such as `/docs` and `/openapi.json` must get a full page load.
          if (isClientRoute(token.href)) {
            return (
              <AppLink key={key} href={token.href} onNavigate={onNavigate}>
                {token.text}
              </AppLink>
            )
          }
          return (
            <a key={key} href={token.href}>
              {token.text}
            </a>
          )
        }
        if (token.href.startsWith('#')) {
          return (
            <a key={key} href={token.href}>
              {token.text}
            </a>
          )
        }
        return (
          <a key={key} href={token.href} target="_blank" rel="noopener noreferrer">
            {token.text}
          </a>
        )
      default:
        return null
    }
  })
}

interface GuideMarkdownProps {
  readonly markdown: string
  readonly onNavigate: (path: string) => void
}

export function GuideMarkdown({ markdown, onNavigate }: GuideMarkdownProps) {
  const blocks = useMemo(() => parseMarkdown(markdown), [markdown])

  return (
    <article className="guide-article">
      {blocks.map((block, index) => {
        const key = `block-${index}`
        if (block.type === 'heading') {
          const HeadingTag = `h${block.level}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
          return (
            <HeadingTag key={key}>
              {inlineNodes(parseInline(block.text), onNavigate, key)}
            </HeadingTag>
          )
        }
        if (block.type === 'paragraph') {
          return <p key={key}>{inlineNodes(parseInline(block.text), onNavigate, key)}</p>
        }
        if (block.type === 'list') {
          const ListTag = block.ordered ? 'ol' : 'ul'
          return (
            <ListTag key={key}>
              {block.items.map((item, itemIndex) => {
                const itemKey = `${key}-${itemIndex}`
                return <li key={itemKey}>{inlineNodes(parseInline(item), onNavigate, itemKey)}</li>
              })}
            </ListTag>
          )
        }
        return (
          // A code block can scroll horizontally on a narrow screen; making it
          // focusable keeps that overflow reachable from the keyboard.
          <pre key={key} tabIndex={0}>
            <code {...(block.language === null ? {} : { className: `language-${block.language}` })}>
              {block.code}
            </code>
          </pre>
        )
      })}
    </article>
  )
}
