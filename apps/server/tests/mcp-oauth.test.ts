import { afterEach, describe, expect, it, vi } from 'vitest'
import { exchangeMcpCode, mcpClientMetadata, normalizeMcpEndpoint, prepareRemoteMcp, refreshMcpToken } from '../src/mcp-oauth.js'

afterEach(() => vi.unstubAllGlobals())

function oauthChallenge(metadataUrl = 'https://mcp.example/.well-known/oauth-protected-resource/mcp') {
  return new Response('', { status: 401, headers: { 'www-authenticate': `Bearer resource_metadata="${metadataUrl}"` } })
}

function resourceMetadata(issuer = 'https://auth.example') {
  return Response.json({ resource: 'https://mcp.example/mcp', authorization_servers: [issuer], scopes_supported: ['read', 'write'] })
}

function authorizationMetadata(overrides: Record<string, unknown> = {}) {
  return Response.json({
    issuer: 'https://auth.example',
    authorization_endpoint: 'https://auth.example/authorize',
    token_endpoint: 'https://auth.example/token',
    code_challenge_methods_supported: ['S256'],
    ...overrides,
  })
}

describe('remote MCP OAuth 2.1 registration', () => {
  it('normalizes Atlassian legacy MCP URLs to the OAuth-capable endpoint', () => {
    expect(normalizeMcpEndpoint('https://mcp.atlassian.com/v1/mcp')).toBe('https://mcp.atlassian.com/v1/mcp/authv2')
    expect(normalizeMcpEndpoint('https://mcp.example/mcp')).toBe('https://mcp.example/mcp')
  })

  it('uses a pre-registered client before other registration strategies', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(oauthChallenge())
      .mockResolvedValueOnce(resourceMetadata())
      .mockResolvedValueOnce(authorizationMetadata({ registration_endpoint: 'https://auth.example/register', client_id_metadata_document_supported: true }))
    vi.stubGlobal('fetch', fetch)

    const result = await prepareRemoteMcp('https://mcp.example/mcp', 'https://papyrus.example/api/mcp/oauth/callback', 'Papyrus', {
      clientMetadataUrl: 'https://papyrus.example/.well-known/mcp-client.json',
      resolveClient: () => ({ clientId: 'configured-client', clientSecret: 'configured-secret', scopes: 'read' }),
    })

    expect(result.kind).toBe('authorization_required')
    if (result.kind !== 'authorization_required') return
    expect(result.registration.registrationMethod).toBe('preregistered')
    expect(result.registration.clientId).toBe('configured-client')
    expect(new URL(result.registration.authorizationUrl).searchParams.get('scope')).toBe('read')
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('uses Client ID Metadata Documents when the authorization server supports CIMD', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(oauthChallenge())
      .mockResolvedValueOnce(resourceMetadata())
      .mockResolvedValueOnce(authorizationMetadata({ client_id_metadata_document_supported: true }))
    vi.stubGlobal('fetch', fetch)

    const result = await prepareRemoteMcp('https://mcp.example/mcp', 'https://papyrus.example/api/mcp/oauth/callback', 'Papyrus', {
      clientMetadataUrl: 'https://papyrus.example/.well-known/mcp-client.json',
    })
    expect(result.kind).toBe('authorization_required')
    if (result.kind !== 'authorization_required') return
    expect(result.registration.registrationMethod).toBe('cimd')
    expect(result.registration.clientId).toBe('https://papyrus.example/.well-known/mcp-client.json')
  })

  it('falls back to Dynamic Client Registration when advertised', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(oauthChallenge())
      .mockResolvedValueOnce(resourceMetadata())
      .mockResolvedValueOnce(authorizationMetadata({ registration_endpoint: 'https://auth.example/register' }))
      .mockResolvedValueOnce(Response.json({ client_id: 'dynamic-client' }))
    vi.stubGlobal('fetch', fetch)

    const result = await prepareRemoteMcp('https://mcp.example/mcp', 'https://papyrus.example/api/mcp/oauth/callback', 'Papyrus')
    expect(result.kind).toBe('authorization_required')
    if (result.kind !== 'authorization_required') return
    expect(result.registration.registrationMethod).toBe('dcr')
    expect(result.registration.clientId).toBe('dynamic-client')
    expect(String(fetch.mock.calls[3]?.[1]?.body)).toContain('authorization_code')
  })

  it('returns configuration_required when the provider needs pre-registration', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(oauthChallenge())
      .mockResolvedValueOnce(resourceMetadata())
      .mockResolvedValueOnce(authorizationMetadata())
    vi.stubGlobal('fetch', fetch)

    const result = await prepareRemoteMcp('https://mcp.example/mcp', 'https://papyrus.example/api/mcp/oauth/callback', 'Papyrus')
    expect(result).toMatchObject({ kind: 'configuration_required', issuer: 'https://auth.example' })
  })

  it('rejects protected-resource metadata for a different MCP resource', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(oauthChallenge())
      .mockResolvedValueOnce(Response.json({
        resource: 'https://evil.example/mcp',
        authorization_servers: ['https://auth.example'],
      }))
    vi.stubGlobal('fetch', fetch)

    await expect(prepareRemoteMcp(
      'https://mcp.example/mcp',
      'https://papyrus.example/api/mcp/oauth/callback',
      'Papyrus',
    )).rejects.toThrow('protected-resource metadata does not match')
  })

  it('unions a stored step-up scope with configured client scopes', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(oauthChallenge())
      .mockResolvedValueOnce(resourceMetadata())
      .mockResolvedValueOnce(authorizationMetadata())
    vi.stubGlobal('fetch', fetch)

    const result = await prepareRemoteMcp('https://mcp.example/mcp', 'https://papyrus.example/api/mcp/oauth/callback', 'Papyrus', {
      requestedScope: 'workflow notifications',
      resolveClient: () => ({ clientId: 'configured-client', clientSecret: 'configured-secret', scopes: 'repo workflow' }),
    })
    expect(result.kind).toBe('authorization_required')
    if (result.kind !== 'authorization_required') return
    expect(new Set(new URL(result.registration.authorizationUrl).searchParams.get('scope')?.split(' '))).toEqual(new Set(['repo', 'workflow', 'notifications']))
  })

  it('uses an OAuth challenge scope without expanding to every supported scope', async () => {
    const challenge = new Response('', {
      status: 401,
      headers: {
        'www-authenticate': 'Bearer scope="mcp:read mcp:write", resource_metadata="https://mcp.example/.well-known/oauth-protected-resource/mcp"',
      },
    })
    const fetch = vi.fn()
      .mockResolvedValueOnce(challenge)
      .mockResolvedValueOnce(resourceMetadata())
      .mockResolvedValueOnce(authorizationMetadata({ registration_endpoint: 'https://auth.example/register' }))
      .mockResolvedValueOnce(Response.json({ client_id: 'dynamic-client' }))
    vi.stubGlobal('fetch', fetch)

    const result = await prepareRemoteMcp('https://mcp.example/mcp', 'https://papyrus.example/api/mcp/oauth/callback', 'Papyrus')
    expect(result.kind).toBe('authorization_required')
    if (result.kind !== 'authorization_required') return
    expect(new URL(result.registration.authorizationUrl).searchParams.get('scope')).toBe('mcp:read mcp:write')
  })

  it('uses the RFC 8414 path for authorization issuers with a path, including GitHub', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(oauthChallenge('https://api.githubcopilot.com/.well-known/oauth-protected-resource/mcp'))
      .mockResolvedValueOnce(Response.json({
        resource: 'https://api.githubcopilot.com/mcp',
        authorization_servers: ['https://github.com/login/oauth'],
        scopes_supported: ['repo', 'read:user'],
      }))
      .mockResolvedValueOnce(Response.json({
        issuer: 'https://github.com/login/oauth',
        authorization_endpoint: 'https://github.com/login/oauth/authorize',
        token_endpoint: 'https://github.com/login/oauth/access_token',
        code_challenge_methods_supported: ['S256'],
      }))
    vi.stubGlobal('fetch', fetch)

    const result = await prepareRemoteMcp('https://api.githubcopilot.com/mcp/', 'https://papyrus.example/api/mcp/oauth/callback', 'Papyrus', {
      resolveClient: issuer => issuer === 'https://github.com/login/oauth' ? { clientId: 'github-client', clientSecret: 'github-secret' } : undefined,
    })

    expect(result.kind).toBe('authorization_required')
    expect(String(fetch.mock.calls[2]?.[0])).toBe('https://github.com/.well-known/oauth-authorization-server/login/oauth')
    if (result.kind !== 'authorization_required') return
    expect(result.registration.registrationMethod).toBe('preregistered')
    expect(new URL(result.registration.authorizationUrl).searchParams.get('client_id')).toBe('github-client')
    expect(new URL(result.registration.authorizationUrl).searchParams.has('scope')).toBe(false)
  })

  it('exchanges an authorization code using its verifier and resource indicator', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ access_token: 'access', refresh_token: 'refresh', expires_in: 60 }))
    vi.stubGlobal('fetch', fetch)
    const result = await exchangeMcpCode({ token_endpoint: 'https://auth.example/token', redirect_uri: 'https://papyrus.example/callback', client_id: 'client', verifier: 'verifier', resource: 'https://mcp.example/mcp' }, 'code')
    expect(result.accessToken).toBe('access')
    expect(String(fetch.mock.calls[0]?.[1]?.body)).toContain('code_verifier=verifier')
  })

  it('refreshes an access token without dropping a rotated refresh token', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ access_token: 'next-access', refresh_token: 'next-refresh', expires_in: 120 }))
    vi.stubGlobal('fetch', fetch)
    const result = await refreshMcpToken({
      tokenEndpoint: 'https://auth.example/token',
      clientId: 'client',
      clientSecret: 'secret',
      refreshToken: 'refresh',
      resource: 'https://mcp.example/mcp',
      scope: 'read',
    })
    expect(result.accessToken).toBe('next-access')
    expect(result.refreshToken).toBe('next-refresh')
    const requestBody = String(fetch.mock.calls[0]?.[1]?.body)
    expect(requestBody).toContain('grant_type=refresh_token')
    expect(requestBody).toContain('client_secret=secret')
  })

  it('publishes a CIMD document bound to the Papyrus callback', () => {
    expect(mcpClientMetadata('https://papyrus.example')).toMatchObject({
      client_id: 'https://papyrus.example/.well-known/mcp-client.json',
      redirect_uris: ['https://papyrus.example/api/mcp/oauth/callback'],
      token_endpoint_auth_method: 'none',
    })
  })
})
