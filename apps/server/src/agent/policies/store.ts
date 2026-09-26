import { randomUUID, createHash } from 'node:crypto'
import { POLICY_SCOPES, type NamedPolicy, type PolicyAttachment, type PortalPrincipal } from '@papyrus/contracts'
import { canonical, type AgentDatabase } from '../database.js'
import { evaluatePolicies, isStrengthening, validateRules } from './evaluator.js'
export class PolicyError extends Error { constructor(readonly code: string, message: string, readonly status = 403) { super(message) } }
export function requireGovernance(actor: PortalPrincipal): void {
  if (!actor.roles.includes('Papyrus.System.Owner') && !(actor.roles.includes('Papyrus.Security.Manage') && actor.roles.includes('Papyrus.Action.Approve'))) throw new PolicyError('GOVERNANCE_REQUIRED', 'Security management and action approval are required')
}
export function hash(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex') }
export class PolicyStore {
  constructor(readonly db: AgentDatabase) {
    db.sqlite.exec(`CREATE TABLE IF NOT EXISTS named_policies(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,version INTEGER NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS policy_history(id TEXT NOT NULL,version INTEGER NOT NULL,body TEXT NOT NULL,actor TEXT NOT NULL,PRIMARY KEY(id,version));
      CREATE TABLE IF NOT EXISTS governed_changes(id TEXT PRIMARY KEY,kind TEXT NOT NULL,resource_id TEXT NOT NULL,expected_version INTEGER NOT NULL,body TEXT NOT NULL,digest TEXT NOT NULL,requested_by TEXT NOT NULL,approved_by TEXT,state TEXT NOT NULL DEFAULT 'pending',created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS policy_decisions(id TEXT PRIMARY KEY,context TEXT NOT NULL,decision TEXT NOT NULL,created_at TEXT NOT NULL);`)
  }
  list(): NamedPolicy[] { return (this.db.sqlite.prepare('SELECT body FROM named_policies ORDER BY name').all() as {body:string}[]).map(r => JSON.parse(r.body) as NamedPolicy) }
  get(id: string): NamedPolicy { const row = this.db.sqlite.prepare('SELECT body FROM named_policies WHERE id=?').get(id) as {body:string}|undefined; if (!row) throw new PolicyError('POLICY_NOT_FOUND', 'Policy not found', 404); return JSON.parse(row.body) as NamedPolicy }
  create(name: string, rules: unknown, attachments: PolicyAttachment[], actor: string): NamedPolicy {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9 _.-]{0,119}$/.test(name)) throw new PolicyError('INVALID_POLICY_NAME', 'Invalid policy name', 400)
    const policy: NamedPolicy = { id: randomUUID(), name, rules: validateRules(rules), attachments: this.attachments(attachments), version: 1, createdBy: actor }
    this.db.sqlite.transaction(() => { this.db.sqlite.prepare('INSERT INTO named_policies VALUES(?,?,?,?)').run(policy.id, name, 1, JSON.stringify(policy)); this.history(policy, actor) })()
    return policy
  }
  update(id: string, expected: number, rules: unknown, attachments: PolicyAttachment[], actor: string): NamedPolicy | { changeId: string } {
    const old = this.get(id)
    if (old.version !== expected) throw new PolicyError('STALE_POLICY', 'Policy changed; reload before editing', 409)
    const next = { ...old, rules: validateRules(rules), attachments: this.attachments(attachments), version: expected + 1 }
    if (!isStrengthening(old.rules, next.rules) || !old.attachments.every(a => next.attachments.some(b => a.scope === b.scope && a.resourceId === b.resourceId))) return { changeId: this.propose('policy', id, expected, next, actor) }
    this.save(next, expected, actor)
    return next
  }
  propose(kind: 'policy' | 'app-grant' | 'app-publish', resourceId: string, expected: number, body: unknown, actor: string): string {
    const id = randomUUID()
    this.db.sqlite.prepare('INSERT INTO governed_changes(id,kind,resource_id,expected_version,body,digest,requested_by,created_at) VALUES(?,?,?,?,?,?,?,?)').run(id,kind,resourceId,expected,JSON.stringify(body),hash(body),actor,new Date().toISOString())
    return id
  }
  changes(): Record<string,unknown>[] { return this.db.sqlite.prepare('SELECT * FROM governed_changes ORDER BY created_at DESC').all() as Record<string,unknown>[] }
  approve(id: string, actor: PortalPrincipal, apply?: (kind:string, resource:string, expected:number, body:unknown) => void): void {
    requireGovernance(actor)
    this.db.sqlite.transaction(() => {
      const row = this.db.sqlite.prepare('SELECT * FROM governed_changes WHERE id=?').get(id) as Record<string,unknown>|undefined
      if (!row || row.state !== 'pending') throw new PolicyError('CHANGE_NOT_PENDING','Change is not pending',409)
      const value: unknown = JSON.parse(String(row.body))
      if (hash(value) !== row.digest) throw new PolicyError('CHANGE_TAMPERED','Change digest does not match')
      if (row.kind === 'policy') this.save(value as NamedPolicy, Number(row.expected_version),actor.oid)
      else { if (!apply) throw new PolicyError('UNSUPPORTED_CHANGE','Change executor unavailable'); apply(String(row.kind),String(row.resource_id),Number(row.expected_version),value) }
      this.db.sqlite.prepare("UPDATE governed_changes SET state='approved',approved_by=? WHERE id=?").run(actor.oid,id)
    })()
  }
  assert(context: Record<string,unknown>, options: { approved?: boolean; proposing?: boolean } = {}): void {
    const scopeFields: Record<string,string> = {app:'appId',session:'sessionId',connector:'connectorId',executor:'executorId',skill:'skillId',agent:'agentId',model:'modelId',link:'linkId'}
    const matched = this.list().filter(p => p.attachments.some(a => a.scope === 'workspace' || context[scopeFields[a.scope] ?? ''] === a.resourceId))
    const decision = evaluatePolicies(matched.flatMap(p => p.rules), context)
    if (!decision.allowed || decision.approvalRequired && !options.approved && !options.proposing) {
      this.db.sqlite.prepare('INSERT INTO policy_decisions VALUES(?,?,?,?)').run(randomUUID(), JSON.stringify({operation:context.operation, policies:matched.map(p => ({id:p.id,version:p.version}))}),JSON.stringify(decision),new Date().toISOString())
      throw new PolicyError('POLICY_DENIED', decision.reasons.join(', ') || 'Governance approval required')
    }
  }
  private attachments(value: PolicyAttachment[]): PolicyAttachment[] {
    if (!Array.isArray(value) || value.length > 128 || value.some(a => !POLICY_SCOPES.includes(a.scope) || typeof a.resourceId !== 'string' || !a.resourceId || a.resourceId.length > 256 || a.scope === 'workspace' && a.resourceId !== '*')) throw new PolicyError('INVALID_ATTACHMENT','Invalid policy attachment',400)
    return value.map(a => ({scope:a.scope,resourceId:a.resourceId}))
  }
  private save(policy: NamedPolicy, expected:number, actor:string): void {
    this.db.sqlite.transaction(() => { const r=this.db.sqlite.prepare('UPDATE named_policies SET body=?,version=? WHERE id=? AND version=?').run(JSON.stringify(policy),policy.version,policy.id,expected); if (!r.changes) throw new PolicyError('STALE_POLICY','Policy changed; approval is stale',409); this.history(policy,actor) })()
  }
  private history(policy:NamedPolicy,actor:string): void { this.db.sqlite.prepare('INSERT INTO policy_history VALUES(?,?,?,?)').run(policy.id,policy.version,JSON.stringify(policy),actor) }
}
