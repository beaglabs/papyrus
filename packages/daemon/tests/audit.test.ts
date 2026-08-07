import { describe, it, expect } from 'vitest'
import { auditLog, getAuditLog, verifyAuditChain } from '../src/audit.js'

let testCounter = 0
function nextProject(): string {
  return `audit-test-${++testCounter}-${Date.now()}`
}

describe('Audit logging', () => {
  describe('auditLog', () => {
    it('should record an audit entry', () => {
      const projectId = nextProject()
      const entry = auditLog({
        actor: 'user-1',
        action: 'create',
        entityType: 'node',
        entityId: 'node-1',
        projectId,
        details: { title: 'Test Node' },
      })

      expect(entry.id).toBeGreaterThan(0)
      expect(entry.actor).toBe('user-1')
      expect(entry.action).toBe('create')
      expect(entry.entityType).toBe('node')
      expect(entry.entityId).toBe('node-1')
      expect(entry.projectId).toBe(projectId)
      expect(entry.details).toEqual({ title: 'Test Node' })
      expect(entry.entryHash).toBeTruthy()
    })

    it('should chain hashes', () => {
      const projectId = nextProject()
      const entry1 = auditLog({
        actor: 'user-1',
        action: 'create',
        entityType: 'node',
        entityId: 'node-1',
        projectId,
      })

      const entry2 = auditLog({
        actor: 'user-1',
        action: 'update',
        entityType: 'node',
        entityId: 'node-1',
        projectId,
      })

      expect(entry2.prevHash).toBe(entry1.entryHash)
    })
  })

  describe('getAuditLog', () => {
    it('should return entries for a project', () => {
      const projectId = nextProject()
      auditLog({ actor: 'u1', action: 'create', entityType: 'node', entityId: 'n1', projectId })
      auditLog({ actor: 'u1', action: 'update', entityType: 'node', entityId: 'n1', projectId })

      const log = getAuditLog({ projectId })
      expect(log.length).toBe(2)
      expect(log.every((e) => e.projectId === projectId)).toBe(true)
    })

    it('should filter by actor', () => {
      const projectId = nextProject()
      auditLog({ actor: 'u1', action: 'create', entityType: 'node', entityId: 'n1', projectId })
      auditLog({ actor: 'u2', action: 'create', entityType: 'node', entityId: 'n2', projectId })

      const log = getAuditLog({ projectId, actor: 'u1' })
      expect(log.length).toBe(1)
      expect(log[0]!.actor).toBe('u1')
    })

    it('should filter by action', () => {
      const projectId = nextProject()
      auditLog({ actor: 'u1', action: 'create', entityType: 'node', entityId: 'n1', projectId })
      auditLog({ actor: 'u1', action: 'delete', entityType: 'node', entityId: 'n1', projectId })

      const log = getAuditLog({ projectId, action: 'create' })
      expect(log.length).toBe(1)
      expect(log[0]!.action).toBe('create')
    })

    it('should respect limit', () => {
      const projectId = nextProject()
      auditLog({ actor: 'u1', action: 'create', entityType: 'node', entityId: 'n1', projectId })
      auditLog({ actor: 'u1', action: 'create', entityType: 'node', entityId: 'n2', projectId })
      auditLog({ actor: 'u1', action: 'create', entityType: 'node', entityId: 'n3', projectId })

      const log = getAuditLog({ projectId, limit: 2 })
      expect(log.length).toBe(2)
    })
  })

  describe('verifyAuditChain', () => {
    it('should verify a valid chain', () => {
      const projectId = nextProject()
      auditLog({ actor: 'u1', action: 'create', entityType: 'node', entityId: 'n1', projectId })
      auditLog({ actor: 'u1', action: 'update', entityType: 'node', entityId: 'n1', projectId })

      const result = verifyAuditChain(projectId)
      expect(result.valid).toBe(true)
      expect(result.brokenAt).toBeUndefined()
    })

    it('should return valid for empty project', () => {
      const projectId = nextProject()
      const result = verifyAuditChain(projectId)
      expect(result.valid).toBe(true)
    })
  })
})
