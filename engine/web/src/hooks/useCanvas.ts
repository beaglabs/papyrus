import type { CanvasNodeDoc, EdgeDoc } from '@papyrus/core/nodes/types'
import { applyEdgeChanges, applyNodeChanges, type EdgeChange, type NodeChange } from '@xyflow/react'
import { useCallback, useEffect, useState } from 'react'

type ApiFetch = (path: string, init?: RequestInit) => Promise<Response>

export interface CanvasState {
  nodes: CanvasNodeDoc[]
  edges: EdgeDoc[]
  loading: boolean
  /** Optimistic upsert — updates local state immediately, then persists. */
  upsertNode: (doc: CanvasNodeDoc) => void
  deleteNode: (id: string) => void
  addEdge: (edge: EdgeDoc) => void
  deleteEdge: (id: string) => void
  /** React Flow controlled-flow handler — applies position/select/remove changes locally. */
  onNodesChange: (changes: NodeChange[]) => void
  onEdgesChange: (changes: EdgeChange[]) => void
  /** Direct setter for cases that need to mutate local state without persistence. */
  setNodes: React.Dispatch<React.SetStateAction<CanvasNodeDoc[]>>
}

interface ProjectResponse {
  nodes: CanvasNodeDoc[]
  edges: EdgeDoc[]
}

/**
 * useCanvas — REST-backed canvas state.
 *
 * Loads the project's nodes/edges on mount via GET /api/projects/:id, then
 * pushes mutations through dedicated REST endpoints. No WebSocket, no
 * presence, no outbox, no CRDTs — just local state + server persistence.
 *
 * Dragging works because position changes are applied locally by
 * `onNodesChange` and only persisted on drag-end (the caller decides when to
 * call `upsertNode`).
 */
export function useCanvas(projectId: string, apiFetch: ApiFetch): CanvasState {
  const [nodes, setNodes] = useState<CanvasNodeDoc[]>([])
  const [edges, setEdges] = useState<EdgeDoc[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    apiFetch(`/api/projects/${encodeURIComponent(projectId)}`)
      .then((res) => (res.ok ? (res.json() as Promise<ProjectResponse>) : null))
      .then((data) => {
        if (cancelled || !data) return
        setNodes(data.nodes ?? [])
        setEdges(data.edges ?? [])
      })
      .catch((err) => console.error('useCanvas load failed', err))
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [projectId, apiFetch])

  const upsertNode = useCallback(
    (doc: CanvasNodeDoc) => {
      setNodes((prev) => {
        const idx = prev.findIndex((n) => n.id === doc.id)
        if (idx >= 0) {
          const next = [...prev]
          next[idx] = doc
          return next
        }
        return [...prev, doc]
      })
      void apiFetch(`/api/projects/${encodeURIComponent(projectId)}/nodes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(doc),
      }).catch((err) => console.error('upsertNode failed', err))
    },
    [apiFetch, projectId],
  )

  const deleteNode = useCallback(
    (id: string) => {
      setNodes((prev) => prev.filter((n) => n.id !== id))
      setEdges((prev) => prev.filter((e) => e.from !== id && e.to !== id))
      void apiFetch(`/api/projects/${encodeURIComponent(projectId)}/nodes/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }).catch((err) => console.error('deleteNode failed', err))
    },
    [apiFetch, projectId],
  )

  const addEdge = useCallback(
    (edge: EdgeDoc) => {
      setEdges((prev) => (prev.some((e) => e.id === edge.id) ? prev : [...prev, edge]))
      void apiFetch(`/api/projects/${encodeURIComponent(projectId)}/edges`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(edge),
      }).catch((err) => console.error('addEdge failed', err))
    },
    [apiFetch, projectId],
  )

  const deleteEdge = useCallback(
    (id: string) => {
      setEdges((prev) => prev.filter((e) => e.id !== id))
      void apiFetch(`/api/projects/${encodeURIComponent(projectId)}/edges/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }).catch((err) => console.error('deleteEdge failed', err))
    },
    [apiFetch, projectId],
  )

  // React Flow change handlers. We round-trip through RF node shape because
  // our state stores CanvasNodeDoc (application data), not RF Node objects.
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes((prev) => {
      const rfNodes = prev.map((n) => ({
        id: n.id,
        type: 'canvasNode',
        position: n.position,
        data: n as unknown as Record<string, unknown>,
      }))
      const next = applyNodeChanges(changes, rfNodes)
      return next.map((rn) => {
        const doc = prev.find((n) => n.id === rn.id)
        return doc ? { ...doc, position: rn.position } : (rn.data as unknown as CanvasNodeDoc)
      })
    })
  }, [])

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setEdges((prev) => {
      const rfEdges = prev.map((e) => ({
        id: e.id,
        source: e.from,
        target: e.to,
        type: 'smoothstep' as const,
      }))
      const next = applyEdgeChanges(changes, rfEdges)
      return next
        .map((re) => prev.find((e) => e.id === re.id))
        .filter((e): e is EdgeDoc => Boolean(e))
    })
  }, [])

  return {
    nodes,
    edges,
    loading,
    upsertNode,
    deleteNode,
    addEdge,
    deleteEdge,
    onNodesChange,
    onEdgesChange,
    setNodes,
  }
}
