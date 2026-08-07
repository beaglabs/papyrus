/**
 * Project store — file-based persistence (legacy, superseded by database.ts SQLite backend).
 *
 * Kept for reference. The daemon now uses database.ts for all project CRUD.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CanvasNodeDoc, EdgeDoc } from '@papyrus/core/nodes/types'

const PROJECTS_DIR = join(process.env.HOME ?? '~', '.papyrus', 'projects')

export interface ProjectData {
  id: string
  name: string
  createdAt: string
  nodes: CanvasNodeDoc[]
  edges: EdgeDoc[]
}

interface ProjectFile {
  id: string
  name: string
  createdAt: string
  nodesFile: string
  edgesFile: string
}

function projectDir(id: string): string {
  return join(PROJECTS_DIR, id)
}

function projectMetaPath(id: string): string {
  return join(projectDir(id), 'project.json')
}

function nodesPath(id: string): string {
  return join(projectDir(id), 'nodes.json')
}

function edgesPath(id: string): string {
  return join(projectDir(id), 'edges.json')
}

/** List all known projects. */
export function listProjects(): ProjectData[] {
  if (!existsSync(PROJECTS_DIR)) return []
  const dirs = readdirSync(PROJECTS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
  return dirs
    .filter((id) => existsSync(projectMetaPath(id)))
    .map((id) => {
      const meta = JSON.parse(readFileSync(projectMetaPath(id), 'utf-8')) as ProjectFile
      const nodes = existsSync(nodesPath(id))
        ? (JSON.parse(readFileSync(nodesPath(id), 'utf-8')) as CanvasNodeDoc[])
        : []
      const edges = existsSync(edgesPath(id))
        ? (JSON.parse(readFileSync(edgesPath(id), 'utf-8')) as EdgeDoc[])
        : []
      return { id: meta.id, name: meta.name, createdAt: meta.createdAt, nodes, edges }
    })
}

/** Create a new project. */
export function createProject(name: string): ProjectData {
  const id = `proj-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const dir = projectDir(id)
  mkdirSync(dir, { recursive: true })

  const meta: ProjectFile = {
    id,
    name,
    createdAt: new Date().toISOString(),
    nodesFile: nodesPath(id),
    edgesFile: edgesPath(id),
  }
  writeFileSync(projectMetaPath(id), JSON.stringify(meta, null, 2), 'utf-8')
  writeFileSync(nodesPath(id), '[]', 'utf-8')
  writeFileSync(edgesPath(id), '[]', 'utf-8')

  return { id, name, createdAt: meta.createdAt, nodes: [], edges: [] }
}

/** Load a project from disk. */
export function loadProject(id: string): ProjectData | null {
  if (!existsSync(projectMetaPath(id))) return null
  const meta = JSON.parse(readFileSync(projectMetaPath(id), 'utf-8')) as ProjectFile
  const nodes = existsSync(nodesPath(id))
    ? (JSON.parse(readFileSync(nodesPath(id), 'utf-8')) as CanvasNodeDoc[])
    : []
  const edges = existsSync(edgesPath(id))
    ? (JSON.parse(readFileSync(edgesPath(id), 'utf-8')) as EdgeDoc[])
    : []
  return { id: meta.id, name: meta.name, createdAt: meta.createdAt, nodes, edges }
}

/** Save canvas state to disk. */
export function saveCanvas(id: string, nodes: CanvasNodeDoc[], edges: EdgeDoc[]): void {
  if (!existsSync(projectDir(id))) return
  writeFileSync(nodesPath(id), JSON.stringify(nodes, null, 2), 'utf-8')
  writeFileSync(edgesPath(id), JSON.stringify(edges, null, 2), 'utf-8')
}
