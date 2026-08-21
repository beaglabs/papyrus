import { describe, expect, it } from 'vitest'
import type { Principal } from '@papyrus/contracts'
import { ACTIONS, PolicyEngine, cedarUser, cedarUsers, type PolicyAction } from '../src/policy.js'

const principal = (id: string, roles: Principal['roles']): Principal => ({ id, externalId: id, displayName: id, roles, authMethod: 'oidc' })

describe('fixed Cedar policy', () => {
  const policy = new PolicyEngine()

  it('allows an Owner to administer the deployment', () => {
    expect(policy.authorize(principal('owner', ['Owner']), 'ManageUsers', { type: 'Deployment', id: 'd' }).allowed).toBe(true)
  })

  it('allows an assigned User and denies an unassigned User', () => {
    const environment = { type: 'Environment' as const, id: 'w', attrs: { assignedUsers: cedarUsers(['alice']) } }
    expect(policy.authorize(principal('alice', ['User']), 'CreateSession', environment).allowed).toBe(true)
    expect(policy.authorize(principal('mallory', ['User']), 'CreateSession', environment).allowed).toBe(false)
  })

  it('enforces session ownership', () => {
    const session = { type: 'Session' as const, id: 's', attrs: { owner: cedarUser('alice') } }
    expect(policy.authorize(principal('alice', ['User']), 'PromptSession', session).allowed).toBe(true)
    expect(policy.authorize(principal('mallory', ['User']), 'PromptSession', session).allowed).toBe(false)
    expect(policy.authorize(principal('auditor', ['Auditor']), 'ReadSession', session).allowed).toBe(true)
    expect(policy.authorize(principal('auditor', ['Auditor']), 'PromptSession', session).allowed).toBe(false)
  })

  it('enforces the fixed role/action matrix', () => {
    const owner = principal('owner', ['Owner'])
    const admin = principal('admin', ['Admin'])
    const auditor = principal('auditor', ['Auditor'])
    const user = principal('user', ['User'])
    const deployment = { type: 'Deployment' as const, id: 'd' }
    const session = { type: 'Session' as const, id: 's', attrs: { owner: cedarUser('user') } }

    for (const action of ACTIONS) {
      expect(policy.authorize(owner, action, deployment).allowed, `Owner ${action}`).toBe(true)
      expect(policy.authorize(admin, action, deployment).allowed, `Admin ${action}`).toBe(action !== 'ActivateLicense')
      expect(policy.authorize(auditor, action, deployment).allowed, `Auditor ${action}`).toBe(auditorActions.includes(action))
      expect(policy.authorize(user, action, deployment).allowed, `User ${action}`).toBe(false)
    }

    // A User may only operate their own session; an Auditor may read but not execute.
    for (const action of ['ReadSession', 'PromptSession', 'CancelSession', 'CloseSession', 'ResumeSession', 'DecideApproval'] as const) {
      expect(policy.authorize(user, action, session).allowed, `User ${action}`).toBe(true)
      expect(policy.authorize(principal('other', ['User']), action, session).allowed, `Other ${action}`).toBe(false)
    }
    expect(policy.authorize(auditor, 'ReadSession', session).allowed).toBe(true)
    expect(policy.authorize(auditor, 'PromptSession', session).allowed).toBe(false)
    const browser = { type: 'Tool' as const, id: 'chrome:browser', attrs: { assignedUsers: cedarUsers(['user']) } }
    expect(policy.authorize(user, 'BrowserNavigate', browser).allowed).toBe(true)
    expect(policy.authorize(user, 'BrowserRead', browser).allowed).toBe(true)
    for (const action of ['BrowserExecute', 'BrowserDownload', 'BrowserUpload', 'BrowserCredential', 'BrowserSubmit'] as const) {
      expect(policy.authorize(user, action, browser).allowed, `User ${action}`).toBe(false)
    }
  })
})

const auditorActions: PolicyAction[] = ['ReadAudit', 'ReadActivity', 'ReadSession', 'ReadEnvironment']
