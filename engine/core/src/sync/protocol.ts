/**
 * WebSocket message protocol for real-time canvas sync + presence.
 *
 * Server is the authority: it writes to the CRDT store and broadcasts to all
 * connected clients. Clients send mutations; the server validates and applies.
 *
 * Presence is ephemeral (not persisted in the CRDT). The server tracks who's
 * connected and broadcasts presence updates.
 */
import type { CanvasNodeDoc, EdgeDoc } from '../nodes/types.js'

/** Presence info for a connected peer. */
export interface PresenceInfo {
  peerId: string
  displayName: string
  color: string
  /** ISO timestamp of last heartbeat. */
  lastSeen: string
}

// ── Server → Client ──────────────────────────────────────────────

export interface CanvasStateMsg {
  type: 'canvas:state'
  data: {
    nodes: CanvasNodeDoc[]
    edges: EdgeDoc[]
    presence: PresenceInfo[]
    revision: number
  }
}

export interface NodeUpsertMsg {
  type: 'node:upsert'
  data: CanvasNodeDoc
}

export interface NodeDeleteMsg {
  type: 'node:delete'
  data: { id: string }
}

export interface EdgeAddMsg {
  type: 'edge:add'
  data: EdgeDoc
}

export interface EdgeDeleteMsg {
  type: 'edge:delete'
  data: { id: string }
}

export interface PresenceUpdateMsg {
  type: 'presence:update'
  data: PresenceInfo
}

export interface PresenceLeaveMsg {
  type: 'presence:leave'
  data: { peerId: string }
}

export interface CursorUpdateMsg {
  type: 'cursor:update'
  data: { peerId: string; x: number; y: number; displayName: string; color: string }
}

export interface CursorLeaveMsg {
  type: 'cursor:leave'
  data: { peerId: string }
}

export interface OperationAckMsg {
  type: 'operation:ack'
  data: { operationId: string; projectRevision: number; duplicate?: boolean }
}

export interface OperationRejectMsg {
  type: 'operation:reject'
  data: { operationId: string; code: string; message: string; projectRevision: number }
}

export interface DocumentSyncMsg {
  type: 'document:sync'
  data: { nodeId: string; update: string; revision: number }
}

export type ServerMsg =
  | CanvasStateMsg
  | NodeUpsertMsg
  | NodeDeleteMsg
  | EdgeAddMsg
  | EdgeDeleteMsg
  | PresenceUpdateMsg
  | PresenceLeaveMsg
  | CursorUpdateMsg
  | CursorLeaveMsg
  | OperationAckMsg
  | OperationRejectMsg
  | DocumentSyncMsg

// ── Client → Server ──────────────────────────────────────────────

export interface ClientNodeUpsertMsg {
  type: 'node:upsert'
  data: CanvasNodeDoc
  operationId?: string
  baseRevision?: number
}

export interface ClientNodeDeleteMsg {
  type: 'node:delete'
  data: { id: string }
  operationId?: string
  baseRevision?: number
}

export interface ClientEdgeAddMsg {
  type: 'edge:add'
  data: EdgeDoc
  operationId?: string
  baseRevision?: number
}

export interface ClientEdgeDeleteMsg {
  type: 'edge:delete'
  data: { id: string }
  operationId?: string
  baseRevision?: number
}

export interface ClientPresenceHeartbeatMsg {
  type: 'presence:heartbeat'
  data: { peerId: string; displayName: string; color: string }
}

export interface ClientCursorMoveMsg {
  type: 'cursor:move'
  data: { x: number; y: number }
}

export interface ClientDocumentSyncMsg {
  type: 'document:sync'
  data: { nodeId: string; update: string }
  operationId?: string
  baseRevision?: number
}

export type ClientMsg =
  | ClientNodeUpsertMsg
  | ClientNodeDeleteMsg
  | ClientEdgeAddMsg
  | ClientEdgeDeleteMsg
  | ClientPresenceHeartbeatMsg
  | ClientCursorMoveMsg
  | ClientDocumentSyncMsg

/** Assigned avatar colors for presence (neobrutalist palette). */
export const PRESENCE_COLORS = [
  '#ff5f1f', // orange (accent)
  '#111111', // ink
  '#444444', // gray-700
  '#ff7a1a', // accent-hot
  '#8c8c8c', // gray-500
  '#c9c9c9', // gray-300
] as const
