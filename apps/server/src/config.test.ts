import { describe, expect, it } from 'vitest'
import { loadConfig } from './config.js'

describe('license deployment invariant', () => {
  it('always requires a license in persistent mode', () => {
    const config = loadConfig({
      PAPYRUS_MODE: 'persistent',
      PAPYRUS_PROFILE: 'commercial',
      PAPYRUS_PUBLIC_ORIGIN: 'https://papyrus.example.test',
      PAPYRUS_SESSION_SECRET: 'a'.repeat(32),
      PAPYRUS_LICENSE_REQUIRED: 'false',
    })

    expect(config.licenseRequired).toBe(true)
  })

  it('does not require a production license in local mode', () => {
    const config = loadConfig({
      PAPYRUS_MODE: 'local',
      PAPYRUS_PROFILE: 'commercial',
    })

    expect(config.licenseRequired).toBe(false)
  })
})
