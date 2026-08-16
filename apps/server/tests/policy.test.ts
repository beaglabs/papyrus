import { describe, expect, it } from 'vitest'
import type { Principal } from '@papyrus/contracts'
import { PolicyEngine, cedarUser, cedarUsers } from '../src/policy.js'

const principal = (id: string, roles: Principal['roles']): Principal => ({ id, externalId: id, displayName: id, roles, authMethod: 'development' })

describe('fixed Cedar policy', () => {
  const policy = new PolicyEngine()

  it('allows an Owner to administer the deployment', () => {
    expect(policy.authorize(principal('owner', ['Owner']), 'ManageUsers', { type: 'Deployment', id: 'd' }).allowed).toBe(true)
  })

  it('allows an assigned User and denies an unassigned User', () => {
    const workspace = { type: 'Workspace' as const, id: 'w', attrs: { assignedUsers: cedarUsers(['alice']) } }
    expect(policy.authorize(principal('alice', ['User']), 'CreateSession', workspace).allowed).toBe(true)
    expect(policy.authorize(principal('mallory', ['User']), 'CreateSession', workspace).allowed).toBe(false)
  })

  it('enforces session ownership', () => {
    const session = { type: 'Session' as const, id: 's', attrs: { owner: cedarUser('alice') } }
    expect(policy.authorize(principal('alice', ['User']), 'PromptSession', session).allowed).toBe(true)
    expect(policy.authorize(principal('mallory', ['User']), 'PromptSession', session).allowed).toBe(false)
    expect(policy.authorize(principal('auditor', ['Auditor']), 'ReadSession', session).allowed).toBe(true)
    expect(policy.authorize(principal('auditor', ['Auditor']), 'PromptSession', session).allowed).toBe(false)
  })
})
