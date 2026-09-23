import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PortalPrincipal } from '@papyrus/contracts'
import type { AgentConfig } from '../src/agent/config.js'
import { EntraAuthService, graphUserScope } from '../src/agent/entra-auth.js'

function config(cloud: AgentConfig['cloud'] = 'Public'): AgentConfig {
  const tenantId = '22222222-2222-2222-2222-222222222222'
  const clientId = '33333333-3333-3333-3333-333333333333'
  const authorityHost = cloud === 'Public' ? 'https://login.microsoftonline.com' : 'https://login.microsoftonline.us'
  const authority = `${authorityHost}/${tenantId}/v2.0`
  return {
    mode: 'local',
    profile: 'gcc',
    host: '127.0.0.1',
    port: 3210,
    publicOrigin: 'http://127.0.0.1:3210',
    dataDir: '/tmp/papyrus-auth-profile-test',
    databasePath: ':memory:',
    portalSecret: 'portal-secret-at-least-thirty-two-characters',
    organizationName: 'Customer Agent Operations',
    cloud,
    entra: {
      tenantId,
      clientId,
      scope: `api://${clientId}/access_as_user`,
      authority,
      issuer: authority,
    },
    licenseRequired: false,
    licenseAuthorities: {},
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Entra profile enrichment', () => {
  it('uses the correct Microsoft Graph User.Read resource in each national cloud', () => {
    expect(graphUserScope('Public')).toBe('https://graph.microsoft.com/User.Read')
    expect(graphUserScope('USGov')).toBe('https://graph.microsoft.us/User.Read')
    expect(graphUserScope('USGovDoD')).toBe('https://dod-graph.microsoft.us/User.Read')
  })

  it('requests Graph User.Read during interactive portal login', async () => {
    const subject = new EntraAuthService(config())
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      authorization_endpoint: 'https://login.microsoftonline.com/oauth2/v2.0/authorize',
      token_endpoint: 'https://login.microsoftonline.com/oauth2/v2.0/token',
      jwks_uri: 'https://login.microsoftonline.com/discovery/v2.0/keys',
      issuer: 'https://login.microsoftonline.com/22222222-2222-2222-2222-222222222222/v2.0',
    }), { status: 200, headers: { 'content-type': 'application/json' } })))

    const url = new URL(await subject.startLogin('/portal'))
    expect(url.searchParams.get('scope')).toBe('openid profile email https://graph.microsoft.com/User.Read')
    expect(url.searchParams.get('response_type')).toBe('code')
  })

  it('keeps cached photo and organization metadata out of the signed cookie', () => {
    const subject = new EntraAuthService(config())
    const principal = {
      oid: '11111111-1111-1111-1111-111111111111',
      tenantId: '22222222-2222-2222-2222-222222222222',
      displayName: 'Agent Analyst',
      preferredUsername: 'analyst@example.mil',
      roles: ['Papyrus.Integration.View'],
      groups: [],
      source: 'entra',
      organizationName: 'Example Agency',
      pictureUrl: 'data:image/jpeg;base64,AAAA',
    } as PortalPrincipal & { organizationName: string; pictureUrl: string }

    const cookie = subject.portalCookie(principal)
    const encodedToken = cookie.slice(cookie.indexOf('=') + 1, cookie.indexOf(';'))
    const [body] = decodeURIComponent(encodedToken).split('.')
    expect(body).toBeTruthy()
    const payload = JSON.parse(Buffer.from(body!, 'base64url').toString('utf8')) as {
      principal: Record<string, unknown>
      identityVersion: number
    }
    expect(payload.identityVersion).toBe(2)
    expect(payload.principal['pictureUrl']).toBeUndefined()
    expect(payload.principal['organizationName']).toBeUndefined()
    expect(payload.principal['oid']).toBe(principal.oid)
  })
})
