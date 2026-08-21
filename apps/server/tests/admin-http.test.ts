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
    const workspace = ctx.service.createWorkspace(activeOwner, { name: 'Admin workspace', description: '' })
    ctx.service.assign(activeOwner, activeUser.id, workspace.id)
    const mcp = ctx.service.addMcpServer(activeOwner, { name: 'Browser', endpoint: 'http://127.0.0.1:9999' })
    ctx.service.grantTool(activeOwner, workspace.id, mcp.id, 'browser_read')

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
      expect(overview.workspaces[0]).toMatchObject({ id: workspace.id, assignedUserIds: expect.arrayContaining([activeOwner.id, activeUser.id]) })
      expect(overview.toolGrants[0]).toMatchObject({ workspaceId: workspace.id, mcpServerId: mcp.id, toolName: 'browser_read' })
      expect(overview.runtimeProfiles.map((profile) => profile.id)).toEqual(['goose', 'opencode'])
      expect(JSON.stringify(overview)).not.toContain(ctx.config.sessionSecret)
      expect(JSON.stringify(overview)).not.toContain(ctx.config.bootstrapSecret)

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
