import type { CanvasNodeDoc, EdgeDoc } from '@papyrus/core/nodes/types'
import type { ClientMsg, PresenceInfo, ServerMsg } from '@papyrus/core/sync/protocol'
import { type EdgeChange, type NodeChange, applyEdgeChanges, applyNodeChanges } from '@xyflow/react'
/**
 * useCanvasSync — WebSocket hook that syncs the local ReactFlow state with
 * the daemon. Receives server messages, applies mutations to local state,
 * and sends client mutations.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import * as Y from 'yjs'
import { acknowledgeOperation, listQueuedOperations, queueOperation } from '../lib/outbox'

const HEARTBEAT_MS = 15_000

export interface CanvasSyncState {
  nodes: CanvasNodeDoc[]
  edges: EdgeDoc[]
  connected: boolean
  pendingOperations: number
  syncStatus: 'offline' | 'syncing' | 'synced' | 'conflict'
  upsertNode: (doc: CanvasNodeDoc) => void
  deleteNode: (id: string) => void
  addEdge: (edge: EdgeDoc) => void
  deleteEdge: (id: string) => void
  onNodesChange: (changes: NodeChange[]) => void
  onEdgesChange: (changes: EdgeChange[]) => void
  sendCursor: (x: number, y: number) => void
  updateDocumentText: (nodeId: string, current: string, next: string) => void
  setNodes: React.Dispatch<React.SetStateAction<CanvasNodeDoc[]>>
  send: (msg: ClientMsg) => void
}

export function useCanvasSync(
  projectId: string,
  peerId: string,
  displayName: string,
  color: string,
  token: string | null,
): CanvasSyncState {
  const wsRef = useRef<WebSocket | null>(null)
  const [nodes, setNodes] = useState<CanvasNodeDoc[]>([])
  const [edges, setEdges] = useState<EdgeDoc[]>([])
  const [connected, setConnected] = useState(false)
  const [pendingOperations, setPendingOperations] = useState(0)
  const [syncStatus, setSyncStatus] = useState<CanvasSyncState['syncStatus']>('offline')
  const revisionRef = useRef(0)
  const documentsRef = useRef(new Map<string, Y.Doc>())
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

  const flushOutbox = useCallback(async () => {
    const queued = await listQueuedOperations(projectId)
    setPendingOperations(queued.length)
    if (queued.length > 0) setSyncStatus('syncing')
    for (const item of queued) send(item.message)
  }, [projectId, send])

  const queueMutation = useCallback(
    async (message: ClientMsg) => {
      await queueOperation(projectId, message)
      setPendingOperations((count) => count + 1)
      setSyncStatus(connected ? 'syncing' : 'offline')
      send(message)
    },
    [projectId, connected, send],
  )

  // ── Server message handler ───────────────────────────────────

  useEffect(() => {
    const url = new URL(window.location.href)
    const proto = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${proto}//${url.host}/ws?project=${encodeURIComponent(projectId)}`

    let heartbeat: ReturnType<typeof setInterval>
    let reconnectAttempts = 0
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined
    let disposed = false
    const MAX_RECONNECT_DELAY = 30_000

    function connect() {
      const protocols = token ? ['papyrus-v1', `papyrus-token.${token}`] : ['papyrus-v1']
      const ws = new WebSocket(wsUrl, protocols)
      wsRef.current = ws

      ws.onopen = () => {
        setConnected(true)
        setSyncStatus('syncing')
        reconnectAttempts = 0 // Reset on successful connection
        send({ type: 'presence:heartbeat', data: { peerId, displayName, color } })
        heartbeat = setInterval(() => {
          send({ type: 'presence:heartbeat', data: { peerId, displayName, color } })
        }, HEARTBEAT_MS)
        void flushOutbox()
      }

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data as string) as ServerMsg
        // Dispatch presence events for the usePresence hook
        window.dispatchEvent(new CustomEvent('papyrus:presence', { detail: msg }))

        switch (msg.type) {
          case 'canvas:state':
            revisionRef.current = msg.data.revision
            setNodes(msg.data.nodes)
            setEdges(msg.data.edges)
            void flushOutbox()
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
          case 'operation:ack':
            revisionRef.current = Math.max(revisionRef.current, msg.data.projectRevision)
            void acknowledgeOperation(projectId, msg.data.operationId).then(async () => {
              const queued = await listQueuedOperations(projectId)
              setPendingOperations(queued.length)
              setSyncStatus(queued.length === 0 ? 'synced' : 'syncing')
            })
            break
          case 'operation:reject':
            revisionRef.current = Math.max(revisionRef.current, msg.data.projectRevision)
            setSyncStatus('conflict')
            window.dispatchEvent(new CustomEvent('papyrus:sync-conflict', { detail: msg.data }))
            break
          case 'document:sync': {
            let doc = documentsRef.current.get(msg.data.nodeId)
            if (!doc) {
              doc = new Y.Doc()
              documentsRef.current.set(msg.data.nodeId, doc)
            }
            Y.applyUpdate(
              doc,
              Uint8Array.from(atob(msg.data.update), (char) => char.charCodeAt(0)),
              'remote',
            )
            const content = doc.getText('content').toString()
            setNodes((previous) =>
              previous.map((node) =>
                node.id === msg.data.nodeId
                  ? { ...node, fields: { ...node.fields, content } }
                  : node,
              ),
            )
            revisionRef.current = Math.max(revisionRef.current, msg.data.revision)
            break
          }
          default:
            break
        }
      }

      ws.onclose = () => {
        setConnected(false)
        setSyncStatus('offline')
        clearInterval(heartbeat)
        // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s max
        const delay = Math.min(1000 * 2 ** reconnectAttempts, MAX_RECONNECT_DELAY)
        reconnectAttempts++
        if (!disposed) reconnectTimer = setTimeout(connect, delay)
      }

      ws.onerror = () => {
        ws.close()
      }
    }

    connect()

    return () => {
      disposed = true
      clearInterval(heartbeat)
      if (reconnectTimer) clearTimeout(reconnectTimer)
      wsRef.current?.close()
    }
  }, [projectId, peerId, displayName, color, token, send, flushOutbox])

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
      void queueMutation({
        type: 'node:upsert',
        data: doc,
        operationId: crypto.randomUUID(),
        baseRevision: revisionRef.current,
      })
    },
    [queueMutation],
  )

  const deleteNode = useCallback(
    (id: string) => {
      setNodes((prev) => prev.filter((n) => n.id !== id))
      void queueMutation({
        type: 'node:delete',
        data: { id },
        operationId: crypto.randomUUID(),
        baseRevision: revisionRef.current,
      })
    },
    [queueMutation],
  )

  const addEdge = useCallback(
    (edge: EdgeDoc) => {
      setEdges((prev) => {
        if (prev.find((e) => e.id === edge.id)) return prev
        return [...prev, edge]
      })
      void queueMutation({
        type: 'edge:add',
        data: edge,
        operationId: crypto.randomUUID(),
        baseRevision: revisionRef.current,
      })
    },
    [queueMutation],
  )

  const deleteEdge = useCallback(
    (id: string) => {
      setEdges((prev) => prev.filter((e) => e.id !== id))
      void queueMutation({
        type: 'edge:delete',
        data: { id },
        operationId: crypto.randomUUID(),
        baseRevision: revisionRef.current,
      })
    },
    [queueMutation],
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
        if (change.type === 'position' && change.position && change.dragging === false) {
          const doc = nodesRef.current.find((n) => n.id === change.id)
          if (doc) {
            const updated = { ...doc, position: change.position, updatedAt: Date.now() }
            void queueMutation({
              type: 'node:upsert',
              data: updated,
              operationId: crypto.randomUUID(),
              baseRevision: revisionRef.current,
            })
          }
        }
      }
    },
    [queueMutation],
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

  const updateDocumentText = useCallback(
    (nodeId: string, current: string, next: string) => {
      let doc = documentsRef.current.get(nodeId)
      const isNewDocument = !doc
      if (!doc) {
        doc = new Y.Doc()
        doc.getText('content').insert(0, current)
        documentsRef.current.set(nodeId, doc)
      }
      const text = doc.getText('content')
      const actual = text.toString()
      let prefix = 0
      while (prefix < actual.length && prefix < next.length && actual[prefix] === next[prefix])
        prefix++
      let suffix = 0
      while (
        suffix < actual.length - prefix &&
        suffix < next.length - prefix &&
        actual[actual.length - 1 - suffix] === next[next.length - 1 - suffix]
      ) {
        suffix++
      }

      const updates: Uint8Array[] = []
      const listener = (update: Uint8Array, origin: unknown) => {
        if (origin === 'local') updates.push(update)
      }
      doc.on('update', listener)
      doc.transact(() => {
        const removeLength = actual.length - prefix - suffix
        if (removeLength > 0) text.delete(prefix, removeLength)
        const inserted = next.slice(prefix, next.length - suffix)
        if (inserted) text.insert(prefix, inserted)
      }, 'local')
      doc.off('update', listener)
      if (updates.length === 0) return
      const merged = isNewDocument ? Y.encodeStateAsUpdate(doc) : Y.mergeUpdates(updates)
      let binary = ''
      for (const byte of merged) binary += String.fromCharCode(byte)
      void queueMutation({
        type: 'document:sync',
        data: { nodeId, update: btoa(binary) },
        operationId: crypto.randomUUID(),
        baseRevision: revisionRef.current,
      })
      setNodes((previous) =>
        previous.map((node) =>
          node.id === nodeId ? { ...node, fields: { ...node.fields, content: next } } : node,
        ),
      )
    },
    [queueMutation],
  )

  return {
    nodes,
    edges,
    connected,
    pendingOperations,
    syncStatus,
    upsertNode,
    deleteNode,
    addEdge,
    deleteEdge,
    onNodesChange,
    onEdgesChange,
    sendCursor,
    updateDocumentText,
    setNodes,
    send,
  }
}
