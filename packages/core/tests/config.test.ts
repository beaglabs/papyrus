import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  type ConfigFile,
  type PapyrusConfig,
  loadConfigFile,
  resolveConfig,
  validateConfig,
} from '../src/config/loader.js'

function writeConfig(dir: string, config: ConfigFile): string {
  const file = join(dir, 'config.json')
  writeFileSync(file, JSON.stringify(config, null, 2), 'utf-8')
  return file
}

describe('config loader', () => {
  it('loads a valid config file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'papyrus-config-'))
    try {
      const file = writeConfig(dir, {
        profile: 'siprnet-il6',
        auth: { allowed: ['cac-piv'], providers: { cacPiv: { caBundle: '/etc/pki/ca.crt' } } },
        llm: { endpoint: 'https://vllm.internal.mil/v1', model: 'llama-70b' },
        sync: { peers: ['10.0.0.1:4433'], allowInternet: false },
        features: { agents: true, crossDomainExport: false },
      })
      const loaded = loadConfigFile(file)
      expect(loaded).not.toBeNull()
      expect(loaded?.profile).toBe('siprnet-il6')
      expect(loaded?.auth?.allowed).toEqual(['cac-piv'])
      expect(loaded?.llm?.endpoint).toBe('https://vllm.internal.mil/v1')
    } finally {
      rmSync(dir, { recursive: true })
    }
  })

  it('returns null for missing file', () => {
    expect(loadConfigFile('/nonexistent/config.json')).toBeNull()
  })

  it('returns null for malformed JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'papyrus-config-bad-'))
    try {
      const file = join(dir, 'config.json')
      writeFileSync(file, '{ broken json }}', 'utf-8')
      expect(loadConfigFile(file)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true })
    }
  })

  it('resolves with profile defaults when no config file', () => {
    const config = resolveConfig({ PAPYRUS_CONFIG: '/nonexistent' }, 'commercial')
    expect(config.profile).toBe('commercial')
    expect(config.auth.allowed).toContain('webauthn')
    expect(config.features.agents).toBe(true)
  })

  it('merges config file with defaults', () => {
    const dir = mkdtempSync(join(tmpdir(), 'papyrus-config-merge-'))
    try {
      writeConfig(dir, { profile: 'niprnet-il4' })
      const configFile = join(dir, 'config.json')
      const env = { PAPYRUS_CONFIG: configFile }
      const config = resolveConfig(env)
      expect(config.profile).toBe('niprnet-il4')
      // auth.allowed should come from defaults (cac-piv + webauthn)
      expect(config.auth.allowed).toEqual(['cac-piv', 'webauthn'])
    } finally {
      rmSync(dir, { recursive: true })
    }
  })

  it('CLI profile flag overrides config file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'papyrus-config-override-'))
    try {
      writeConfig(dir, { profile: 'commercial' })
      const env = { PAPYRUS_CONFIG: join(dir, 'config.json') }
      const config = resolveConfig(env, 'siprnet-il6')
      expect(config.profile).toBe('siprnet-il6')
      expect(config.auth.allowed).toEqual(['cac-piv'])
    } finally {
      rmSync(dir, { recursive: true })
    }
  })

  it('validates config correctly', () => {
    expect(
      validateConfig({
        profile: 'commercial',
        auth: { allowed: ['webauthn'], providers: {} },
        llm: null,
        sync: { peers: [], allowInternet: true },
        features: { agents: true, crossDomainExport: true },
      }),
    ).toEqual([])

    expect(
      validateConfig({
        profile: 'bad-profile' as PapyrusConfig['profile'],
        auth: { allowed: ['webauthn'], providers: {} },
        llm: null,
        sync: { peers: [], allowInternet: true },
        features: { agents: true, crossDomainExport: true },
      }),
    ).toContainEqual('Invalid profile: "bad-profile"')

    expect(
      validateConfig({
        profile: 'commercial',
        auth: { allowed: ['invalid-method' as PapyrusConfig['auth']['allowed'][0]], providers: {} },
        llm: null,
        sync: { peers: [], allowInternet: true },
        features: { agents: true, crossDomainExport: true },
      }),
    ).toContainEqual('Invalid auth method: "invalid-method"')
  })

  it('validates LLM endpoint URL', () => {
    const errors = validateConfig({
      profile: 'commercial',
      auth: { allowed: ['webauthn'], providers: {} },
      llm: { endpoint: 'not-a-url', model: 'test' },
      sync: { peers: [], allowInternet: true },
      features: { agents: true, crossDomainExport: true },
    })
    expect(errors).toContainEqual('LLM endpoint must be an HTTP(S) URL, got: "not-a-url"')
  })
})
