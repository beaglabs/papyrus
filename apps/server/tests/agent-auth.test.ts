import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import type { AgentConfig } from '../src/agent/config.js'
import { EntraAuthService, hasAppRole, principalFromClaims } from '../src/agent/entra-auth.js'

describe('Entra-native portal identity', () => {
  it('maps only declared Entra application roles and never provisions local roles', () => {
    const principal = principalFromClaims({
      oid: '11111111-1111-1111-1111-111111111111',
      tid: '22222222-2222-2222-2222-222222222222',
      name: 'Agent Analyst',
      preferred_username: 'analyst@example.mil',
      roles: ['Papyrus.Integration.View', 'Unrelated.Role'],
      groups: ['group-1'],
    }, 'teams-sso')
    expect(principal).toEqual({
      oid: '11111111-1111-1111-1111-111111111111', tenantId: '22222222-2222-2222-2222-222222222222',
      displayName: 'Agent Analyst', preferredUsername: 'analyst@example.mil', roles: ['Papyrus.Integration.View'],
      groups: ['group-1'], source: 'teams-sso',
    })
    expect(hasAppRole(principal, 'Papyrus.Integration.Manage')).toBe(false)
  })

  it('treats the Entra system owner app role as all portal permissions', () => {
    const principal = principalFromClaims({ oid: 'owner', tid: 'tenant', roles: ['Papyrus.System.Owner'] }, 'entra')
    expect(hasAppRole(principal, 'Papyrus.Security.Manage')).toBe(true)
    expect(hasAppRole(principal, 'Papyrus.Audit.View')).toBe(true)
  })

  it('issues expiring ingestion tokens bound to one integration route', () => {
    const config: AgentConfig = {
      mode: 'local', profile: 'gcc', host: 'localhost', port: 3210, publicOrigin: 'http://localhost:3210',
      dataDir: '/tmp/papyrus-auth-test', databasePath: ':memory:', portalSecret: 'portal-secret-at-least-thirty-two-characters',
      organizationName: 'Example Agency', cloud: 'Public', licenseRequired: false, licenseAuthorities: {},
    }
    const auth = new EntraAuthService(config)
    const issued = auth.issueIngestionToken('source-1', 'owner')
    const request = { headers: { authorization: `Bearer ${issued.token}` } } as IncomingMessage
    expect(issued.token).toMatch(/^pap_ing_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
    expect(auth.verifyIngestionRequest(request, 'source-1')).toBe(true)
    expect(() => auth.verifyIngestionRequest(request, 'source-2')).toThrow(/not valid for this source/)

    const expired = auth.issueIngestionToken('source-1', 'owner', -1)
    expect(() => auth.verifyIngestionRequest({ headers: { authorization: `Bearer ${expired.token}` } } as IncomingMessage, 'source-1')).toThrow(/expired/)
    expect(auth.verifyIngestionRequest({ headers: {} } as IncomingMessage, 'source-1')).toBe(false)
  })
})
