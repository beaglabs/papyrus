import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MarkdownMessage } from './Markdown.js'

describe('MarkdownMessage', () => {
  it('renders GFM structure instead of exposing markdown syntax', () => {
    const html = renderToStaticMarkup(<MarkdownMessage>{`## Exchange setup

The **daemon** validates this before activation.

| Field | Required? |
| --- | --- |
| Mailbox | Yes |
| Data handling | Metadata only<br>Normalized events |

- First item
- Second item

\`credentialRef\``}</MarkdownMessage>)

    expect(html).toContain('<h2>Exchange setup</h2>')
    expect(html).toContain('<strong>daemon</strong>')
    expect(html).toContain('<thead>')
    expect(html).toContain('<th>Field</th>')
    expect(html).toContain('<td>Metadata only<br/>Normalized events</td>')
    expect(html).toContain('<ul>')
    expect(html).toContain('class="inline-code"')
    expect(html).not.toContain('**daemon**')
    expect(html).not.toContain('| Field |')
    expect(html).not.toContain('&lt;br&gt;')
  })

  it('styles task identifiers through the remark AST', () => {
    const html = renderToStaticMarkup(<MarkdownMessage>{'**Task ID:** c2c88f39-b1e4-4694-865d-3867719264ef'}</MarkdownMessage>)
    expect(html).toContain('class="task-id-line"')
    expect(html).toContain('<strong>Task ID:</strong>')
    expect(html).toContain('c2c88f39-b1e4-4694-865d-3867719264ef')
    expect(html).not.toContain('**Task ID:**')
  })

  it('does not emit executable markdown links', () => {
    const html = renderToStaticMarkup(<MarkdownMessage>{'[safe](https://example.com) [unsafe](javascript:alert(1))'}</MarkdownMessage>)
    expect(html).toContain('href="https://example.com"')
    expect(html).not.toContain('javascript:')
    expect(html).toContain('<span>unsafe</span>')
  })
})
