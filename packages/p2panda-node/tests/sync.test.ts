import { describe, expect, it } from 'vitest'
import { MemoryStore, converged, sync } from '../src'

/**
 * Two-peer sync smoke test — proves the eventually-consistent contract that
 * the rest of Papyrus depends on. When the real p2panda FFI adapter lands, the
 * same test runs against `P2pandaStore` with no changes.
 */
describe('two-peer CRDT sync (in-memory mock of p2panda)', () => {
  it('replicates a node from A to B', () => {
    const a = new MemoryStore('peerA')
    const b = new MemoryStore('peerB')
    const doc = 'node-1'

    a.append({ docId: doc, collection: 'nodes', field: 'type', value: 'mission-need' })
    a.append({ docId: doc, collection: 'nodes', field: 'position', value: { x: 10, y: 20 } })

    sync(a, b)

    expect(b.materialize(doc)).toEqual({
      type: 'mission-need',
      position: { x: 10, y: 20 },
    })
  })

  it('converges after concurrent edits (last-write-wins, deterministic)', () => {
    const a = new MemoryStore('peerA')
    const b = new MemoryStore('peerB')
    const doc = 'node-2'

    // Both peers write the SAME field at the SAME logical timestamp (a true conflict).
    a.append({ docId: doc, collection: 'nodes', field: 'status', value: 'draft', timestamp: 100 })
    b.append({ docId: doc, collection: 'nodes', field: 'status', value: 'review', timestamp: 100 })

    // Two exchanges (both directions) to reach eventual consistency.
    sync(a, b)
    sync(b, a)

    expect(converged(a, b, 'nodes')).toBe(true)
    // Tie broken by author id; "peerB" > "peerA" lexicographically → 'review'.
    expect(a.materialize(doc)).toEqual({ status: 'review' })
    expect(a.materialize(doc)).toEqual(b.materialize(doc))
  })

  it('latest timestamp wins on resync after divergence', () => {
    const a = new MemoryStore('peerA')
    const b = new MemoryStore('peerB')
    const doc = 'node-3'

    a.append({ docId: doc, collection: 'nodes', field: 'title', value: 'v1' })
    sync(a, b)
    expect(b.materialize(doc)).toEqual({ title: 'v1' })

    // B edits with a later timestamp, then resync.
    b.append({ docId: doc, collection: 'nodes', field: 'title', value: 'v2', timestamp: 999 })
    sync(a, b)

    expect(a.materialize(doc)).toEqual({ title: 'v2' })
    expect(converged(a, b, 'nodes')).toBe(true)
  })
})
