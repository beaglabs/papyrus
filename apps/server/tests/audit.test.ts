import { afterEach, describe, expect, it } from 'vitest'
import { testContext } from './helpers.js'

describe('append-only audit', () => {
  const contexts: ReturnType<typeof testContext>[] = []
  afterEach(() => { while (contexts.length) contexts.pop()?.dispose() })

  it('chains events and blocks update and delete', () => {
    const context = testContext(); contexts.push(context)
    const first = context.service.audit.append({ actorId: null, action: 'One', resourceType: 'Test', resourceId: '1', decision: 'info', metadata: {} })
    const second = context.service.audit.append({ actorId: null, action: 'Two', resourceType: 'Test', resourceId: '2', decision: 'deny', metadata: { reason: 'test' } })
    expect(second.previousHash).toBe(first.hash)
    expect(context.service.audit.verify()).toEqual({ valid: true })
    expect(() => context.db.sqlite.prepare('UPDATE audit_events SET action=? WHERE sequence=1').run('tamper')).toThrow(/append-only/)
    expect(() => context.db.sqlite.prepare('DELETE FROM audit_events WHERE sequence=1').run()).toThrow(/append-only/)
  })
})
