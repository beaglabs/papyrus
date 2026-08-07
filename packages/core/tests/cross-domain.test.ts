import { describe, it, expect } from 'vitest'
import {
  appendOperation,
  getOperations,
  getOperationsSince,
  exportBundle,
  verifyBundle,
  applyBundle,
  applyOperationsToState,
  type Operation,
  type TransferBundle,
} from '../src/transfer/cross-domain'

// Use unique project IDs per test to avoid file-system cross-contamination
let testCounter = 0
function nextProject(): string {
  return `proj-test-${++testCounter}-${Date.now()}`
}

describe('Cross-domain transfer', () => {
  describe('appendOperation', () => {
    it('should append an operation with auto-generated id, timestamp, and seq', () => {
      const projectId = nextProject()
      const op = appendOperation({
        type: 'node:create',
        projectId,
        targetId: 'node-1',
        data: { id: 'node-1', projectId, type: 'feature', category: 'strategy' as const, flowRole: 'artifact' as const, position: { x: 0, y: 0 }, fields: {}, status: 'draft' as const, createdBy: 'user-1', updatedAt: Date.now() },
        authorKey: 'key-1',
      })

      expect(op.id).toMatch(/^op-/)
      expect(op.timestamp).toBeTruthy()
      expect(op.seq).toBe(1)
      expect(op.type).toBe('node:create')
      expect(op.projectId).toBe(projectId)
    })

    it('should increment sequence numbers', () => {
      const projectId = nextProject()
      const op1 = appendOperation({
        type: 'node:create',
        projectId,
        targetId: 'node-1',
        authorKey: 'key-1',
      })
      const op2 = appendOperation({
        type: 'node:update',
        projectId,
        targetId: 'node-1',
        authorKey: 'key-1',
      })

      expect(op2.seq).toBe(op1.seq + 1)
    })
  })

  describe('getOperations / getOperationsSince', () => {
    it('should return all operations for a project', () => {
      const projA = nextProject()
      appendOperation({ type: 'node:create', projectId: projA, targetId: 'n1', authorKey: 'k1' })
      appendOperation({ type: 'edge:create', projectId: projA, targetId: 'e1', authorKey: 'k1' })

      const ops = getOperations(projA)
      expect(ops.length).toBe(2)
      expect(ops.every((o) => o.projectId === projA)).toBe(true)
    })

    it('should filter by sinceSeq', () => {
      const projX = nextProject()
      appendOperation({ type: 'node:create', projectId: projX, targetId: 'n1', authorKey: 'k1' })
      appendOperation({ type: 'node:create', projectId: projX, targetId: 'n2', authorKey: 'k1' })
      appendOperation({ type: 'node:create', projectId: projX, targetId: 'n3', authorKey: 'k1' })

      const ops = getOperationsSince(projX, 2)
      expect(ops.length).toBe(1)
      expect(ops[0]!.targetId).toBe('n3')
    })
  })

  describe('exportBundle / verifyBundle', () => {
    it('should export a signed bundle', async () => {
      const projectId = nextProject()
      appendOperation({ type: 'node:create', projectId, targetId: 'n1', authorKey: 'k1' })

      const { generateKeyPairSync } = await import('node:crypto')
      const { publicKey, privateKey } = generateKeyPairSync('ed25519')
      const pubHex = publicKey.export({ type: 'spki', format: 'der' }).subarray(12, 44).toString('hex')
      const privHex = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(16, 48).toString('hex')

      const bundle = await exportBundle(projectId, 'test-domain', pubHex, privHex)

      expect(bundle.version).toBe(1)
      expect(bundle.sourceDomain).toBe('test-domain')
      expect(bundle.operations.length).toBe(1)
      expect(bundle.hash).toBeTruthy()
      expect(bundle.signature).toBeTruthy()
      expect(bundle.signerKey).toBe(pubHex)
    })

    it('should verify a valid bundle', async () => {
      const projectId = nextProject()
      appendOperation({ type: 'node:create', projectId, targetId: 'n1', authorKey: 'k1' })

      const { generateKeyPairSync } = await import('node:crypto')
      const { publicKey, privateKey } = generateKeyPairSync('ed25519')
      const pubHex = publicKey.export({ type: 'spki', format: 'der' }).subarray(12, 44).toString('hex')
      const privHex = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(16, 48).toString('hex')

      const bundle = await exportBundle(projectId, 'test-domain', pubHex, privHex)
      const valid = await verifyBundle(bundle)
      expect(valid).toBe(true)
    })

    it('should reject a tampered bundle', async () => {
      const projectId = nextProject()
      appendOperation({ type: 'node:create', projectId, targetId: 'n1', authorKey: 'k1' })

      const { generateKeyPairSync } = await import('node:crypto')
      const { publicKey, privateKey } = generateKeyPairSync('ed25519')
      const pubHex = publicKey.export({ type: 'spki', format: 'der' }).subarray(12, 44).toString('hex')
      const privHex = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(16, 48).toString('hex')

      const bundle = await exportBundle(projectId, 'test-domain', pubHex, privHex)
      bundle.operations.push({
        id: 'op-tamper',
        type: 'node:create',
        projectId,
        targetId: 'n-tamper',
        timestamp: new Date().toISOString(),
        authorKey: 'k1',
        seq: 999,
      })

      const valid = await verifyBundle(bundle)
      expect(valid).toBe(false)
    })
  })

  describe('applyBundle', () => {
    it('should apply new operations and skip duplicates', () => {
      const projectId = nextProject()
      const op1 = appendOperation({ type: 'node:create', projectId, targetId: 'n1', authorKey: 'k1' })
      const op2 = appendOperation({ type: 'node:create', projectId, targetId: 'n2', authorKey: 'k1' })

      const bundle: TransferBundle = {
        version: 1,
        exportedAt: new Date().toISOString(),
        sourceDomain: 'other',
        operations: [op1, op2, { ...op1, id: 'op-dup', seq: op1.seq }],
        hash: 'fake-hash',
        signature: 'fake-sig',
        signerKey: 'fake-key',
      }

      const existing = getOperations(projectId)
      const applied = applyBundle(bundle, projectId, existing)
      expect(applied.length).toBe(0)
    })
  })

  describe('applyOperationsToState', () => {
    it('should apply node:create operations', () => {
      const node = { id: 'n1', projectId: 'p', type: 'feature', category: 'strategy' as const, flowRole: 'artifact' as const, position: { x: 0, y: 0 }, fields: {}, status: 'draft' as const, createdBy: 'k1', updatedAt: Date.now() }
      const ops: Operation[] = [{
        id: 'op1',
        type: 'node:create',
        projectId: 'p',
        targetId: 'n1',
        data: node,
        timestamp: new Date().toISOString(),
        authorKey: 'k1',
        seq: 1,
      }]

      const result = applyOperationsToState(ops, [], [])
      expect(result.nodes.length).toBe(1)
      expect(result.nodes[0]!.id).toBe('n1')
    })

    it('should apply node:delete operations', () => {
      const existing = [{ id: 'n1', projectId: 'p', type: 'feature', category: 'strategy' as const, flowRole: 'artifact' as const, position: { x: 0, y: 0 }, fields: {}, status: 'draft' as const, createdBy: 'k1', updatedAt: Date.now() }]
      const ops: Operation[] = [{
        id: 'op1',
        type: 'node:delete',
        projectId: 'p',
        targetId: 'n1',
        timestamp: new Date().toISOString(),
        authorKey: 'k1',
        seq: 1,
      }]

      const result = applyOperationsToState(ops, existing, [])
      expect(result.nodes.length).toBe(0)
    })

    it('should apply edge:create operations', () => {
      const edge = { id: 'e1', projectId: 'p', from: 'n1', to: 'n2', kind: 'smoothstep', createdBy: 'k1', updatedAt: Date.now() }
      const ops: Operation[] = [{
        id: 'op1',
        type: 'edge:create',
        projectId: 'p',
        targetId: 'e1',
        data: edge,
        timestamp: new Date().toISOString(),
        authorKey: 'k1',
        seq: 1,
      }]

      const result = applyOperationsToState(ops, [], [])
      expect(result.edges.length).toBe(1)
      expect(result.edges[0]!.id).toBe('e1')
    })
  })
})
