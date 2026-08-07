import { afterAll, describe, expect, it } from 'vitest'
import {
  closeDb,
  commitCanvasOperation,
  createProject,
  deleteProject,
  getStoredOperations,
  listProjects,
  loadProject,
  saveCanvas,
} from '../src/database.js'

afterAll(() => closeDb())

describe('Database', () => {
  describe('createProject', () => {
    it('should create a project with auto-generated id', () => {
      const project = createProject('Test Project')

      expect(project.id).toMatch(/^proj-/)
      expect(project.name).toBe('Test Project')
      expect(project.createdAt).toBeTruthy()
      expect(project.nodes).toEqual([])
      expect(project.edges).toEqual([])
    })
  })

  describe('listProjects', () => {
    it('should list all projects', () => {
      const project = createProject('Listed Project')

      const projects = listProjects()
      expect(projects.some((p) => p.id === project.id)).toBe(true)
    })
  })

  describe('loadProject', () => {
    it('should load a project by id', () => {
      const created = createProject('Loaded Project')

      const project = loadProject(created.id)
      expect(project).toBeTruthy()
      expect(project?.id).toBe(created.id)
      expect(project?.name).toBe('Loaded Project')
    })

    it('should return null for non-existent project', () => {
      const project = loadProject('non-existent-id')
      expect(project).toBeNull()
    })
  })

  describe('deleteProject', () => {
    it('should delete a project', () => {
      const created = createProject('Delete Me')

      const deleted = deleteProject(created.id)
      expect(deleted).toBe(true)

      const project = loadProject(created.id)
      expect(project).toBeNull()
    })

    it('should return false for non-existent project', () => {
      const deleted = deleteProject('non-existent-id')
      expect(deleted).toBe(false)
    })
  })

  describe('saveCanvas', () => {
    it('should save and reload canvas state', () => {
      const created = createProject('Canvas Project')
      const nodeId = `n-${Date.now()}`
      const edgeId = `e-${Date.now()}`

      const nodes = [
        {
          id: nodeId,
          projectId: created.id,
          type: 'feature',
          category: 'strategy' as const,
          flowRole: 'artifact' as const,
          position: { x: 100, y: 200 },
          fields: { title: 'Test Node' },
          status: 'draft' as const,
          createdBy: 'user-1',
          updatedAt: Date.now(),
        },
        {
          id: 'n-target',
          projectId: created.id,
          type: 'feature',
          category: 'strategy' as const,
          flowRole: 'artifact' as const,
          position: { x: 300, y: 200 },
          fields: { title: 'Target Node' },
          status: 'draft' as const,
          createdBy: 'user-1',
          updatedAt: Date.now(),
        },
      ]
      const edges = [
        {
          id: edgeId,
          projectId: created.id,
          from: nodeId,
          to: 'n-target',
          kind: 'flow',
          createdBy: 'user-1',
          updatedAt: Date.now(),
        },
      ]

      saveCanvas(created.id, nodes, edges)

      const project = loadProject(created.id)
      expect(project).toBeTruthy()
      expect(project?.nodes.length).toBe(2)
      expect(project?.nodes[0]?.id).toBe(nodeId)
      expect(project?.edges.length).toBe(1)
      expect(project?.edges[0]?.id).toBe(edgeId)
    })
  })

  describe('authoritative operations', () => {
    it('sequences and deduplicates mutations', () => {
      const project = createProject('Operation Project')
      const node = {
        id: `n-${Date.now()}`,
        projectId: project.id,
        type: 'specification',
        category: 'output' as const,
        flowRole: 'source' as const,
        position: { x: 0, y: 0 },
        fields: { title: 'Spec', content: '' },
        status: 'draft' as const,
        createdBy: 'member-1',
        updatedAt: Date.now(),
      }
      const input = {
        id: `op-${Date.now()}`,
        projectId: project.id,
        actorKey: 'member-1',
        entityType: 'node' as const,
        entityId: node.id,
        operationType: 'create' as const,
        payload: node,
        baseRevision: 0,
      }

      const accepted = commitCanvasOperation(input, [node], [])
      const duplicate = commitCanvasOperation(input, [node], [])

      expect(accepted.projectRevision).toBe(1)
      expect(accepted.duplicate).toBe(false)
      expect(duplicate).toEqual({ ...accepted, duplicate: true })
      expect(getStoredOperations(project.id)).toHaveLength(1)
      expect(loadProject(project.id)?.revision).toBe(1)
    })
  })
})
