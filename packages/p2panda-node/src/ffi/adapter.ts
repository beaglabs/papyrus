/**
 * Real p2panda FFI adapter — SCAFFOLD ONLY (not wired yet).
 *
 * Goal: implement `Store` (and a real `SyncPort` over iroh/QUIC) by calling the
 * p2panda Node bindings generated from `p2panda-ffi` via UniFFI
 * (`uniffi-bindgen-node-js`). Everything else in Papyrus codes against the
 * `Store`/`SyncPort` interfaces, so completing this file is the only thing
 * required to go live — no caller changes.
 *
 * Build steps (requires Rust; present on this machine — rustc 1.92):
 *   1. Clone https://github.com/p2panda/p2panda-ffi
 *   2. `make build`              # compiles libp2panda_ffi
 *   3. `make ffi-nodejs`         # generates the Node.js bindings (nodejs/)
 *   4. `cd nodejs && npm run build`
 *   5. Copy the produced bindings + native lib into this package and load here.
 *
 * Status: throws on use so the seam is obvious. P0 proves the contract with
 * the in-memory mock (`../memory`); wiring this adapter is the next milestone.
 */
import type { AppendInput, Operation, Store } from '../port.js'

export class P2pandaStore implements Store {
  readonly peerId: string

  constructor(peerId: string) {
    this.peerId = peerId
    throw new Error(
      'P2pandaStore is not wired yet. Use MemoryStore for now. ' +
        'See packages/p2panda-node/src/ffi/adapter.ts for build steps.',
    )
  }

  append(_input: AppendInput): Operation {
    throw new Error('not wired')
  }
  ops(_collection?: Operation['collection']): Operation[] {
    throw new Error('not wired')
  }
  ingest(_ops: Operation[]): number {
    throw new Error('not wired')
  }
  materialize(_docId: string): Record<string, unknown> | null {
    throw new Error('not wired')
  }
  docIds(_collection?: Operation['collection']): string[] {
    throw new Error('not wired')
  }
}
