import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadFileConfig } from '../src/config-file.js'

describe('YAML config file', () => {
  it('parses agents and license authorities', () => {
    const dir = mkdtempSync(join(tmpdir(), 'papyrus-yaml-'))
    const path = join(dir, 'papyrus.yaml')
    writeFileSync(path, `agents:\n  reviewer:\n    profile: opencode\n    environment:\n      OPENAI_API_KEY: PAPYRUS_SECRET_OPENAI\n  rejected:\n    profile: custom-shell\n    command: sh\nconnectors: [chrome-acp, unknown]\nlicenseAuthorities:\n  root: |\n    -----BEGIN PUBLIC KEY-----\n    abc\n    -----END PUBLIC KEY-----\n`)
    try {
      const config = loadFileConfig(path, { PAPYRUS_SECRET_OPENAI: 'test-key' })
      expect(config.agents?.reviewer).toEqual({ profile: 'opencode', environment: { OPENAI_API_KEY: 'test-key' } })
      expect(config.agents?.rejected).toBeUndefined()
      expect(config.connectors).toEqual(['chrome-acp'])
      expect(config.licenseAuthorities?.root).toContain('abc')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('returns empty for a missing file', () => {
    expect(loadFileConfig('/nonexistent/papyrus.yaml')).toEqual({})
  })
})
