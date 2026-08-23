import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MarkdownText } from './AcpSessionContent.js'

describe('MarkdownText', () => {
  it('renders common Markdown structures', () => {
    const html = renderToStaticMarkup(<MarkdownText text={'## Summary\n\n- **Bold** item\n- `code` item\n\n[Source](https://example.test)'} />)

    expect(html).toContain('<h2>Summary</h2>')
    expect(html).toContain('<ul>')
    expect(html).toContain('<strong>Bold</strong>')
    expect(html).toContain('<code>code</code>')
    expect(html).toContain('href="https://example.test"')
  })

  it('leaves raw HTML inert and rejects executable link schemes', () => {
    const html = renderToStaticMarkup(<MarkdownText text={'<script>alert(1)</script>\n\n[unsafe](javascript:alert(1))'} />)

    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('href="javascript:')
  })
})
