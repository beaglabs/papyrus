import { createHash, randomUUID } from 'node:crypto'
import { getDb } from './database.js'
export interface DeploymentPosture {
  profile: string
  identityStatus: string
  auditForwardingStatus: string
  backupStatus: string
  secretStoreStatus: string
  timeSyncStatus: string
  authorizationStatus: string
  updatedAt: string
}
function map(row: Record<string, unknown>): DeploymentPosture {
  return {
    profile: String(row.profile),
    identityStatus: String(row.identity_status),
    auditForwardingStatus: String(row.audit_forwarding_status),
    backupStatus: String(row.backup_status),
    secretStoreStatus: String(row.secret_store_status),
    timeSyncStatus: String(row.time_sync_status),
    authorizationStatus: String(row.authorization_status),
    updatedAt: String(row.updated_at),
  }
}
export function getDeploymentPosture(organizationId: string, actor: string): DeploymentPosture {
  let row = getDb()
    .prepare('SELECT * FROM deployment_posture WHERE organization_id=?')
    .get(organizationId) as Record<string, unknown> | undefined
  if (!row) {
    const now = new Date().toISOString()
    getDb()
      .prepare(
        'INSERT INTO deployment_posture (organization_id,updated_by,updated_at) VALUES (?,?,?)',
      )
      .run(organizationId, actor, now)
    row = getDb()
      .prepare('SELECT * FROM deployment_posture WHERE organization_id=?')
      .get(organizationId) as Record<string, unknown>
  }
  return map(row)
}
export function updateDeploymentPosture(
  organizationId: string,
  actor: string,
  input: Partial<DeploymentPosture>,
): DeploymentPosture {
  const current = getDeploymentPosture(organizationId, actor)
  const next = { ...current, ...input, authorizationStatus: 'not-authorized' }
  const allowed = ['local-development', 'nipr-il5-pilot', 'future-classified']
  if (!allowed.includes(next.profile)) throw new Error('Unsupported deployment profile')
  const now = new Date().toISOString()
  getDb()
    .prepare(
      'UPDATE deployment_posture SET profile=?,identity_status=?,audit_forwarding_status=?,backup_status=?,secret_store_status=?,time_sync_status=?,authorization_status=?,updated_by=?,updated_at=? WHERE organization_id=?',
    )
    .run(
      next.profile,
      next.identityStatus,
      next.auditForwardingStatus,
      next.backupStatus,
      next.secretStoreStatus,
      next.timeSyncStatus,
      'not-authorized',
      actor,
      now,
      organizationId,
    )
  return getDeploymentPosture(organizationId, actor)
}
export function generateAuthorizationEvidence(organizationId: string, actor: string) {
  const posture = getDeploymentPosture(organizationId, actor)
  const manifest = {
    schemaVersion: 'papyrus.authorization-evidence.v1',
    generatedAt: new Date().toISOString(),
    posture,
    controlStates: [
      'implemented',
      'configured',
      'inherited',
      'customer-owned',
      'not-applicable',
      'unverified',
    ],
    artifacts: [
      'SBOM',
      'dependency inventory',
      'ports protocols services',
      'data flows',
      'backup and restore',
      'upgrade and rollback',
      'audit event catalog',
    ],
    assertion:
      'Evidence package only; authorization remains a Government Authorizing Official decision',
  }
  const serialized = JSON.stringify(manifest)
  const sha256 = createHash('sha256').update(serialized).digest('hex')
  const id = `evidence-${randomUUID()}`
  getDb()
    .prepare('INSERT INTO authorization_evidence_bundles VALUES (?,?,?,?,?,?,?,?)')
    .run(
      id,
      organizationId,
      posture.profile,
      serialized,
      sha256,
      'unsigned',
      actor,
      manifest.generatedAt,
    )
  return { id, sha256, signatureStatus: 'unsigned', manifest }
}
