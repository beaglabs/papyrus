import type { AppendInput, MaterializedDoc, Operation, Store } from '../port.js'

/**
 * In-memory Store implementing last-write-wins per field over an append-only
 * log. Mimics p2panda's convergence model closely enough for tests and early
 * development. Not durable. Not networked. Persisted nothing.
 *
 * Deterministic conflict resolution: max by (timestamp, author) tuple, so all
 * peers converge identically regardless of sync order.
 */
export class MemoryStore implements Store {
  readonly peerId: string
  private readonly log: Operation[] = []
  private clock = 0
  private seq = 0

  constructor(peerId: string) {
    this.peerId = peerId
  }

  append(input: AppendInput): Operation {
    const ts = input.timestamp ?? ++this.clock
    if (input.timestamp !== undefined && input.timestamp > this.clock) {
      this.clock = input.timestamp
    }
    const op: Operation = {
      author: this.peerId,
      seq: ++this.seq,
      timestamp: ts,
      docId: input.docId,
      collection: input.collection,
      field: input.field,
      value: input.value,
    }
    this.log.push(op)
    return op
  }

  ops(collection?: Operation['collection']): Operation[] {
    return collection ? this.log.filter((o) => o.collection === collection) : [...this.log]
  }

  ingest(incoming: Operation[]): number {
    const seen = new Set(this.log.map((o) => `${o.author}:${o.seq}`))
    let added = 0
    for (const op of incoming) {
      if (!seen.has(`${op.author}:${op.seq}`)) {
        this.log.push(op)
        seen.add(`${op.author}:${op.seq}`)
        added++
        if (op.timestamp > this.clock) this.clock = op.timestamp
      }
    }
    return added
  }

  materialize(docId: string): MaterializedDoc | null {
    const candidates = this.log.filter((o) => o.docId === docId)
    if (candidates.length === 0) return null
    const winners = new Map<string, Operation>()
    for (const op of candidates) {
      const cur = winners.get(op.field)
      if (!cur || compareOp(op, cur) > 0) winners.set(op.field, op)
    }
    const doc: MaterializedDoc = {}
    for (const [field, op] of winners) doc[field] = op.value
    return doc
  }

  docIds(collection?: Operation['collection']): string[] {
    const ids = new Set<string>()
    for (const op of this.log) {
      if (collection && op.collection !== collection) continue
      ids.add(op.docId)
    }
    return [...ids]
  }
}

/** Ordering: higher (timestamp, author) wins. */
function compareOp(a: Operation, b: Operation): number {
  if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp
  return a.author < b.author ? -1 : a.author > b.author ? 1 : 0
}
