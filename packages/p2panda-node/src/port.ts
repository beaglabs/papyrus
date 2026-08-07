/**
 * Papyrus store/sync port — the seam between the TypeScript world (CLI, daemon,
 * web) and the eventually-consistent local-first layer.
 *
 * The production implementation binds p2panda's Node FFI (`p2panda-ffi` via
 * UniFFI → `nodejs/`), which gives us iroh/QUIC mesh sync, SQLite persistence,
 * append-only Ed25519-signed logs, `p2panda-spaces` group encryption, and
 * `p2panda-auth` fine-grained RBAC.
 *
 * This file declares the interface the rest of Papyrus codes against. A mock
 * in-memory CRDT implementation lives in `./memory` and is used by tests and
 * until the FFI adapter in `./ffi` is wired. Swapping the two requires no
 * changes to callers.
 */

/** A single append-only operation on a document field (LWW per field). */
export interface Operation {
  /** Ed25519 public key of the authoring peer (hex). */
  author: string
  /** Per-author monotonically increasing sequence. */
  seq: number
  /** Lamport-style logical timestamp; ties broken by `author` for determinism. */
  timestamp: number
  /** Document id (a node or edge id). */
  docId: string
  /** Document kind discriminator. */
  collection: 'nodes' | 'edges'
  field: string
  value: unknown
}

export interface AppendInput {
  docId: string
  collection: Operation['collection']
  field: string
  value: unknown
  /** Optional override for timestamp (testing concurrent writes). */
  timestamp?: number
}

/**
 * Materialized view of a document = the last-write-winner of every field.
 * Map of docId → { field → value }.
 */
export type MaterializedDoc = Record<string, unknown>

export interface Store {
  readonly peerId: string
  /** Append an operation; `author`, `seq`, `timestamp` are assigned by the store. */
  append(input: AppendInput): Operation
  /** All operations known to this store, optionally filtered by collection. */
  ops(collection?: Operation['collection']): Operation[]
  /** Return the materialized (LWW) view of a document, or null if unknown. */
  materialize(docId: string): MaterializedDoc | null
  /** All known document ids in a collection. */
  docIds(collection?: Operation['collection']): string[]
  /** Merge operations received from a peer (dedup by author+seq). */
  ingest(ops: Operation[]): number
}

export interface SyncResult {
  sent: number
  received: number
}

/**
 * Exchange all operations between two stores and converge them. The real
 * p2panda adapter replaces this with iroh's efficient range-based sync; the
 * mock uses full-set exchange, which is sufficient to prove the contract.
 */
export type SyncPort = (a: Store, b: Store) => SyncResult
