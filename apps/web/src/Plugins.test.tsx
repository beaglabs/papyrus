import { describe, expect, it } from 'vitest'
import { pluginLogoUrl } from './Plugins.js'

describe('plugin logos', () => {
  it('routes curated logos through the same-origin image proxy', () => {
    const value = pluginLogoUrl('exchange-email')
    expect(value).toMatch(/^\/api\/url-preview\/image\?url=/)
    expect(decodeURIComponent(value!.split('url=')[1]!)).toContain('Microsoft_Exchange')
  })

  it('keeps initials as the fallback for entries without artwork', () => {
    expect(pluginLogoUrl('microsoft-entra')).toBeUndefined()
  })
})
