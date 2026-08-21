import { describe, expect, it, vi } from 'vitest'
import { loadConfig } from './config.js'

const oidcEnv = {
  PAPYRUS_OIDC_ISSUER: 'https://identity.example.test',
  PAPYRUS_OIDC_CLIENT_ID: 'papyrus',
  PAPYRUS_OIDC_REDIRECT_URI: 'http://127.0.0.1:3210/api/auth/oidc/callback',
}

const baseEnv = {
  PAPYRUS_MODE: 'local',
  PAPYRUS_PROFILE: 'commercial',
  PAPYRUS_PUBLIC_ORIGIN: 'http://127.0.0.1:3210',
  PAPYRUS_SESSION_SECRET: 'a'.repeat(32),
  ...oidcEnv,
}

const persistentEnv = {
  ...baseEnv,
  PAPYRUS_MODE: 'persistent',
  PAPYRUS_PUBLIC_ORIGIN: 'https://papyrus.example.test',
  PAPYRUS_OIDC_REDIRECT_URI: 'https://papyrus.example.test/api/auth/oidc/callback',
}

describe('license deployment invariant', () => {
  it('always requires a license in persistent mode', () => {
    vi.stubGlobal('process', { ...process, versions: { ...process.versions, node: '24.0.0' } })
    const config = loadConfig({
      ...persistentEnv,
      PAPYRUS_LICENSE_REQUIRED: 'false',
    })
    expect(config.licenseRequired).toBe(true)
  })

  it('does not require a production license in local mode', () => {
    const config = loadConfig(baseEnv)
    expect(config.licenseRequired).toBe(false)
  })
})

describe('authentication deployment boundaries', () => {
  it('fails closed when a commercial daemon has a remote origin without organizational authentication', () => {
    expect(() => loadConfig({
      PAPYRUS_MODE: 'local',
      PAPYRUS_PROFILE: 'commercial',
      PAPYRUS_PUBLIC_ORIGIN: 'https://papyrus.internal.example',
      PAPYRUS_SESSION_SECRET: 'a'.repeat(32),
    })).toThrow(/Remote commercial access requires OIDC or a trusted identity proxy/)
  })

  it('requires a real authentication method in persistent commercial mode', () => {
    vi.stubGlobal('process', { ...process, versions: { ...process.versions, node: '24.0.0' } })
    expect(() => loadConfig({
      PAPYRUS_MODE: 'persistent',
      PAPYRUS_PROFILE: 'commercial',
      PAPYRUS_PUBLIC_ORIGIN: 'https://papyrus.example.test',
      PAPYRUS_SESSION_SECRET: 'a'.repeat(32),
    })).toThrow(/requires OIDC or a trusted identity proxy/)
  })

  it('requires the OIDC callback to return to the configured daemon origin', () => {
    expect(() => loadConfig({
      ...baseEnv,
      PAPYRUS_OIDC_REDIRECT_URI: 'http://127.0.0.1:9999/api/auth/oidc/callback',
    })).toThrow(/must use PAPYRUS_PUBLIC_ORIGIN/)
  })

  it('requires an authenticated TLS hop and valid proxy fingerprints', () => {
    const base = {
      ...baseEnv,
      PAPYRUS_IDENTITY_PROXY_ALLOW_FINGERPRINTS: 'ab'.repeat(32),
    }
    expect(() => loadConfig(base)).toThrow(/requires direct Papyrus TLS/)
    expect(() => loadConfig({
      ...base,
      PAPYRUS_TLS_CERT: '/tmp/server.pem',
      PAPYRUS_TLS_KEY: '/tmp/server-key.pem',
      PAPYRUS_TLS_CA: '/tmp/proxy-ca.pem',
    })).not.toThrow()
    expect(() => loadConfig({
      ...base,
      PAPYRUS_IDENTITY_PROXY_ALLOW_FINGERPRINTS: 'not-a-fingerprint',
      PAPYRUS_TLS_CERT: '/tmp/server.pem',
      PAPYRUS_TLS_KEY: '/tmp/server-key.pem',
      PAPYRUS_TLS_CA: '/tmp/proxy-ca.pem',
    })).toThrow(/SHA-256 certificate fingerprints/)
  })

  it('restricts gateway development tokens to local loopback use', () => {
    expect(() => loadConfig({
      ...baseEnv,
      PAPYRUS_GATEWAY_ENABLED: 'true',
      PAPYRUS_GATEWAY_DEV_TOKEN: 'short',
    })).toThrow(/at least 32 characters/)
  })

  it('defaults and bounds the Streamable HTTP gateway controls', () => {
    const config = loadConfig({
      ...baseEnv,
      PAPYRUS_GATEWAY_ENABLED: 'true',
    })
    expect(config.gateway).toMatchObject({
      maxRequestBodyBytes: 1_048_576,
      maxConnections: 128,
      connectionIdleMs: 900_000,
      requestTimeoutMs: 30_000,
    })
    expect(() => loadConfig({
      ...baseEnv,
      PAPYRUS_GATEWAY_ENABLED: 'true',
      PAPYRUS_GATEWAY_MAX_CONNECTIONS: '0',
    })).toThrow(/PAPYRUS_GATEWAY_MAX_CONNECTIONS/)
    expect(() => loadConfig({
      ...baseEnv,
      PAPYRUS_GATEWAY_ENABLED: 'true',
      PAPYRUS_GATEWAY_MAX_REQUEST_BODY_BYTES: '100',
    })).toThrow(/PAPYRUS_GATEWAY_MAX_REQUEST_BODY_BYTES/)
  })

  it('requires gateway mTLS whenever the ACP listener leaves loopback', () => {
    const remote = {
      ...baseEnv,
      PAPYRUS_GATEWAY_ENABLED: 'true',
      PAPYRUS_GATEWAY_HOST: '0.0.0.0',
    }
    expect(() => loadConfig(remote)).toThrow(/Gateway requires mTLS/)
    expect(() => loadConfig({
      ...remote,
      PAPYRUS_GATEWAY_TLS_CERT: '/tmp/server.pem',
      PAPYRUS_GATEWAY_TLS_KEY: '/tmp/server-key.pem',
      PAPYRUS_GATEWAY_TLS_CA: '/tmp/client-ca.pem',
    })).not.toThrow()
  })
})

describe('model endpoint configuration', () => {
  it('accepts and normalizes an OpenAI-compatible provider base path', () => {
    const config = loadConfig({
      ...baseEnv,
      PAPYRUS_MODEL_ENDPOINT: 'https://openrouter.ai/api/',
      PAPYRUS_MODEL: 'example/model',
    })

    expect(config.model).toMatchObject({
      endpoint: 'https://openrouter.ai/api',
      model: 'example/model',
    })
  })

  it('rejects model endpoint credentials, queries, and fragments', () => {
    const base = {
      ...baseEnv,
      PAPYRUS_MODEL: 'example/model',
    }
    expect(() => loadConfig({
      ...base,
      PAPYRUS_MODEL_ENDPOINT: 'https://user:secret@example.test/api',
    })).toThrow(/without a query, fragment, or credentials/)
    expect(() => loadConfig({
      ...base,
      PAPYRUS_MODEL_ENDPOINT: 'https://example.test/api?tenant=one',
    })).toThrow(/without a query, fragment, or credentials/)
  })
})
