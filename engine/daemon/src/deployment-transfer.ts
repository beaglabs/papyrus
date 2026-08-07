import { createHash, sign, verify } from 'node:crypto'
import {
  deploymentFingerprint,
  loadOrGenerateDeploymentIdentity,
} from '@papyrus/core/auth/deployment-identity'
import type { StoredOperation } from './database.js'

export interface DeploymentTransferBundle {
  version: 2
  exportedAt: string
  sourceDomain: string
  sourceDeploymentId: string
  signerPublicKeyPem: string
  projectId: string
  operations: StoredOperation[]
  hash: string
  signature: string
}

function canonicalPayload(bundle: Omit<DeploymentTransferBundle, 'hash' | 'signature'>): string {
  return JSON.stringify(bundle)
}

export function createDeploymentBundle(
  projectId: string,
  sourceDomain: string,
  operations: StoredOperation[],
): DeploymentTransferBundle {
  const identity = loadOrGenerateDeploymentIdentity()
  const unsigned = {
    version: 2 as const,
    exportedAt: new Date().toISOString(),
    sourceDomain,
    sourceDeploymentId: identity.deploymentId,
    signerPublicKeyPem: identity.publicKeyPem,
    projectId,
    operations,
  }
  const hash = createHash('sha256').update(canonicalPayload(unsigned)).digest('hex')
  const signature = sign(null, Buffer.from(hash, 'utf8'), identity.privateKeyPem).toString('base64')
  return { ...unsigned, hash, signature }
}

export function verifyDeploymentBundle(
  bundle: DeploymentTransferBundle,
  trustedDeploymentIds: ReadonlySet<string>,
): { valid: boolean; reason?: string } {
  if (bundle.version !== 2) return { valid: false, reason: 'Unsupported transfer version' }
  if (deploymentFingerprint(bundle.signerPublicKeyPem) !== bundle.sourceDeploymentId) {
    return { valid: false, reason: 'Deployment identity fingerprint mismatch' }
  }
  if (!trustedDeploymentIds.has(bundle.sourceDeploymentId)) {
    return { valid: false, reason: 'Source deployment is not trusted' }
  }
  const { hash, signature, ...unsigned } = bundle
  const expected = createHash('sha256').update(canonicalPayload(unsigned)).digest('hex')
  if (expected !== hash) return { valid: false, reason: 'Bundle hash mismatch' }
  const valid = verify(
    null,
    Buffer.from(hash, 'utf8'),
    bundle.signerPublicKeyPem,
    Buffer.from(signature, 'base64'),
  )
  return valid ? { valid: true } : { valid: false, reason: 'Bundle signature invalid' }
}
