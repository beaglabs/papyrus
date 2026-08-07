import type { CanvasNodeDoc, EdgeDoc } from '@papyrus/core/nodes/types'
import type { ClientMsg, PresenceInfo, ServerMsg } from '@papyrus/core/sync/protocol'
import { type EdgeChange, type NodeChange, applyEdgeChanges, applyNodeChanges } from '@xyflow/react'
/**
 * useCanvasSync — WebSocket hook that syncs the local ReactFlow state with
 * the daemon. Receives server messages, applies mutations to local state,
 * and sends client mutations.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

const HEARTBEAT_MS = 15_000

export interface CanvasSyncState {
  nodes: CanvasNodeDoc[]
  edges: EdgeDoc[]
  connected: boolean
  upsertNode: (doc: CanvasNodeDoc) => void
  deleteNode: (id: string) => void
  addEdge: (edge: EdgeDoc) => void
  deleteEdge: (id: string) => void
  onNodesChange: (changes: NodeChange[]) => void
  onEdgesChange: (changes: EdgeChange[]) => void
  sendCursor: (x: number, y: number) => void
  setNodes: React.Dispatch<React.SetStateAction<CanvasNodeDoc[]>>
  send: (msg: ClientMsg) => void
}

export function useCanvasSync(
  projectId: string,
  peerId: string,
  displayName: string,
  color: string,
): CanvasSyncState {
  const wsRef = useRef<WebSocket | null>(null)
  const [nodes, setNodes] = useState<CanvasNodeDoc[]>([])
  const [edges, setEdges] = useState<EdgeDoc[]>([])
  const [connected, setConnected] = useState(false)
  const nodesRef = useRef(nodes)
  nodesRef.current = nodes
  const edgesRef = useRef(edges)
  edgesRef.current = edges

  // ── Send helper ──────────────────────────────────────────────

  const send = useCallback((msg: ClientMsg) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg))
    }
  }, [])

  // ── Server message handler ───────────────────────────────────

  useEffect(() => {
    const url = new URL(window.location.href)
    const proto = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${proto}//${url.hostname}:${url.port}/ws?project=${projectId}`

    let heartbeat: ReturnType<typeof setInterval>
    let reconnectAttempts = 0
    const MAX_RECONNECT_DELAY = 30_000

    function connect() {
      const ws = new WebSocket(wsUrl)
      wsRef.current = ws

      ws.onopen = () => {
        setConnected(true)
        reconnectAttempts = 0 // Reset on successful connection
        send({ type: 'presence:heartbeat', data: { peerId, displayName, color } })
        heartbeat = setInterval(() => {
          send({ type: 'presence:heartbeat', data: { peerId, displayName, color } })
        }, HEARTBEAT_MS)
      }

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data as string) as ServerMsg
        // Dispatch presence events for the usePresence hook
        window.dispatchEvent(new CustomEvent('papyrus:presence', { detail: msg }))

        switch (msg.type) {
          case 'canvas:state':
            setNodes(msg.data.nodes)
            setEdges(msg.data.edges)
            break
          case 'node:upsert': {
            setNodes((prev) => {
              const idx = prev.findIndex((n) => n.id === msg.data.id)
              if (idx >= 0) {
                const next = [...prev]
                next[idx] = msg.data
                return next
              }
              return [...prev, msg.data]
            })
            break
          }
          case 'node:delete':
            setNodes((prev) => prev.filter((n) => n.id !== msg.data.id))
            break
          case 'edge:add':
            setEdges((prev) => {
              if (prev.find((e) => e.id === msg.data.id)) return prev
              return [...prev, msg.data]
            })
            break
          case 'edge:delete':
            setEdges((prev) => prev.filter((e) => e.id !== msg.data.id))
            break
          default:
            break
        }
      }

      ws.onclose = () => {
        setConnected(false)
        clearInterval(heartbeat)
        // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s max
        const delay = Math.min(1000 * 2 ** reconnectAttempts, MAX_RECONNECT_DELAY)
        reconnectAttempts++
        setTimeout(connect, delay)
      }

      ws.onerror = () => {
        ws.close()
      }
    }

    connect()

    return () => {
      clearInterval(heartbeat)
      wsRef.current?.close()
    }
  }, [projectId, peerId, displayName, color, send])

  // ── Local mutation handlers ──────────────────────────────────

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
      send({ type: 'node:upsert', data: doc })
    },
    [send],
  )

  const deleteNode = useCallback(
    (id: string) => {
      setNodes((prev) => prev.filter((n) => n.id !== id))
      send({ type: 'node:delete', data: { id } })
    },
    [send],
  )

  const addEdge = useCallback(
    (edge: EdgeDoc) => {
      setEdges((prev) => {
        if (prev.find((e) => e.id === edge.id)) return prev
        return [...prev, edge]
      })
      send({ type: 'edge:add', data: edge })
    },
    [send],
  )

  const deleteEdge = useCallback(
    (id: string) => {
      setEdges((prev) => prev.filter((e) => e.id !== id))
      send({ type: 'edge:delete', data: { id } })
    },
    [send],
  )

  // ── ReactFlow change handlers ────────────────────────────────

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      setNodes((prev) => {
        const rfNodes = prev.map((n) => ({
          id: n.id,
          type: 'canvasNode' as const,
          position: n.position,
          data: n as unknown as Record<string, unknown>,
        }))
        const next = applyNodeChanges(changes, rfNodes)
        return next.map((rn) => {
          const doc = nodesRef.current.find((n) => n.id === rn.id)
          if (!doc) return rn.data as unknown as CanvasNodeDoc
          return { ...doc, position: rn.position }
        })
      })
      for (const change of changes) {
        if (change.type === 'position' && change.position && change.dragging) {
          const doc = nodesRef.current.find((n) => n.id === change.id)
          if (doc) {
            const updated = { ...doc, position: change.position, updatedAt: Date.now() }
            send({ type: 'node:upsert', data: updated })
          }
        }
      }
    },
    [send],
  )

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      setEdges((prev) => {
        return applyEdgeChanges(
          changes,
          prev.map((e) => ({
            id: e.id,
            source: e.from,
            target: e.to,
            type: 'smoothstep',
          })),
        ).map((re) => {
          const doc = edgesRef.current.find((e) => e.id === re.id)
          return (
            doc ?? {
              id: re.id,
              projectId,
              from: re.source,
              to: re.target,
              kind: 'flow',
              createdBy: peerId,
              updatedAt: Date.now(),
            }
          )
        })
      })
    },
    [projectId, peerId],
  )

  const sendCursor = useCallback(
    (x: number, y: number) => {
      send({ type: 'cursor:move', data: { x, y } })
    },
    [send],
  )

  return {
    nodes,
    edges,
    connected,
    upsertNode,
    deleteNode,
    addEdge,
    deleteEdge,
    onNodesChange,
    onEdgesChange,
    sendCursor,
    setNodes,
    send,
  }
}
