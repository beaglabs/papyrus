import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { EntraAppRole, PortalPrincipal } from '@papyrus/contracts'
import { AccessView } from './Access.js'

function principal(roles: EntraAppRole[]): PortalPrincipal {
  return { oid: 'oid-1', tenantId: 'tenant-1', displayName: 'K. Ramos', preferredUsername: 'k.ramos@example.mil', roles, groups: [], source: 'entra' }
}

/** Which capabilities the page marked as held, in render order. */
function rowFor(html: string, capability: string): string {
  const row = [...html.matchAll(/<li data-granted="(true|false)"[^>]*>([\s\S]*?)<\/li>/g)]
    .find((match) => match[2]!.includes(capability))
  if (!row) throw new Error(`no row rendered for ${capability}`)
  return row[1]!
}

describe('Access page', () => {
  it('grants a capability only through the roles the server accepts for it', () => {
    const html = renderToStaticMarkup(<AccessView me={principal(['Papyrus.Integration.View'])} />)
    expect(rowFor(html, 'Read the Terrain snapshot')).toBe('true')
    expect(rowFor(html, 'Approve or deny a proposed action')).toBe('false')
    expect(rowFor(html, 'Activate a high-risk or action-capable connector')).toBe('false')
    expect(html).toContain('needs Action.Approve')
  })

  it('treats System.Owner as implied for every capability, matching hasAppRole', () => {
    const html = renderToStaticMarkup(<AccessView me={principal(['Papyrus.System.Owner'])} />)
    expect(html).not.toContain('data-granted="false"')
    expect(html).toContain('12 of 12')
  })

  it('shows the role reference and marks the roles the operator holds', () => {
    const html = renderToStaticMarkup(<AccessView me={principal(['Papyrus.Audit.View'])} />)
    expect(html).toContain('Papyrus.Integration.Manage')
    expect(html).toContain('Papyrus.System.Owner')
    // Exactly one role is held, so exactly one badge.
    expect([...html.matchAll(/access-held/g)]).toHaveLength(1)
  })

  it('says so when no role is assigned instead of implying access', () => {
    const html = renderToStaticMarkup(<AccessView me={principal([])} />)
    expect(html).toContain('NO ROLES ASSIGNED')
    expect(html).toContain('0 of 12')
  })

  it('offers nothing that could change an assignment', () => {
    const html = renderToStaticMarkup(<AccessView me={principal(['Papyrus.System.Owner'])} />)
    expect(html).not.toMatch(/<button|<input|<select|<form/i)
  })
})
