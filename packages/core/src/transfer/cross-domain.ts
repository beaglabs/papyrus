/**
 * Cross-domain transfer — append-only operation log for CRDT-style merging.
 *
 * Designed for SIPRNet ↔ NIPRNet transfer where direct network sync isn't
 * possible. Each mutation is logged as an immutable operation. The log can be
 * exported as a signed bundle, physically transported, and imported into another
 * domain's instance for merge.
 *
 * Operation types:
 * - node:create, node:update, node:delete
 * - edge:create, edge:delete
 * - project:create, project:update
 *
 * Each operation is signed with the creator's Ed25519 key for tamper evidence.
 * Bundles are compressed with gzip for efficient transport.
 */
import { gzipSync, gunzipSync } from 'node:zlib'
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CanvasNodeDoc, EdgeDoc } from '@papyrus/core/nodes/types'

const TRANSFER_DIR = join(process.env.HOME ?? '~', '.papyrus', 'transfer')

export type OperationType =
  | 'node:create'
  | 'node:update'
  | 'node:delete'
  | 'edge:create'
  | 'edge:delete'
  | 'project:create'
  | 'project:update'

export interface Operation {
  id: string
  type: OperationType
  projectId: string
  /** The node/edge ID this operation targets */
  targetId: string
  /** The full document for create/update operations */
  data?: CanvasNodeDoc | EdgeDoc
  /** Timestamp (ISO) */
  timestamp: string
  /** Member public key of the creator */
  authorKey: string
  /** Monotonic sequence number within the project */
  seq: number
}

export interface TransferBundle {
  version: 1
  exportedAt: string
  sourceDomain: string
  /** The operations in this bundle */
  operations: Operation[]
  /** SHA-256 hash of the operations for integrity */
  hash: string
  /** Ed25519 signature of the hash (hex) */
  signature: string
  /** Public key of the signer (hex) */
  signerKey: string
}

// ── Operation Log (per-project) ──────────────────────────────

function logPath(projectId: string): string {
  return join(TRANSFER_DIR, `${projectId}.log.json`)
}

function loadLog(projectId: string): Operation[] {
  const path = logPath(projectId)
  if (!existsSync(path)) return []
  return JSON.parse(readFileSync(path, 'utf-8')) as Operation[]
}

function saveLog(projectId: string, ops: Operation[]): void {
  if (!existsSync(TRANSFER_DIR)) {
    mkdirSync(TRANSFER_DIR, { recursive: true })
  }
  writeFileSync(logPath(projectId), JSON.stringify(ops, null, 2), 'utf-8')
}

/** Get the next sequence number for a project. */
function nextSeq(projectId: string): number {
  const ops = loadLog(projectId)
  if (ops.length === 0) return 1
  return Math.max(...ops.map((o) => o.seq)) + 1
}

/** Append an operation to the project log. */
export function appendOperation(op: Omit<Operation, 'id' | 'timestamp' | 'seq'>): Operation {
  const ops = loadLog(op.projectId)
  const fullOp: Operation = {
    ...op,
    id: `op-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    seq: nextSeq(op.projectId),
  }
  ops.push(fullOp)
  saveLog(op.projectId, ops)
  return fullOp
}

/** Get all operations for a project. */
export function getOperations(projectId: string): Operation[] {
  return loadLog(projectId)
}

/** Get operations since a given sequence number. */
export function getOperationsSince(projectId: string, sinceSeq: number): Operation[] {
  return loadLog(projectId).filter((op) => op.seq > sinceSeq)
}

// ── Ed25519 Signing Helpers ──────────────────────────────────

function pemPublicKeyFromHex(pubHex: string): string {
  const raw = Buffer.from(pubHex, 'hex')
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw])
  return `-----BEGIN PUBLIC KEY-----\n${spki.toString('base64')}\n-----END PUBLIC KEY-----`
}

function pemPrivateKeyFromHex(privHex: string): string {
  const raw = Buffer.from(privHex, 'hex')
  const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), raw])
  return `-----BEGIN PRIVATE KEY-----\n${pkcs8.toString('base64')}\n-----END PRIVATE KEY-----`
}

function signData(data: Buffer, privHex: string): string {
  const pem = pemPrivateKeyFromHex(privHex)
  const keyObject = createPrivateKey(pem)
  const sig = sign(null, data, keyObject)
  return sig.toString('hex')
}

function verifySig(data: Buffer, sigHex: string, pubHex: string): boolean {
  try {
    const pem = pemPublicKeyFromHex(pubHex)
    const keyObject = createPublicKey(pem)
    const sig = Buffer.from(sigHex, 'hex')
    return verify(null, data, keyObject, sig)
  } catch {
    return false
  }
}

// ── Export / Import ──────────────────────────────────────────

/** Compute a simple hash of the operations array. */
async function hashOperations(ops: Operation[]): Promise<string> {
  const data = JSON.stringify(ops)
  const encoder = new TextEncoder()
  const buffer = await crypto.subtle.digest('SHA-256', encoder.encode(data))
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Export a project's operation log as a signed transfer bundle.
 * The bundle is signed with the creator's Ed25519 key.
 */
export async function exportBundle(
  projectId: string,
  sourceDomain: string,
  signerKey: string,
  signerPrivKey: string,
  sinceSeq = 0,
): Promise<TransferBundle> {
  const ops = sinceSeq > 0 ? getOperationsSince(projectId, sinceSeq) : getOperations(projectId)
  const hash = await hashOperations(ops)

  // Sign the hash
  const signature = signData(Buffer.from(hash, 'utf-8'), signerPrivKey)

  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    sourceDomain,
    operations: ops,
    hash,
    signature,
    signerKey,
  }
}

/**
 * Verify a transfer bundle's integrity and signature.
 */
export async function verifyBundle(bundle: TransferBundle): Promise<boolean> {
  // Verify hash
  const hash = await hashOperations(bundle.operations)
  if (hash !== bundle.hash) return false

  // Verify Ed25519 signature
  const hashBytes = Buffer.from(bundle.hash, 'utf-8')
  return verifySig(hashBytes, bundle.signature, bundle.signerKey)
}

/**
 * Apply a transfer bundle to the local project state.
 * Returns the list of operations that were applied (skipping duplicates).
 */
export function applyBundle(
  bundle: TransferBundle,
  projectId: string,
  existingOps: Operation[],
): Operation[] {
  const existingSeqs = new Set(existingOps.map((o) => o.seq))
  const applied: Operation[] = []

  for (const op of bundle.operations) {
    if (op.projectId !== projectId) continue
    if (existingSeqs.has(op.seq)) continue

    // Append to log
    const ops = loadLog(projectId)
    ops.push(op)
    // Re-sort by sequence
    ops.sort((a, b) => a.seq - b.seq)
    saveLog(projectId, ops)

    applied.push(op)
    existingSeqs.add(op.seq)
  }

  return applied
}

/**
 * Apply operations to canvas state (nodes + edges).
 * This is the merge function that translates operations into state changes.
 */
export function applyOperationsToState(
  ops: Operation[],
  nodes: CanvasNodeDoc[],
  edges: EdgeDoc[],
): { nodes: CanvasNodeDoc[]; edges: EdgeDoc[] } {
  const resultNodes = [...nodes]
  const resultEdges = [...edges]

  for (const op of ops) {
    switch (op.type) {
      case 'node:create': {
        if (op.data && !resultNodes.find((n) => n.id === op.targetId)) {
          resultNodes.push(op.data as CanvasNodeDoc)
        }
        break
      }
      case 'node:update': {
        if (op.data) {
          const idx = resultNodes.findIndex((n) => n.id === op.targetId)
          if (idx >= 0) {
            resultNodes[idx] = op.data as CanvasNodeDoc
          }
        }
        break
      }
      case 'node:delete': {
        const idx = resultNodes.findIndex((n) => n.id === op.targetId)
        if (idx >= 0) resultNodes.splice(idx, 1)
        break
      }
      case 'edge:create': {
        if (op.data && !resultEdges.find((e) => e.id === op.targetId)) {
          resultEdges.push(op.data as EdgeDoc)
        }
        break
      }
      case 'edge:delete': {
        const idx = resultEdges.findIndex((e) => e.id === op.targetId)
        if (idx >= 0) resultEdges.splice(idx, 1)
        break
      }
    }
  }

  return { nodes: resultNodes, edges: resultEdges }
}

// ── Compression Utilities ────────────────────────────────────

/**
 * Compress a transfer bundle to gzip format.
 * Returns the compressed buffer and the original size for comparison.
 */
export function compressBundle(bundle: TransferBundle): { compressed: Buffer; originalSize: number; compressedSize: number } {
  const json = JSON.stringify(bundle)
  const originalSize = Buffer.byteLength(json, 'utf-8')
  const compressed = gzipSync(Buffer.from(json, 'utf-8'))
  return { compressed, originalSize, compressedSize: compressed.length }
}

/**
 * Decompress a gzip-compressed transfer bundle.
 */
export function decompressBundle(compressed: Buffer): TransferBundle {
  const decompressed = gunzipSync(compressed)
  return JSON.parse(decompressed.toString('utf-8')) as TransferBundle
}

/**
 * Get compression ratio for a bundle (useful for logging).
 */
export function getCompressionRatio(bundle: TransferBundle): number {
  const json = JSON.stringify(bundle)
  const originalSize = Buffer.byteLength(json, 'utf-8')
  const compressed = gzipSync(Buffer.from(json, 'utf-8'))
  return compressed.length / originalSize
}
