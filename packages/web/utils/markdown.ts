const SAFE_URL_PROTOCOLS = new Set(['http:', 'https:'])

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function sanitizeUrl(rawUrl: string): string {
  try {
    const normalized = new URL(rawUrl)
    if (!SAFE_URL_PROTOCOLS.has(normalized.protocol)) return '#'
    return normalized.toString()
  } catch {
    return '#'
  }
}

function renderInlineMarkdown(input: string): string {
  let html = escapeHtml(input)
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>')
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/__([^_]+)__/g, '<strong>$1</strong>')
  html = html.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>')
  html = html.replace(/(?<!_)_([^_]+)_(?!_)/g, '<em>$1</em>')
  html = html.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label: string, rawUrl: string) => {
    const safeUrl = sanitizeUrl(rawUrl)
    return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${label}</a>`
  })
  return html
}

function captureMarkdownContent(match: RegExpMatchArray, fallbackIndex: number): string {
  const candidate = match.at(fallbackIndex)
  return typeof candidate === 'string' ? candidate : ''
}

function renderList(lines: string[], ordered: boolean): string {
  const tag = ordered ? 'ol' : 'ul'
  const items = lines.map((line) => `<li>${renderInlineMarkdown(line)}</li>`).join('')
  return `<${tag}>${items}</${tag}>`
}

export function renderMarkdownToHtml(markdown: string): string {
  if (!markdown.trim()) return '<p>No description available.</p>'

  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const blocks: string[] = []
  let index = 0

  while (index < lines.length) {
    const current = lines[index] ?? ''
    const trimmed = current.trim()

    if (!trimmed) {
      index += 1
      continue
    }

    if (trimmed.startsWith('```')) {
      index += 1
      const codeLines: string[] = []
      while (index < lines.length && !(lines[index] ?? '').trim().startsWith('```')) {
        codeLines.push(lines[index] ?? '')
        index += 1
      }
      blocks.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`)
      if (index < lines.length) index += 1
      continue
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/)
    if (headingMatch) {
      const levelToken = captureMarkdownContent(headingMatch, 1)
      const headingText = captureMarkdownContent(headingMatch, 2)
      const level = levelToken.length || 1
      blocks.push(`<h${level}>${renderInlineMarkdown(headingText)}</h${level}>`)
      index += 1
      continue
    }

    const unorderedMatch = trimmed.match(/^[-*+]\s+(.+)$/)
    if (unorderedMatch) {
      const listItems: string[] = [captureMarkdownContent(unorderedMatch, 1)]
      index += 1
      while (index < lines.length) {
        const next = (lines[index] ?? '').trim()
        const nextMatch = next.match(/^[-*+]\s+(.+)$/)
        if (!nextMatch) break
        listItems.push(captureMarkdownContent(nextMatch, 1))
        index += 1
      }
      blocks.push(renderList(listItems, false))
      continue
    }

    const orderedMatch = trimmed.match(/^\d+\.\s+(.+)$/)
    if (orderedMatch) {
      const listItems: string[] = [captureMarkdownContent(orderedMatch, 1)]
      index += 1
      while (index < lines.length) {
        const next = (lines[index] ?? '').trim()
        const nextMatch = next.match(/^\d+\.\s+(.+)$/)
        if (!nextMatch) break
        listItems.push(captureMarkdownContent(nextMatch, 1))
        index += 1
      }
      blocks.push(renderList(listItems, true))
      continue
    }

    const paragraphLines: string[] = [trimmed]
    index += 1
    while (index < lines.length) {
      const nextRaw = lines[index] ?? ''
      const nextTrimmed = nextRaw.trim()
      if (!nextTrimmed) break
      if (/^(#{1,6})\s+/.test(nextTrimmed)) break
      if (/^[-*+]\s+/.test(nextTrimmed)) break
      if (/^\d+\.\s+/.test(nextTrimmed)) break
      if (nextTrimmed.startsWith('```')) break
      paragraphLines.push(nextTrimmed)
      index += 1
    }
    blocks.push(`<p>${renderInlineMarkdown(paragraphLines.join('<br />'))}</p>`)
  }

  return blocks.join('\n')
}
