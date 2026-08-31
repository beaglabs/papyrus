import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import type { AdminOverview } from '@papyrus/contracts'
import { describe, expect, it } from 'vitest'
import { createPapyrusServer } from '../src/http.js'
import { testContext } from './helpers.js'

describe('deployment administration HTTP API', () => {
  it('returns a secret-free overview and applies governed tool control changes', async () => {
    const ctx = testContext()
    const owner = ctx.db.upsertUser({ externalId: 'oidc:admin-owner', displayName: 'Owner', authMethod: 'oidc' })
    ctx.db.setRole(owner.id, 'Owner')
    const activeOwner = ctx.db.getPrincipal(owner.id)!
    const user = ctx.db.upsertUser({ externalId: 'oidc:admin-user', displayName: 'User', authMethod: 'oidc' })
    ctx.db.setRole(user.id, 'User')
    const activeUser = ctx.db.getPrincipal(user.id)!
    const environment = ctx.service.createEnvironment(activeOwner, { name: 'Admin environment', description: '' })
    ctx.service.assign(activeOwner, activeUser.id, environment.id)
    const mcp = ctx.db.addMcpServer({ name: 'Browser', endpoint: 'http://127.0.0.1:9999', oauthStatus: 'not_required' })
    ctx.service.grantMcpServer(activeOwner, environment.id, mcp.id)

    const server = createPapyrusServer(ctx.config, ctx.service, ctx.auth)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const request = (token: string, path: string, init: RequestInit = {}) => fetch(`${origin}${path}`, {
      ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...init.headers },
    })
    const ownerToken = ctx.auth.issueSession(activeOwner.id)
    const userToken = ctx.auth.issueSession(activeUser.id)

    try {
      expect((await request(userToken, '/api/admin/overview')).status).toBe(403)
      const response = await request(ownerToken, '/api/admin/overview')
      expect(response.status).toBe(200)
      const overview = await response.json() as AdminOverview
      expect(overview.environments[0]).toMatchObject({ id: environment.id, assignedUserIds: expect.arrayContaining([activeOwner.id, activeUser.id]) })
      expect(overview.toolGrants[0]).toMatchObject({ environmentId: environment.id, mcpServerId: mcp.id })
      expect(JSON.stringify(overview)).not.toContain(ctx.config.sessionSecret)
      expect(JSON.stringify(overview)).not.toContain(ctx.config.bootstrapSecret)

      const invalidAssignment = await request(ownerToken, '/api/assignments', {
        method: 'POST', body: JSON.stringify({ principalId: 'null', environmentId: environment.id }),
      })
      expect(invalidAssignment.status).toBe(400)
      expect(await invalidAssignment.json()).toMatchObject({ code: 'INVALID_INPUT' })
      expect(ctx.db.assignedUserIds('environment', environment.id)).not.toContain('null')

      const disabled = await request(ownerToken, `/api/mcp/servers/${mcp.id}/state`, { method: 'POST', body: JSON.stringify({ enabled: false }) })
      expect(await disabled.json()).toMatchObject({ id: mcp.id, enabled: false })
      const revoked = await request(ownerToken, `/api/mcp/grants/${overview.toolGrants[0]!.id}`, { method: 'DELETE' })
      expect(revoked.status).toBe(204)
      expect(ctx.db.listToolGrants()).toEqual([])
      expect(ctx.service.audit.verify()).toEqual({ valid: true })
    } finally {
      server.close()
      await once(server, 'close')
      ctx.dispose()
    }
  })
  it('returns OAuth denial callbacks to the opener and records the connection error', async () => {
    const ctx = testContext()
    const owner = ctx.db.upsertUser({ externalId: 'oidc:oauth-denial-owner', displayName: 'Owner', authMethod: 'oidc' })
    ctx.db.setRole(owner.id, 'Owner')
    const activeOwner = ctx.db.getPrincipal(owner.id)!
    const mcp = ctx.db.addMcpServer({
      name: 'Denied MCP',
      endpoint: 'https://mcp.example/mcp',
      oauthStatus: 'authorization_required',
      oauthIssuer: 'https://auth.example',
      oauthRegistrationMethod: 'preregistered',
    })
    ctx.db.createMcpOauthPending({
      state: 'denied-state',
      serverId: mcp.id,
      actorId: activeOwner.id,
      issuer: 'https://auth.example',
      tokenEndpoint: 'https://auth.example/token',
      clientId: 'client',
      verifier: 'sealed-verifier',
      redirectUri: `${ctx.config.publicOrigin}/api/mcp/oauth/callback`,
      resource: mcp.endpoint,
      registrationMethod: 'preregistered',
    })

    const server = createPapyrusServer(ctx.config, ctx.service, ctx.auth)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const token = ctx.auth.issueSession(activeOwner.id)

    try {
      const response = await fetch(`${origin}/api/mcp/oauth/callback?state=denied-state&error=access_denied&error_description=Nope&iss=${encodeURIComponent('https://auth.example')}`, {
        headers: { authorization: `Bearer ${token}` },
      })
      expect(response.status).toBe(200)
      const html = await response.text()
      expect(html).toContain('papyrus:mcp-oauth-error')
      expect(html).toContain('access_denied')
      expect(ctx.db.getMcpOauthPending('denied-state')).toBeUndefined()
      expect(ctx.db.getMcpServer(mcp.id)).toMatchObject({
        enabled: false,
        oauthStatus: 'error',
        oauthError: 'access_denied: Nope',
      })
    } finally {
      server.close()
      await once(server, 'close')
      ctx.dispose()
    }
  })

  it('publishes MCP client metadata and keeps configured OAuth client secrets out of the admin API', async () => {
    const ctx = testContext()
    const owner = ctx.db.upsertUser({ externalId: 'oidc:oauth-owner', displayName: 'Owner', authMethod: 'oidc' })
    ctx.db.setRole(owner.id, 'Owner')
    const activeOwner = ctx.db.getPrincipal(owner.id)!
    const server = createPapyrusServer(ctx.config, ctx.service, ctx.auth)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const ownerToken = ctx.auth.issueSession(activeOwner.id)
    const request = (path: string, init: RequestInit = {}) => fetch(`${origin}${path}`, {
      ...init, headers: { authorization: `Bearer ${ownerToken}`, 'content-type': 'application/json', ...init.headers },
    })

    try {
      const metadata = await fetch(`${origin}/.well-known/mcp-client.json`)
      expect(metadata.status).toBe(200)
      expect(await metadata.json()).toMatchObject({
        client_id: `${ctx.config.publicOrigin}/.well-known/mcp-client.json`,
        redirect_uris: [`${ctx.config.publicOrigin}/api/mcp/oauth/callback`],
      })

      const configured = await request('/api/mcp/oauth/clients', {
        method: 'PUT',
        body: JSON.stringify({
          issuer: 'https://github.com/login/oauth',
          clientId: 'papyrus-github-client',
          clientSecret: 'super-secret-client-value',
          scopes: 'read:user user:email',
        }),
      })
      expect(configured.status).toBe(200)
      expect(await configured.json()).toMatchObject({
        issuer: 'https://github.com/login/oauth',
        clientId: 'papyrus-github-client',
        hasClientSecret: true,
        scopes: 'read:user user:email',
      })

      const overviewResponse = await request('/api/admin/overview')
      const overview = await overviewResponse.json() as AdminOverview
      expect(overview.mcpOauthClients).toEqual([expect.objectContaining({
        issuer: 'https://github.com/login/oauth',
        clientId: 'papyrus-github-client',
        hasClientSecret: true,
      })])
      expect(JSON.stringify(overview)).not.toContain('super-secret-client-value')
      expect(ctx.db.mcpOauthClientCredentials('https://github.com/login/oauth')?.clientSecret).not.toBe('super-secret-client-value')

      const removed = await request(`/api/mcp/oauth/clients/${encodeURIComponent('https://github.com/login/oauth')}`, { method: 'DELETE' })
      expect(removed.status).toBe(204)
      expect(ctx.db.listMcpOauthClients()).toEqual([])
    } finally {
      server.close()
      await once(server, 'close')
      ctx.dispose()
    }
  })

})
