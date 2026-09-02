import { describe, expect, it } from 'vitest'
import { hasAppRole, principalFromClaims } from '../src/cyber/entra-auth.js'

describe('Entra-native portal identity', () => {
  it('maps only declared Entra application roles and never provisions local roles', () => {
    const principal = principalFromClaims({
      oid: '11111111-1111-1111-1111-111111111111',
      tid: '22222222-2222-2222-2222-222222222222',
      name: 'Cyber Analyst',
      preferred_username: 'analyst@example.mil',
      roles: ['Papyrus.Integration.View', 'Unrelated.Role'],
      groups: ['group-1'],
    }, 'teams-sso')
    expect(principal).toEqual({
      oid: '11111111-1111-1111-1111-111111111111', tenantId: '22222222-2222-2222-2222-222222222222',
      displayName: 'Cyber Analyst', preferredUsername: 'analyst@example.mil', roles: ['Papyrus.Integration.View'],
      groups: ['group-1'], source: 'teams-sso',
    })
    expect(hasAppRole(principal, 'Papyrus.Integration.Manage')).toBe(false)
  })

  it('treats the Entra system owner app role as all portal permissions', () => {
    const principal = principalFromClaims({ oid: 'owner', tid: 'tenant', roles: ['Papyrus.System.Owner'] }, 'entra')
    expect(hasAppRole(principal, 'Papyrus.Security.Manage')).toBe(true)
    expect(hasAppRole(principal, 'Papyrus.Audit.View')).toBe(true)
  })
})
