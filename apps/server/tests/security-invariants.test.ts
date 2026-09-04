import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WORKSPACE_TOOLS } from '@mastra/core/workspace'
import { loadConfig } from '../src/config.js'
import { runtimeToolAction } from '../src/mastra/authorization.js'
import { bubblewrapArgs, sandboxEnvironment, seatbeltProfile } from '../src/mastra/sandbox.js'

const governmentBase = {
  PAPYRUS_MODE: 'local',
  PAPYRUS_PUBLIC_ORIGIN: 'https://127.0.0.1:3210',
  PAPYRUS_SESSION_SECRET: 'a'.repeat(32),
  PAPYRUS_TLS_CERT: '/tmp/server.pem',
  PAPYRUS_TLS_KEY: '/tmp/server-key.pem',
  PAPYRUS_TLS_CA: '/tmp/cac-ca.pem',
}

describe('pre-commit security invariants', () => {
  it('keeps native browser access fail-closed by default in government profiles', () => {
    for (const profile of ['government-il4', 'government-il6'] as const) {
      const config = loadConfig({ ...governmentBase, PAPYRUS_PROFILE: profile })
      expect(config.nativeBrowserEnabled, profile).toBe(false)
    }
  })

  it('keeps government identity on the mTLS path', () => {
    expect(() => loadConfig({
      ...governmentBase,
      PAPYRUS_PROFILE: 'government-il4',
      PAPYRUS_OIDC_ISSUER: 'https://identity.example.test',
      PAPYRUS_OIDC_CLIENT_ID: 'papyrus',
      PAPYRUS_OIDC_REDIRECT_URI: 'https://127.0.0.1:3210/api/auth/oidc/callback',
    })).toThrow(/do not support OIDC/)
  })

  it('does not authorize tools that are absent from the exact runtime map', () => {
    expect(runtimeToolAction(WORKSPACE_TOOLS.FILESYSTEM.DELETE)).toBeUndefined()
    expect(runtimeToolAction(WORKSPACE_TOOLS.SEARCH.INDEX)).toBeUndefined()
    expect(runtimeToolAction(WORKSPACE_TOOLS.LSP.LSP_INSPECT)).toBeUndefined()
    expect(runtimeToolAction('papyrus_browser_execute')).toBeUndefined()
    expect(runtimeToolAction('unregistered_dependency_tool')).toBeUndefined()
  })

  it('keeps both OS sandbox profiles offline and deny-first', () => {
    const root = mkdtempSync(join(tmpdir(), 'papyrus-invariant-'))
    try {
      const seatbelt = seatbeltProfile(root)
      expect(seatbelt).toContain('(deny default)')
      expect(seatbelt).toContain('(deny network*)')
      expect(seatbelt).not.toContain('(allow network')

      const bwrap = bubblewrapArgs(root)
      expect(bwrap).toContain('--unshare-all')
      expect(bwrap).toContain('--die-with-parent')
      expect(bwrap).toContain('--new-session')
      expect(bwrap).toContain('--bind')
      expect(bwrap).toContain(realpathSync(root))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not inherit host credentials into command sandboxes', () => {
    const root = mkdtempSync(join(tmpdir(), 'papyrus-env-'))
    try {
      const env = sandboxEnvironment(root)
      expect(Object.keys(env).sort()).toEqual(['PATH', 'TMPDIR'])
      expect(env.PAPYRUS_SESSION_SECRET).toBeUndefined()
      expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined()
      expect(env.GITHUB_TOKEN).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
