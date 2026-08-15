import { randomUUID } from 'node:crypto'
import { getDb } from './database.js'

export type ConnectionState =
  | 'draft'
  | 'validating'
  | 'active'
  | 'degraded'
  | 'disabled'
  | 'authorization-expired'
export interface CapeConnection {
  id: string
  name: string
  systemKey: string
  adapterKind: string
  lifecycleState: ConnectionState
  mode: 'simulated' | 'authorized'
  credentialRef?: string
  scope: Record<string, unknown>
  mapping: Record<string, unknown>
  approvalPolicy: string
  lastTestAt?: string
  lastTestStatus?: string
}
function map(row: Record<string, unknown>): CapeConnection {
  return {
    id: String(row.id),
    name: String(row.name),
    systemKey: String(row.system_key),
    adapterKind: String(row.adapter_kind),
    lifecycleState: row.lifecycle_state as ConnectionState,
    mode: row.mode as 'simulated' | 'authorized',
    credentialRef: row.credential_ref ? String(row.credential_ref) : undefined,
    scope: JSON.parse(String(row.scope_json)),
    mapping: JSON.parse(String(row.mapping_json)),
    approvalPolicy: String(row.approval_policy),
    lastTestAt: row.last_test_at ? String(row.last_test_at) : undefined,
    lastTestStatus: row.last_test_status ? String(row.last_test_status) : undefined,
  }
}
export function listCapeConnections(organizationId: string): CapeConnection[] {
  return (
    getDb()
      .prepare('SELECT * FROM cape_connections WHERE organization_id=? ORDER BY name')
      .all(organizationId) as Record<string, unknown>[]
  ).map(map)
}
export function saveCapeConnection(
  organizationId: string,
  actor: string,
  input: Partial<CapeConnection>,
): CapeConnection {
  const now = new Date().toISOString()
  const id = input.id ?? `connection-${randomUUID()}`
  const systemKey = String(input.systemKey ?? 'generic-file').toLowerCase()
  const mode: 'simulated' | 'authorized' = input.mode === 'authorized' ? 'authorized' : 'simulated'
  if (mode === 'authorized' && ['dai', 'dcpds', 'icompass', 'diss'].includes(systemKey))
    throw new Error(
      'Government authorization evidence is required before enabling a live CAPE adapter',
    )
  getDb()
    .prepare(`INSERT INTO cape_connections
    (id,organization_id,name,system_key,adapter_kind,lifecycle_state,mode,credential_ref,scope_json,mapping_json,schedule_json,approval_policy,created_by,created_at,updated_at)
    VALUES (?,?,?,?,?,'draft',?,?,?,?,?,'protected-writes',?,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,adapter_kind=excluded.adapter_kind,credential_ref=excluded.credential_ref,
    scope_json=excluded.scope_json,mapping_json=excluded.mapping_json,updated_at=excluded.updated_at`)
    .run(
      id,
      organizationId,
      String(input.name ?? systemKey.toUpperCase()),
      systemKey,
      String(input.adapterKind ?? 'api'),
      mode,
      input.credentialRef ?? null,
      JSON.stringify(input.scope ?? {}),
      JSON.stringify(input.mapping ?? {}),
      JSON.stringify({}),
      actor,
      now,
      now,
    )
  return map(
    getDb()
      .prepare('SELECT * FROM cape_connections WHERE id=? AND organization_id=?')
      .get(id, organizationId) as Record<string, unknown>,
  )
}
export function testCapeConnection(organizationId: string, id: string): CapeConnection {
  const now = new Date().toISOString()
  const changed = getDb()
    .prepare(
      `UPDATE cape_connections SET lifecycle_state='active',last_test_at=?,last_test_status='simulated fixture reachable',updated_at=? WHERE id=? AND organization_id=? AND mode='simulated'`,
    )
    .run(now, now, id, organizationId)
  if (!changed.changes)
    throw new Error('Connection not found or requires an authorized adapter test')
  return map(
    getDb().prepare('SELECT * FROM cape_connections WHERE id=?').get(id) as Record<string, unknown>,
  )
}
export function enqueueConnectionAction(
  organizationId: string,
  connectionId: string,
  direction: 'inbound' | 'outbound',
  idempotencyKey: string,
  payload: Record<string, unknown>,
) {
  const connection = getDb()
    .prepare('SELECT id FROM cape_connections WHERE id=? AND organization_id=?')
    .get(connectionId, organizationId)
  if (!connection) throw new Error('Connection not found')
  const now = new Date().toISOString()
  const state = direction === 'outbound' ? 'awaiting-approval' : 'queued'
  getDb()
    .prepare(
      'INSERT OR IGNORE INTO cape_connection_queue (id,organization_id,connection_id,direction,idempotency_key,state,payload_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
    )
    .run(
      `transfer-${randomUUID()}`,
      organizationId,
      connectionId,
      direction,
      idempotencyKey,
      state,
      JSON.stringify(payload),
      now,
      now,
    )
  return { direction, idempotencyKey, state }
}
