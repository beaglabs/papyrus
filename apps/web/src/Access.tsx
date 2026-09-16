import type { EntraAppRole, PortalPrincipal } from '@papyrus/contracts'
import { Badge, Card } from './components/ui/index.js'

/**
 * Who can do what — read-only, and deliberately so.
 *
 * Papyrus holds no user list and cannot change an assignment: identity and application roles
 * belong to the customer's Entra tenant, and `docs/security.md` states that there is no local
 * user database, invitation flow, or Papyrus role assignment. This page therefore reads the
 * roles already present on the operator's token and explains them. It never writes, and there
 * is no control here that could disagree with the tenant.
 */

/**
 * Mirrors `hasAppRole` in `apps/server/src/agent/entra-auth.ts`, where Papyrus.System.Owner
 * satisfies every role check. The server remains the authority — this decides what to show,
 * never what is allowed.
 */
function holds(principal: PortalPrincipal, roles: readonly EntraAppRole[]): boolean {
  return principal.roles.includes('Papyrus.System.Owner') || roles.some((role) => principal.roles.includes(role))
}

/** Every server-side role check, grouped by what it actually gates. */
const CAPABILITIES: Array<{ capability: string; roles: EntraAppRole[] }> = [
  { capability: 'Read the Terrain snapshot and connector sync history', roles: ['Papyrus.Integration.View'] },
  { capability: 'Create, test, and submit an ordinary connector', roles: ['Papyrus.Integration.Manage'] },
  { capability: 'Mint an ingestion token and publish observations', roles: ['Papyrus.Integration.Manage'] },
  { capability: 'Configure model gateways and run workflows', roles: ['Papyrus.Integration.Manage'] },
  { capability: 'Propose a consequential action to the ledger', roles: ['Papyrus.Integration.Manage'] },
  { capability: 'Activate a high-risk or action-capable connector', roles: ['Papyrus.Security.Manage'] },
  { capability: 'Disable or delete an action-capable connector', roles: ['Papyrus.Security.Manage'] },
  { capability: 'Read connector audit events', roles: ['Papyrus.Audit.View'] },
  { capability: 'Read agent traces and daemon logs', roles: ['Papyrus.Audit.View', 'Papyrus.Security.Manage'] },
  { capability: 'Approve or deny a proposed action', roles: ['Papyrus.Action.Approve'] },
  { capability: 'Approve a drafted skill', roles: ['Papyrus.System.Owner'] },
  { capability: 'Activate the deployment licence', roles: ['Papyrus.System.Owner'] },
]

/** What each assigned role is for, so an operator knows what to request. */
const ROLE_PURPOSE: Record<EntraAppRole, string> = {
  'Papyrus.Integration.View': 'Read-only visibility of connectors, sync history, and Terrain. Cannot change configuration or release anything.',
  'Papyrus.Integration.Manage': 'Runs the connector lifecycle and proposes actions. Authority over configuration, not over release.',
  'Papyrus.Security.Manage': 'Holds the boundary for connectors that carry action authority or material risk, and reads traces and logs.',
  'Papyrus.Action.Approve': 'Releases an approved proposal to the leased executor. This is the human authority in the action path.',
  'Papyrus.Audit.View': 'Reads audit events, traces, and logs. Grants no ability to change state.',
  'Papyrus.System.Owner': 'Implies every permission above, plus skill approval and licence activation.',
}

export function AccessView({ me }: { me: PortalPrincipal }) {
  const granted = CAPABILITIES.filter((entry) => holds(me, entry.roles))
  const withheld = CAPABILITIES.filter((entry) => !holds(me, entry.roles))

  return <div className="access-view">
    <div className="surface-intro">
      <div>
        <p className="eyebrow">IDENTITY AND ENTITLEMENTS</p>
        <h2>Access</h2>
        <p>What your Microsoft Entra roles allow in this deployment. Papyrus holds no user list and cannot amend an assignment — this page reads your token and explains it.</p>
      </div>
    </div>

    <div className="access-grid">
      <Card>
        <p className="eyebrow">SIGNED IN AS</p>
        <h2>{me.displayName}</h2>
        <p>{me.preferredUsername ?? me.oid}</p>
        <div className="role-list">{me.roles.length ? me.roles.map((role) => <Badge key={role}>{role.replace('Papyrus.', '')}</Badge>) : <Badge>NO ROLES ASSIGNED</Badge>}</div>
        <dl className="facts">
          <div><dt>Identity authority</dt><dd>MICROSOFT ENTRA ID</dd></div>
          <div><dt>Session source</dt><dd>{me.source === 'development' ? 'LOCAL DEVELOPMENT PRINCIPAL' : 'ENTRA TOKEN'}</dd></div>
          <div><dt>Entra groups</dt><dd>{me.groups.length ? String(me.groups.length) : 'NONE REPORTED'}</dd></div>
        </dl>
      </Card>

      <Card>
        <p className="eyebrow">REVOCATION</p>
        <h2>Authority ends with the assignment</h2>
        <p>Removing a role in the tenant removes authority here once the Microsoft token and the short-lived portal cookie expire. There is no local override to forget to remove, and no Papyrus role a tenant administrator would have to reconcile.</p>
        <p>To change what you can do, change it in Entra. Nothing on this page can.</p>
      </Card>
    </div>

    <Card className="access-capability-card">
      <div className="panel-head"><h2>Your capabilities</h2><span className="access-count">{granted.length} of {CAPABILITIES.length}</span></div>
      <ul className="access-capabilities">
        {[...granted, ...withheld].map((entry) => <li key={entry.capability} data-granted={holds(me, entry.roles)}>
          <span className="access-mark" aria-hidden="true">{holds(me, entry.roles) ? '✓' : '·'}</span>
          <span className="access-capability">{entry.capability}</span>
          <span className="access-source">{holds(me, entry.roles) ? entry.roles.map((role) => role.replace('Papyrus.', '')).join(' or ') : `needs ${entry.roles.map((role) => role.replace('Papyrus.', '')).join(' or ')}`}</span>
        </li>)}
      </ul>
    </Card>

    <Card className="access-matrix-card">
      <div className="panel-head"><h2>Role reference</h2></div>
      <table className="access-table">
        <thead><tr><th>Role</th><th>Purpose</th></tr></thead>
        <tbody>
          {(Object.keys(ROLE_PURPOSE) as EntraAppRole[]).map((role) => <tr key={role} data-held={me.roles.includes(role)}>
            <td><code>{role}</code>{me.roles.includes(role) && <Badge className="access-held">HELD</Badge>}</td>
            <td>{ROLE_PURPOSE[role]}</td>
          </tr>)}
        </tbody>
      </table>
    </Card>
  </div>
}
