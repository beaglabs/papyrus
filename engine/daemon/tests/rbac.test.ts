import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, createProject } from '../src/database.js'
import {
  type ProjectRole,
  assignRole,
  getProjectRoles,
  getRole,
  hasPermission,
  removeRole,
  requirePermission,
} from '../src/rbac.js'

afterAll(() => closeDb())

let testCounter = 0
function nextProject(): string {
  return createProject(`RBAC test ${++testCounter}-${Date.now()}`).id
}

describe('RBAC', () => {
  describe('assignRole', () => {
    it('should assign a role to a member', () => {
      const projectId = nextProject()
      const assignment = assignRole(projectId, 'member-1', 'editor', 'owner-1')

      expect(assignment.projectId).toBe(projectId)
      expect(assignment.memberKey).toBe('member-1')
      expect(assignment.role).toBe('editor')
      expect(assignment.assignedBy).toBe('owner-1')
    })

    it('should overwrite existing role', () => {
      const projectId = nextProject()
      assignRole(projectId, 'member-1', 'editor', 'owner-1')
      const updated = assignRole(projectId, 'member-1', 'viewer', 'owner-1')

      expect(updated.role).toBe('viewer')
    })
  })

  describe('getRole', () => {
    it('should return role for existing member', () => {
      const projectId = nextProject()
      assignRole(projectId, 'member-1', 'editor', 'owner-1')

      const role = getRole(projectId, 'member-1')
      expect(role).toBe('editor')
    })

    it('should return null for unknown member', () => {
      const projectId = nextProject()
      const role = getRole(projectId, 'unknown-member')
      expect(role).toBeNull()
    })
  })

  describe('removeRole', () => {
    it('should remove an existing role', () => {
      const projectId = nextProject()
      assignRole(projectId, 'member-1', 'editor', 'owner-1')

      const removed = removeRole(projectId, 'member-1')
      expect(removed).toBe(true)

      const role = getRole(projectId, 'member-1')
      expect(role).toBeNull()
    })

    it('should return false for non-existent role', () => {
      const projectId = nextProject()
      const removed = removeRole(projectId, 'unknown-member')
      expect(removed).toBe(false)
    })
  })

  describe('getProjectRoles', () => {
    it('should return all roles for a project', () => {
      const projectId = nextProject()
      assignRole(projectId, 'member-1', 'editor', 'owner-1')
      assignRole(projectId, 'member-2', 'viewer', 'owner-1')

      const roles = getProjectRoles(projectId)
      expect(roles.length).toBe(2)
      expect(roles.map((r) => r.memberKey).sort()).toEqual(['member-1', 'member-2'])
    })
  })

  describe('hasPermission', () => {
    it('should grant owner all permissions', () => {
      const projectId = nextProject()
      assignRole(projectId, 'owner-1', 'owner', 'system')

      expect(hasPermission(projectId, 'owner-1', 'project:delete')).toBe(true)
      expect(hasPermission(projectId, 'owner-1', 'role:assign')).toBe(true)
      expect(hasPermission(projectId, 'owner-1', 'node:create')).toBe(true)
    })

    it('should grant editor read/write permissions', () => {
      const projectId = nextProject()
      assignRole(projectId, 'editor-1', 'editor', 'owner-1')

      expect(hasPermission(projectId, 'editor-1', 'node:create')).toBe(true)
      expect(hasPermission(projectId, 'editor-1', 'node:read')).toBe(true)
      expect(hasPermission(projectId, 'editor-1', 'role:assign')).toBe(false)
    })

    it('should grant viewer read-only permissions', () => {
      const projectId = nextProject()
      assignRole(projectId, 'viewer-1', 'viewer', 'owner-1')

      expect(hasPermission(projectId, 'viewer-1', 'node:read')).toBe(true)
      expect(hasPermission(projectId, 'viewer-1', 'node:create')).toBe(false)
      expect(hasPermission(projectId, 'viewer-1', 'node:delete')).toBe(false)
    })

    it('should deny unknown members', () => {
      const projectId = nextProject()
      expect(hasPermission(projectId, 'unknown', 'node:read')).toBe(false)
    })
  })

  describe('requirePermission', () => {
    it('should not throw for allowed permission', () => {
      const projectId = nextProject()
      assignRole(projectId, 'member-1', 'editor', 'owner-1')

      expect(() => requirePermission(projectId, 'member-1', 'node:create')).not.toThrow()
    })

    it('should throw for denied permission', () => {
      const projectId = nextProject()
      assignRole(projectId, 'member-1', 'viewer', 'owner-1')

      expect(() => requirePermission(projectId, 'member-1', 'node:create')).toThrow(
        /Permission denied/,
      )
    })
  })
})
