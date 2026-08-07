import type { Store, SyncPort, SyncResult } from '../port.js'

/** Full-set exchange sync between two in-memory stores. */
export const sync: SyncPort = (a: Store, b: Store): SyncResult => {
  const sent = b.ingest(a.ops())
  const received = a.ingest(b.ops())
  return { sent, received }
}

/** Assert two stores hold identical materialized state for a collection. */
export function converged(a: Store, b: Store, collection: Parameters<Store['ops']>[0]): boolean {
  const ids = new Set([...a.docIds(collection), ...b.docIds(collection)])
  for (const id of ids) {
    const ma = a.materialize(id)
    const mb = b.materialize(id)
    if (JSON.stringify(ma) !== JSON.stringify(mb)) return false
  }
  return true
}

export type { SyncResult }
