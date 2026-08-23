import { afterEach, describe, expect, it, vi } from 'vitest'
import { exchangeMcpCode, normalizeMcpEndpoint, registerRemoteMcp } from '../src/mcp-oauth.js'

afterEach(() => vi.unstubAllGlobals())

describe('remote MCP OAuth 2.1 registration', () => {
  it('normalizes Atlassian legacy MCP URLs to the OAuth-capable endpoint', () => {
    expect(normalizeMcpEndpoint('https://mcp.atlassian.com/v1/mcp')).toBe('https://mcp.atlassian.com/v1/mcp/authv2')
    expect(normalizeMcpEndpoint('https://mcp.example/mcp')).toBe('https://mcp.example/mcp')
  })

  it('discovers metadata, dynamically registers, and creates a PKCE authorization request', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 401, headers: { 'www-authenticate': 'Bearer resource_metadata="https://mcp.example/.well-known/oauth-protected-resource/mcp"' } }))
      .mockResolvedValueOnce(Response.json({ resource: 'https://mcp.example/mcp', authorization_servers: ['https://auth.example'], scopes_supported: ['mcp:tools'] }))
      .mockResolvedValueOnce(Response.json({ issuer: 'https://auth.example', authorization_endpoint: 'https://auth.example/authorize', token_endpoint: 'https://auth.example/token', registration_endpoint: 'https://auth.example/register', code_challenge_methods_supported: ['S256'] }))
      .mockResolvedValueOnce(Response.json({ client_id: 'papyrus-client' }))
    vi.stubGlobal('fetch', fetch)
    const result = await registerRemoteMcp('https://mcp.example/mcp', 'https://papyrus.example/api/mcp/oauth/callback', 'Papyrus')
    expect(result?.clientId).toBe('papyrus-client')
    const authorization = new URL(result!.authorizationUrl)
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorization.searchParams.get('resource')).toBe('https://mcp.example/mcp')
    expect(fetch.mock.calls[3]?.[1]?.body).toContain('authorization_code')
  })

  it('exchanges the authorization code using its verifier and resource indicator', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ access_token: 'access', refresh_token: 'refresh', expires_in: 60 }))
    vi.stubGlobal('fetch', fetch)
    const result = await exchangeMcpCode({ token_endpoint: 'https://auth.example/token', redirect_uri: 'https://papyrus.example/callback', client_id: 'client', verifier: 'verifier', resource: 'https://mcp.example/mcp' }, 'code')
    expect(result.accessToken).toBe('access')
    expect(String(fetch.mock.calls[0]?.[1]?.body)).toContain('code_verifier=verifier')
  })
})
