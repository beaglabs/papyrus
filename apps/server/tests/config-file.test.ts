import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadFileConfig } from '../src/config-file.js'

describe('YAML config file', () => {
  it('parses agents and license authorities', () => {
    const dir = mkdtempSync(join(tmpdir(), 'papyrus-yaml-'))
    const path = join(dir, 'papyrus.yaml')
    writeFileSync(path, `agents:\n  opencode:\n    command: opencode\n    args: [acp]\n    env:\n      MODEL: "{model}"\n      OPENAI_API_KEY: "{secret}"\nlicenseAuthorities:\n  root: |\n    -----BEGIN PUBLIC KEY-----\n    abc\n    -----END PUBLIC KEY-----\n`)
    try {
      const config = loadFileConfig(path)
      expect(config.agents?.opencode?.command).toBe('opencode')
      expect(config.agents?.opencode?.args).toEqual(['acp'])
      expect(config.agents?.opencode?.env).toEqual({ MODEL: '{model}', OPENAI_API_KEY: '{secret}' })
      expect(config.licenseAuthorities?.root).toContain('abc')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('returns empty for a missing file', () => {
    expect(loadFileConfig('/nonexistent/papyrus.yaml')).toEqual({})
  })
})
