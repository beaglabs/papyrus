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
})
