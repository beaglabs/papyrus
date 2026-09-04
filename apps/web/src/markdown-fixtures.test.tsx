import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MarkdownText } from './AcpSessionContent.js'

const render = (text: string) => renderToStaticMarkup(<MarkdownText text={text} />)

describe('agent Markdown/output fixtures', () => {
  it('renders headings, lists, tables, quotes, emphasis, and fenced code together', () => {
    const html = render([
      '# Result',
      '',
      '> governed output',
      '',
      '- **one**',
      '- `two`',
      '',
      '| Key | Value |',
      '| --- | ---: |',
      '| count | 2 |',
      '',
      '```ts',
      'const value = "<script>"',
      '```',
    ].join('\n'))
    expect(html).toContain('<h1>Result</h1>')
    expect(html).toContain('<blockquote>governed output</blockquote>')
    expect(html).toContain('<table>')
    expect(html).toContain('language-ts')
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>')
  })

  it('keeps raw HTML and tool-looking output inert', () => {
    const html = render('<img src=x onerror=alert(1)>\n\n<tool_call>{"name":"workspace.exec"}</tool_call>')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).toContain('&lt;tool_call&gt;')
    expect(html).not.toContain('onerror="')
  })

  it('rejects executable and credential-bearing link schemes', () => {
    const html = render('[js](javascript:alert(1)) [data](data:text/html,boom) [file](file:///etc/passwd) [ok](https://example.test/path)')
    expect(html).not.toContain('href="javascript:')
    expect(html).not.toContain('href="data:')
    expect(html).not.toContain('href="file:')
    expect(html).toContain('href="https://example.test/path"')
  })

  it('handles malformed and unterminated fences without executing or throwing', () => {
    const html = render('before\n\n```sh\nprintf "hello"\n<script>alert(1)</script>')
    expect(html).toContain('<pre>')
    expect(html).toContain('printf')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('renders long agent output without truncating the semantic text', () => {
    const marker = 'papyrus-fixture-' + 'x'.repeat(32_000)
    const html = render(marker)
    expect(html).toContain('papyrus-fixture-')
    expect(html.length).toBeGreaterThan(32_000)
  })
})
