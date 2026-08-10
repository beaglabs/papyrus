import type { CanvasNodeDoc, EdgeDoc } from '@papyrus/core/nodes/types'
import { type EdgeChange, type NodeChange, applyEdgeChanges, applyNodeChanges } from '@xyflow/react'
import { useCallback, useEffect, useRef, useState } from 'react'

type ApiFetch = (path: string, init?: RequestInit) => Promise<Response>

export interface CanvasState {
  nodes: CanvasNodeDoc[]
  edges: EdgeDoc[]
  loading: boolean
  saving: boolean
  /** Reload the authoritative canvas after an agent/server-side mutation. */
  refresh: () => Promise<void>
  /** Persist the final position after React Flow completes a drag. */
  persistNodePosition: (id: string, position: { x: number; y: number }) => void
  /** Optimistic upsert — updates local state immediately, then persists. */
  upsertNode: (doc: CanvasNodeDoc) => void
  deleteNode: (id: string) => void
  addEdge: (edge: EdgeDoc) => void
  deleteEdge: (id: string) => void
  /** React Flow controlled-flow handler — applies position/select/remove changes locally. */
  onNodesChange: (changes: NodeChange[]) => void
  onEdgesChange: (changes: EdgeChange[]) => void
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
 * `onNodesChange` and only persisted on drag-end.
 */
export function useCanvas(projectId: string, apiFetch: ApiFetch): CanvasState {
  const [nodes, setNodes] = useState<CanvasNodeDoc[]>([])
  const [edges, setEdges] = useState<EdgeDoc[]>([])
  const [loading, setLoading] = useState(true)
  const [pendingMutations, setPendingMutations] = useState(0)
  const nodesRef = useRef(nodes)
  nodesRef.current = nodes

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const response = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}`)
      if (!response.ok) throw new Error(`Canvas load failed (${response.status})`)
      const data = (await response.json()) as ProjectResponse
      setNodes(data.nodes ?? [])
      setEdges(data.edges ?? [])
    } finally {
      setLoading(false)
    }
  }, [apiFetch, projectId])

  const persist = useCallback(
    async (path: string, init: RequestInit) => {
      setPendingMutations((count) => count + 1)
      try {
        const response = await apiFetch(path, init)
        if (!response.ok) throw new Error(`Canvas mutation failed (${response.status})`)
      } catch (error) {
        void refresh().catch((refreshError) =>
          console.error('Canvas reconciliation failed', refreshError),
        )
        throw error
      } finally {
        setPendingMutations((count) => Math.max(0, count - 1))
      }
    },
    [apiFetch, refresh],
  )

  useEffect(() => {
    let cancelled = false
    void refresh().catch((error) => {
      if (!cancelled) console.error('useCanvas load failed', error)
    })
    return () => {
      cancelled = true
    }
  }, [refresh])

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
      void persist(`/api/projects/${encodeURIComponent(projectId)}/nodes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(doc),
      }).catch((err) => console.error('upsertNode failed', err))
    },
    [persist, projectId],
  )

  const deleteNode = useCallback(
    (id: string) => {
      setNodes((prev) => prev.filter((n) => n.id !== id))
      setEdges((prev) => prev.filter((e) => e.from !== id && e.to !== id))
      void persist(
        `/api/projects/${encodeURIComponent(projectId)}/nodes/${encodeURIComponent(id)}`,
        {
          method: 'DELETE',
        },
      ).catch((err) => console.error('deleteNode failed', err))
    },
    [persist, projectId],
  )

  const persistNodePosition = useCallback(
    (id: string, position: { x: number; y: number }) => {
      const current = nodesRef.current.find((node) => node.id === id)
      if (!current) return
      const doc = { ...current, position, updatedAt: Date.now() }
      setNodes((previous) => previous.map((node) => (node.id === id ? doc : node)))
      void persist(`/api/projects/${encodeURIComponent(projectId)}/nodes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(doc),
      }).catch((error) => console.error('persistNodePosition failed', error))
    },
    [persist, projectId],
  )

  const addEdge = useCallback(
    (edge: EdgeDoc) => {
      setEdges((prev) => (prev.some((e) => e.id === edge.id) ? prev : [...prev, edge]))
      void persist(`/api/projects/${encodeURIComponent(projectId)}/edges`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(edge),
      }).catch((err) => console.error('addEdge failed', err))
    },
    [persist, projectId],
  )

  const deleteEdge = useCallback(
    (id: string) => {
      setEdges((prev) => prev.filter((e) => e.id !== id))
      void persist(
        `/api/projects/${encodeURIComponent(projectId)}/edges/${encodeURIComponent(id)}`,
        {
          method: 'DELETE',
        },
      ).catch((err) => console.error('deleteEdge failed', err))
    },
    [persist, projectId],
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
    saving: pendingMutations > 0,
    refresh,
    persistNodePosition,
    upsertNode,
    deleteNode,
    addEdge,
    deleteEdge,
    onNodesChange,
    onEdgesChange,
  }
}
