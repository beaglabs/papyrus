import { describe, expect, it } from 'vitest'
import { PUBLIC_LINK_WEBPAGE_CSP } from '../src/agent/link-http.js'

describe('public Link webpage CSP', () => {
  it('allows HTTPS photos without relaxing active-content boundaries', () => {
    expect(PUBLIC_LINK_WEBPAGE_CSP).toContain("img-src 'self' data: https:")
    expect(PUBLIC_LINK_WEBPAGE_CSP).toContain("connect-src 'none'")
    expect(PUBLIC_LINK_WEBPAGE_CSP).toContain("frame-src 'none'")
    expect(PUBLIC_LINK_WEBPAGE_CSP).toContain("object-src 'none'")
    expect(PUBLIC_LINK_WEBPAGE_CSP).not.toContain('script-src')
  })
})
