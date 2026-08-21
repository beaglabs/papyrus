import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadFileConfig } from '../src/config-file.js'

describe('YAML config file', () => {
  it('parses connector and license authority configuration', () => {
    const dir = mkdtempSync(join(tmpdir(), 'papyrus-yaml-'))
    const path = join(dir, 'papyrus.yaml')
    writeFileSync(path, `connectors: [chrome-acp, unknown]\nlicenseAuthorities:\n  root: |\n    -----BEGIN PUBLIC KEY-----\n    abc\n    -----END PUBLIC KEY-----\n`)
    try {
      const config = loadFileConfig(path)
      expect(config.connectors).toEqual(['chrome-acp'])
      expect(config.licenseAuthorities?.root).toContain('abc')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('returns empty for a missing file', () => {
    expect(loadFileConfig('/nonexistent/papyrus.yaml')).toEqual({})
  })
})
