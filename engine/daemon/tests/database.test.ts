import { describe, it, expect } from 'vitest'
import {
  createProject,
  listProjects,
  loadProject,
  deleteProject,
  saveCanvas,
} from '../src/database.js'

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
      expect(project!.id).toBe(created.id)
      expect(project!.name).toBe('Loaded Project')
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
      expect(project!.nodes.length).toBe(1)
      expect(project!.nodes[0]!.id).toBe(nodeId)
      expect(project!.edges.length).toBe(1)
      expect(project!.edges[0]!.id).toBe(edgeId)
    })
  })
})
