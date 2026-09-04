import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MarkdownMessage } from './Markdown.js'

const render = (text: string) => renderToStaticMarkup(<MarkdownMessage>{text}</MarkdownMessage>)

describe('agent Markdown/output fixtures', () => {
  it('renders rich Markdown while keeping raw HTML inert', () => {
    const html = render('# Result\n\n> governed output\n\n- **one**\n- `two`\n\n| Key | Value |\n| --- | ---: |\n| count | 2 |\n\n```ts\nconst value = "<script>"\n```')
    expect(html).toContain('<h1>Result</h1>')
    expect(html).toContain('<table>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>')
  })

  it('rejects executable and local-file link schemes', () => {
    const html = render('[js](javascript:alert(1)) [data](data:text/html,boom) [file](file:///etc/passwd) [ok](https://example.test/path)')
    expect(html).not.toContain('href="javascript:')
    expect(html).not.toContain('href="data:')
    expect(html).not.toContain('href="file:')
    expect(html).toContain('href="https://example.test/path"')
  })

  it('does not truncate long semantic output', () => {
    const marker = 'papyrus-fixture-' + 'x'.repeat(32_000)
    expect(render(marker).length).toBeGreaterThan(32_000)
  })
})
