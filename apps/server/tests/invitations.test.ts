import { describe, expect, it } from 'vitest'
import { AuthorizationDenied } from '../src/service.js'
import { testContext } from './helpers.js'

describe('audited invitation onboarding', () => {
  it('requires and atomically accepts an identity-bound invitation after bootstrap', () => {
    const ctx = testContext()
    try {
      const owner = ctx.db.upsertUser({ externalId: 'oidc:issuer:owner', displayName: 'Owner', email: 'owner@example.test', authMethod: 'oidc' })
      ctx.db.setRole(owner.id, 'Owner')
      ctx.db.setSetting('bootstrapComplete', 'true')
      const activeOwner = ctx.db.getPrincipal(owner.id)!

      const invitation = ctx.service.createInvitation(activeOwner, {
        email: 'member@example.test', role: 'User', authMethod: 'oidc',
      })
      expect(invitation).toMatchObject({ status: 'pending', role: 'User', authMethod: 'oidc' })
      expect(() => ctx.db.resolveAuthenticatedUser({
        externalId: 'oidc:issuer:wrong', displayName: 'Wrong user', email: 'wrong@example.test', authMethod: 'oidc',
      })).toThrow('INVITATION_REQUIRED')

      const accepted = ctx.db.resolveAuthenticatedUser({
        externalId: 'oidc:issuer:member', displayName: 'Member', email: 'MEMBER@example.test', authMethod: 'oidc',
      })
      expect(accepted.principal.roles).toEqual(['User'])
      expect(accepted.invitation).toMatchObject({ id: invitation.id, status: 'accepted', acceptedBy: accepted.principal.id })
      expect(ctx.db.getInvitation(invitation.id)?.status).toBe('accepted')
      expect(ctx.service.audit.list().some((event) => event.action === 'CreateInvitation' && event.resourceId === invitation.id)).toBe(true)
      expect(ctx.service.audit.verify()).toEqual({ valid: true })
    } finally {
      ctx.dispose()
    }
  })

  it('protects self, Owners, and Admin peers from administrative session actions', () => {
    const ctx = testContext()
    try {
      const owner = ctx.db.upsertUser({ externalId: 'oidc:issuer:owner', displayName: 'Owner', authMethod: 'oidc' })
      ctx.db.setRole(owner.id, 'Owner')
      const admin = ctx.db.upsertUser({ externalId: 'oidc:issuer:admin', displayName: 'Admin', authMethod: 'oidc' })
      ctx.db.setRole(admin.id, 'Admin')
      const activeOwner = ctx.db.getPrincipal(owner.id)!
      const activeAdmin = ctx.db.getPrincipal(admin.id)!

      expect(() => ctx.service.revokeSessions(activeOwner, activeOwner.id)).toThrow(AuthorizationDenied)
      expect(() => ctx.service.revokeSessions(activeAdmin, activeOwner.id)).toThrow(AuthorizationDenied)
      expect(() => ctx.service.assignRole(activeAdmin, activeOwner.id, 'User')).toThrow(AuthorizationDenied)
      expect(() => ctx.service.revokeSessions(activeAdmin, activeAdmin.id)).toThrow(AuthorizationDenied)

      const denied = ctx.service.audit.list().filter((event) => event.decision === 'deny')
      expect(denied.some((event) => event.resourceId === owner.id && event.metadata.reason === 'owner_is_protected')).toBe(true)
      expect(denied.some((event) => event.resourceId === admin.id && event.metadata.reason === 'self_administration_forbidden')).toBe(true)
      expect(ctx.service.audit.verify()).toEqual({ valid: true })
    } finally {
      ctx.dispose()
    }
  })

  it('prevents Admins from inviting privileged roles and audits the denial', () => {
    const ctx = testContext()
    try {
      const admin = ctx.db.upsertUser({ externalId: 'oidc:issuer:admin', displayName: 'Admin', authMethod: 'oidc' })
      ctx.db.setRole(admin.id, 'Admin')
      const activeAdmin = ctx.db.getPrincipal(admin.id)!

      expect(() => ctx.service.createInvitation(activeAdmin, {
        email: 'owner@example.test', role: 'Owner', authMethod: 'oidc',
      })).toThrow(AuthorizationDenied)
      expect(ctx.service.audit.list().some((event) =>
        event.action === 'CreateInvitation' && event.decision === 'deny' && event.metadata.reason === 'privileged_role_requires_owner',
      )).toBe(true)
    } finally {
      ctx.dispose()
    }
  })
})
