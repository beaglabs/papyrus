/**
 * PapyrusNetwork — Iroh-based P2P networking layer.
 *
 * Handles:
 * - Endpoint creation and identity
 * - Project announcement and discovery
 * - Peer-to-peer sync over QUIC streams
 * - Network health monitoring
 *
 * Protocol:
 * - ALPN: "papyrus/1" (UTF-8 bytes)
 * - On connect, peers exchange project lists
 * - On project change, peers broadcast updates
 */
import {
  type BiStream,
  type Connection,
  Endpoint,
  EndpointAddr,
  EndpointId,
  EndpointTicket,
  presetN0,
} from '@number0/iroh'

const ALPN = Array.from(new TextEncoder().encode('papyrus/1'))

/** Project metadata broadcast on the network. */
export interface NetworkProject {
  id: string
  name: string
  ownerId: string
  nodeCount: number
  updatedAt: number
}

/** Info about a connected peer. */
export interface PeerInfo {
  id: string
  addr: string | null
  relayUrl: string | null
  rtt: number | null
  connectedAt: number
}

/** Network health stats. */
export interface NetworkStats {
  peerId: string
  peerCount: number
  projectsVisible: number
  connected: boolean
  relayConnected: boolean
  rtt: number | null
}

/** Messages exchanged between peers. */
type NetworkMessage =
  | { type: 'project_list'; projects: NetworkProject[] }
  | { type: 'project_update'; project: NetworkProject }
  | { type: 'project_delete'; projectId: string }
  | { type: 'canvas_sync'; projectId: string; nodes: unknown[]; edges: unknown[] }
  | { type: 'ping' }
  | { type: 'pong' }

export class PapyrusNetwork {
  private endpoint: Endpoint | null = null
  private peers = new Map<string, PeerInfo>()
  private connections = new Map<string, Connection>()
  private projects = new Map<string, NetworkProject>()
  private listeners = new Set<(event: string, data: unknown) => void>()
  private acceptLoop: ReturnType<typeof setInterval> | null = null
  private healthLoop: ReturnType<typeof setInterval> | null = null
  private cleanupLoop: ReturnType<typeof setInterval> | null = null

  /** Initialize the Iroh endpoint. */
  async init(): Promise<string> {
    const builder = Endpoint.builder()
    presetN0(builder)
    builder.alpns([ALPN])
    this.endpoint = await builder.bind()
    const id = this.endpoint.id()
    const nodeIdStr = id.toString()

    // Start accepting connections
    this.startAcceptLoop()

    // Start health monitoring
    this.startHealthLoop()

    // Start connection cleanup loop
    this.startCleanupLoop()

    return nodeIdStr
  }

  /** Get the local node ID. */
  nodeId(): string {
    if (!this.endpoint) throw new Error('Network not initialized')
    return this.endpoint.id().toString()
  }

  /** Get a connection ticket for sharing with other peers. */
  async getTicket(): Promise<string> {
    if (!this.endpoint) throw new Error('Network not initialized')
    const addr = this.endpoint.addr()
    const ticket = EndpointTicket.fromAddr(addr)
    return ticket.toString()
  }

  /** Connect to a remote peer. */
  async connect(ticketOrNodeId: string): Promise<string> {
    if (!this.endpoint) throw new Error('Network not initialized')

    let addr: EndpointAddr
    try {
      const ticket = EndpointTicket.fromString(ticketOrNodeId)
      addr = ticket.endpointAddr()
    } catch {
      const nodeId = EndpointId.fromString(ticketOrNodeId)
      addr = new EndpointAddr(nodeId)
    }

    const conn = await this.endpoint.connect(addr, ALPN)
    const peerId = conn.remoteId().toString()

    // Store connection for reuse
    this.connections.set(peerId, conn)

    this.peers.set(peerId, {
      id: peerId,
      addr: null,
      relayUrl: null,
      rtt: conn.rtt(),
      connectedAt: Date.now(),
    })

    this.emit('peer:connected', { peerId })
    this.handleConnection(conn)

    return peerId
  }

  /** Announce a project to the network. */
  announceProject(project: NetworkProject): void {
    this.projects.set(project.id, project)
    this.broadcast({ type: 'project_update', project })
  }

  /** Remove a project announcement. */
  removeProject(projectId: string): void {
    this.projects.delete(projectId)
    this.broadcast({ type: 'project_delete', projectId })
  }

  /** Get all visible projects on the network. */
  getNetworkProjects(): NetworkProject[] {
    return [...this.projects.values()]
  }

  /** Get connected peers. */
  getPeers(): PeerInfo[] {
    return [...this.peers.values()]
  }

  /** Disconnect from a specific peer. */
  async disconnect(peerId: string): Promise<void> {
    // Close the connection if it exists
    const conn = this.connections.get(peerId)
    if (conn) {
      try {
        conn.close(0n, [])
      } catch {
        // ignore close errors
      }
      this.connections.delete(peerId)
    }
    this.peers.delete(peerId)
    this.emit('peer:disconnected', { peerId })
  }

  /** Broadcast canvas changes to all connected peers. */
  broadcastCanvas(projectId: string, nodes: unknown[], edges: unknown[]): void {
    this.broadcast({
      type: 'canvas_sync',
      projectId,
      nodes,
      edges,
    })
  }

  /** Get network health stats. */
  getStats(): NetworkStats {
    return {
      peerId: this.nodeId(),
      peerCount: this.peers.size,
      projectsVisible: this.projects.size,
      connected: this.endpoint !== null,
      relayConnected: this.endpoint !== null,
      rtt: this.getAverageRtt(),
    }
  }

  /** Subscribe to network events. */
  on(event: string, listener: (data: unknown) => void): () => void {
    const wrappedListener = (evt: string, data: unknown) => {
      if (evt === event) listener(data)
    }
    this.listeners.add(wrappedListener)
    return () => {
      this.listeners.delete(wrappedListener)
    }
  }

  /** Close the network. */
  async close(): Promise<void> {
    if (this.acceptLoop) clearInterval(this.acceptLoop)
    if (this.healthLoop) clearInterval(this.healthLoop)
    if (this.cleanupLoop) clearInterval(this.cleanupLoop)

    // Close all active connections
    for (const conn of this.connections.values()) {
      try {
        conn.close(0n, [])
      } catch {
        // ignore close errors
      }
    }
    this.connections.clear()

    if (this.endpoint) {
      await this.endpoint.close()
      this.endpoint = null
    }
    this.peers.clear()
    this.projects.clear()
  }

  // ── Internal ────────────────────────────────────────────────

  private startAcceptLoop(): void {
    if (!this.endpoint) return
    this.acceptLoop = setInterval(async () => {
      if (!this.endpoint) return
      try {
        const incoming = await this.endpoint.acceptNext()
        if (!incoming) return
        const accepting = await incoming.accept()
        const conn = await accepting.connect()
        const peerId = conn.remoteId().toString()

        this.peers.set(peerId, {
          id: peerId,
          addr: null,
          relayUrl: null,
          rtt: conn.rtt(),
          connectedAt: Date.now(),
        })

        this.emit('peer:connected', { peerId })
        this.handleConnection(conn)
      } catch {
        // accept loop error, continue
      }
    }, 100)
  }

  private startHealthLoop(): void {
    this.healthLoop = setInterval(() => {
      this.emit('health:update', this.getStats())
    }, 5000)
  }

  private startCleanupLoop(): void {
    // Clean up stale connections every 30 seconds
    this.cleanupLoop = setInterval(() => {
      for (const [peerId, conn] of this.connections.entries()) {
        if (conn.closeReason() !== null) {
          this.connections.delete(peerId)
          this.peers.delete(peerId)
        }
      }
    }, 30000)
  }

  private async handleConnection(conn: Connection): Promise<void> {
    const peerId = conn.remoteId().toString()

    // Store connection for reuse (incoming connections)
    this.connections.set(peerId, conn)

    // Auto-remove from pool when connection closes
    conn.closed().then((reason) => {
      this.connections.delete(peerId)
      this.peers.delete(peerId)
      this.emit('peer:disconnected', { peerId, reason })
    }).catch(() => {})

    // Send our project list (fire-and-forget)
    try {
      const stream = await conn.openBi()
      this.sendMessage(stream, { type: 'project_list', projects: [...this.projects.values()] })
      stream.send.finish().catch(() => {})
    } catch {
      // send failed, continue to accept loop
    }

    // Accept streams from this peer (this is where we receive messages)
    try {
      while (true) {
        const stream = await conn.acceptBi()
        this.readMessages(stream, peerId).catch(() => {})
      }
    } catch {
      // connection closed - handled by conn.closed() listener above
    }
  }

  private async readMessages(stream: BiStream, peerId: string): Promise<void> {
    try {
      while (true) {
        const data = await stream.recv.readToEnd(1024 * 1024)
        if (data.length === 0) break

        const msg = JSON.parse(new TextDecoder().decode(new Uint8Array(data))) as NetworkMessage
        this.handleMessage(msg, peerId)
      }
    } catch {
      // stream closed
    }
  }

  private handleMessage(msg: NetworkMessage, peerId: string): void {
    switch (msg.type) {
      case 'project_list':
        for (const p of msg.projects) {
          this.projects.set(p.id, { ...p, ownerId: peerId })
        }
        this.emit('projects:update', this.getNetworkProjects())
        break

      case 'project_update':
        this.projects.set(msg.project.id, { ...msg.project, ownerId: peerId })
        this.emit('projects:update', this.getNetworkProjects())
        break

      case 'project_delete':
        this.projects.delete(msg.projectId)
        this.emit('projects:update', this.getNetworkProjects())
        break

      case 'canvas_sync':
        this.emit('canvas:sync', { projectId: msg.projectId, nodes: msg.nodes, edges: msg.edges })
        break

      case 'ping':
        // Respond with pong
        break

      case 'pong':
        break
    }
  }

  private broadcast(msg: NetworkMessage): void {
    // Broadcast to all connected peers
    // This is simplified — in production, we'd maintain open streams
    for (const peer of this.peers.values()) {
      this.sendToPeer(peer.id, msg).catch(() => {
        this.peers.delete(peer.id)
      })
    }
  }

  private async sendToPeer(peerId: string, msg: NetworkMessage): Promise<void> {
    if (!this.endpoint) return

    // Try to get existing connection
    let conn = this.connections.get(peerId)

    // If no connection or connection is closed, create a new one
    if (!conn || conn.closeReason() !== null) {
      const nodeId = EndpointId.fromString(peerId)
      const addr = new EndpointAddr(nodeId)
      conn = await this.endpoint.connect(addr, ALPN)
      this.connections.set(peerId, conn)
    }

    const stream = await conn.openBi()
    await this.sendMessage(stream, msg)
    await stream.send.finish()
  }

  private async sendMessage(stream: BiStream, msg: NetworkMessage): Promise<void> {
    const data = Array.from(new TextEncoder().encode(JSON.stringify(msg)))
    await stream.send.writeAll(data)
  }

  private getAverageRtt(): number | null {
    const rtts = [...this.peers.values()].map((p) => p.rtt).filter((r): r is number => r !== null)
    if (rtts.length === 0) return null
    return rtts.reduce((a, b) => a + b, 0) / rtts.length
  }

  private emit(event: string, data: unknown): void {
    for (const listener of this.listeners) {
      listener(event, data)
    }
  }
}
