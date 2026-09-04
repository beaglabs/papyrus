import { describe, expect, it } from 'vitest'
import { validateStaticHtml } from '../src/agent/link-preview.js'

describe('Link webpage validation', () => {
  it('accepts presentation-neutral static HTML', () => {
    expect(() => validateStaticHtml('<!doctype html><html><head><style>body{font-family:serif}</style></head><body><main>Hello</main></body></html>')).not.toThrow()
  })

  it('rejects executable browser content', () => {
    expect(() => validateStaticHtml('<script>alert(1)</script>')).toThrow(/static/)
    expect(() => validateStaticHtml('<button onclick="alert(1)">x</button>')).toThrow(/event handlers/)
    expect(() => validateStaticHtml('<iframe src="https://example.test"></iframe>')).toThrow(/frames/)
  })

  it('does not impose a Papyrus stylesheet on the generated document', () => {
    const html = '<!doctype html><style>:root{color-scheme:dark}body{background:#123;color:#fff}</style><p>custom</p>'
    expect(() => validateStaticHtml(html)).not.toThrow()
  })
})
