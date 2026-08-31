import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ContentMessage, MarkdownText } from './AcpSessionContent.js'

describe('MarkdownText', () => {
  it('renders common Markdown structures', () => {
    const html = renderToStaticMarkup(<MarkdownText text={'## Summary\n\n- **Bold** item\n- `code` item\n\n[Source](https://example.test)'} />)

    expect(html).toContain('<h2>Summary</h2>')
    expect(html).toContain('<ul>')
    expect(html).toContain('<strong>Bold</strong>')
    expect(html).toContain('<code>code</code>')
    expect(html).toContain('href="https://example.test"')
  })

  it('renders GitHub-style Markdown tables with alignment', () => {
    const html = renderToStaticMarkup(<MarkdownText text={'| Name | Status | Count |\n| :--- | :---: | ---: |\n| Report | **Ready** | 4 |'} />)

    expect(html).toContain('<table>')
    expect(html).toContain('class="align-center"')
    expect(html).toContain('class="align-right"')
    expect(html).toContain('<strong>Ready</strong>')
  })

  it('leaves raw HTML inert and rejects executable link schemes', () => {
    const html = renderToStaticMarkup(<MarkdownText text={'<script>alert(1)</script>\n\n[unsafe](javascript:alert(1))'} />)

    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('href="javascript:')
  })
  it('shows only a compact working indicator for active reasoning', () => {
    const message = {
      id: 'thought',
      role: 'thought',
      sequence: 1,
      blocks: [{ type: 'text', text: 'raw provider reasoning that must not be rendered' }],
    } as never
    const active = renderToStaticMarkup(<ContentMessage message={message} active />)
    expect(active).toContain('Working…')
    expect(active).not.toContain('raw provider reasoning')
    expect(renderToStaticMarkup(<ContentMessage message={message} />)).toBe('')
  })

})
