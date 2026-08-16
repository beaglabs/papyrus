import { afterEach, describe, expect, it } from 'vitest'
import { AuthorizationDenied } from '../src/service.js'
import { testContext } from './helpers.js'

describe('Papyrus control plane', () => {
  const contexts: ReturnType<typeof testContext>[] = []
  afterEach(() => { while (contexts.length) contexts.pop()?.dispose() })

  it('uses a single-use secret for Owner bootstrap', () => {
    const context = testContext(); contexts.push(context)
    const user = context.db.upsertUser({ externalId: 'dev:alice', displayName: 'Alice', authMethod: 'development' })
    expect(() => context.service.bootstrap(user, 'wrong')).toThrow(/Invalid bootstrap secret/)
    expect(context.service.bootstrap(user, 'correct horse battery staple').roles).toContain('Owner')
    expect(() => context.service.bootstrap(user, 'correct horse battery staple')).toThrow(/already complete/)
  })

  it('requires both workspace and Goose runtime assignment', () => {
    const context = testContext(); contexts.push(context)
    const owner = context.db.upsertUser({ externalId: 'dev:owner', displayName: 'Owner', authMethod: 'development' })
    context.db.setRole(owner.id, 'Owner')
    const activeOwner = context.db.getPrincipal(owner.id)!
    const user = context.db.upsertUser({ externalId: 'dev:user', displayName: 'User', authMethod: 'development' })
    context.db.setRole(user.id, 'User')
    const activeUser = context.db.getPrincipal(user.id)!
    const workspace = context.service.createWorkspace(activeOwner, { name: 'Mission', description: 'Segmented mission work' })
    const runtime = context.service.createRuntime(activeOwner, { name: 'Local Goose', mode: 'child-process', model: { provider: 'openai-compatible', baseUrl: 'http://model.internal/v1', model: 'approved', secretRef: 'primary' } })
    context.service.assign(activeOwner, activeUser.id, 'workspace', workspace.id)
    expect(() => context.service.createSession(activeUser, workspace.id, runtime.id, 'Denied')).toThrow(AuthorizationDenied)
    context.service.assign(activeOwner, activeUser.id, 'runtime', runtime.id)
    const session = context.service.createSession(activeUser, workspace.id, runtime.id, 'Allowed')
    expect(session.ownerId).toBe(activeUser.id)
    expect(context.service.listSessions(activeUser)).toEqual([session])
    expect(context.service.audit.verify()).toEqual({ valid: true })
  })

  it('prevents an Admin from assigning privileged roles', () => {
    const context = testContext(); contexts.push(context)
    const admin = context.db.upsertUser({ externalId: 'dev:admin', displayName: 'Admin', authMethod: 'development' })
    const target = context.db.upsertUser({ externalId: 'dev:target', displayName: 'Target', authMethod: 'development' })
    context.db.setRole(admin.id, 'Admin')
    expect(() => context.service.assignRole(context.db.getPrincipal(admin.id)!, target.id, 'Owner')).toThrow(AuthorizationDenied)
    expect(context.service.assignRole(context.db.getPrincipal(admin.id)!, target.id, 'User').roles).toContain('User')
  })
})
