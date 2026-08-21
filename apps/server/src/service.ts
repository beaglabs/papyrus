import { readFileSync } from 'node:fs'
import { Agent as HttpsAgent } from 'node:https'
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { ActivitySummary, McpServer, Principal, Role, Session, SessionEvent, SessionRun, SignedLicense, Workspace } from '@papyrus/contracts'
import type { AgentRuntime, RuntimeEvent, RuntimeLaunchOptions } from '@papyrus/acp-runtime'
import { gooseRuntimeAdapter } from '@papyrus/goose-runtime'
import { resolveAgentSpec } from './agents.js'
import { connectorPolicyAction } from './catalog.js'
import { AuditLog } from './audit.js'
import type { ServerConfig } from './config.js'
import { PapyrusDatabase } from './db.js'
import { LicenseService } from './license.js'
import { PolicyEngine, cedarUser, cedarUsers, type AuthorizationResource, type PolicyAction } from './policy.js'

export class AuthorizationDenied extends Error {
  constructor(readonly action: string, readonly resourceId: string) { super(`Not authorized to ${action} ${resourceId}`) }
}

export class SessionLifecycleError extends Error {
  constructor(
    readonly code: 'SESSION_NOT_FOUND' | 'SESSION_BUSY' | 'SESSION_STOPPED' | 'SESSION_CWD_MISMATCH',
    message: string,
  ) { super(message) }
}

export type RuntimeFactory = (options: RuntimeLaunchOptions) => AgentRuntime

export interface SessionPromptOptions {
  signal?: AbortSignal
  onEvent?: (event: RuntimeEvent) => void | Promise<void>
}

interface ActiveSessionRun {
  runId: string
  controller: AbortController
  settled: Promise<void>
  resolveSettled: () => void
  detachSignal?: () => void
}

export class PapyrusService {
  readonly audit: AuditLog
  readonly policy = new PolicyEngine()
  readonly license: LicenseService
  private readonly activeSessionRuns = new Map<string, ActiveSessionRun>()

  constructor(
    readonly db: PapyrusDatabase,
    private readonly config: ServerConfig,
    private readonly runtimeFactory: RuntimeFactory = (options) => gooseRuntimeAdapter.create(options),
  ) {
    this.audit = new AuditLog(db)
    this.license = new LicenseService(db, config.dataDir, config.profile, config.licenseAuthorities, config.licenseRequired)
    for (const sessionId of db.recoverInterruptedSessionRuns()) {
      this.audit.append({
        actorId: null,
        action: 'RecoverInterruptedSession',
        resourceType: 'Session',
        resourceId: sessionId,
        decision: 'info',
        metadata: { reason: 'daemon_restart' },
      })
    }
  }

  bootstrap(principal: Principal, secret: string): Principal {
    if (this.db.getSetting('bootstrapComplete') === 'true') throw new Error('Owner bootstrap is already complete')
    if (!this.config.bootstrapSecret || !secureEqual(secret, this.config.bootstrapSecret)) throw new Error('Invalid bootstrap secret')
    this.db.transaction(() => {
      if (this.db.getSetting('bootstrapComplete') === 'true') throw new Error('Owner bootstrap is already complete')
      this.db.setRole(principal.id, 'Owner')
      this.db.setSetting('bootstrapComplete', 'true')
    })
    this.audit.append({ actorId: principal.id, action: 'BootstrapOwner', resourceType: 'Deployment', resourceId: this.license.deploymentId, decision: 'info', metadata: {} })
    return this.db.getPrincipal(principal.id) as Principal
  }

  assignRole(actor: Principal, userId: string, role: Role): Principal {
    this.check(actor, 'ManageUsers', { type: 'Deployment', id: this.license.deploymentId })
    if (['Owner', 'Admin'].includes(role) && !actor.roles.includes('Owner')) throw new AuthorizationDenied('AssignPrivilegedRole', userId)
    this.db.setRole(userId, role)
    this.db.incrementTokenVersion(userId)
    this.audit.append({ actorId: actor.id, action: 'AssignRole', resourceType: 'User', resourceId: userId, decision: 'info', metadata: { role, revokedSessions: true } })
    const principal = this.db.getPrincipal(userId)
    if (!principal) throw new Error('User not found')
    return principal
  }

  revokeSessions(actor: Principal, userId: string): void {
    this.check(actor, 'ManageUsers', { type: 'Deployment', id: this.license.deploymentId })
    this.db.incrementTokenVersion(userId)
    this.audit.append({ actorId: actor.id, action: 'RevokeSessions', resourceType: 'User', resourceId: userId, decision: 'info', metadata: {} })
  }

  listUsers(actor: Principal): Principal[] {
    this.check(actor, 'ManageUsers', { type: 'Deployment', id: this.license.deploymentId })
    return this.db.listPrincipals()
  }

  createWorkspace(actor: Principal, input: Pick<Workspace, 'name' | 'description'>): Workspace {
    this.license.require('gateway')
    this.check(actor, 'ManageWorkspaces', { type: 'Deployment', id: this.license.deploymentId })
    const workspace = this.db.createWorkspace(input)
    this.db.assign('user', actor.id, 'workspace', workspace.id)
    this.audit.append({ actorId: actor.id, action: 'CreateWorkspace', resourceType: 'Workspace', resourceId: workspace.id, decision: 'info', metadata: { name: workspace.name } })
    return workspace
  }

  listWorkspaces(actor: Principal): Workspace[] {
    return this.db.listWorkspaces().filter((workspace) => this.decide(actor, 'ReadWorkspace', this.workspaceResource(workspace.id)).allowed)
  }

  assign(actor: Principal, principalId: string, resourceId: string): void {
    this.check(actor, 'AssignResources', { type: 'Deployment', id: this.license.deploymentId })
    this.db.assign('user', principalId, 'workspace', resourceId)
    this.audit.append({ actorId: actor.id, action: 'AssignResource', resourceType: 'workspace', resourceId, decision: 'info', metadata: { principalId } })
  }

  createSession(actor: Principal, workspaceId: string, agent: string, title: string, cwd = '/'): Session {
    this.license.require('gateway')
    this.check(actor, 'CreateSession', this.workspaceResource(workspaceId))
    if (!this.db.getWorkspace(workspaceId)) throw new Error('Workspace not found')
    const spec = resolveAgentSpec(agent, this.config.agents)
    if (!spec) throw new Error(`Unknown agent "${agent}"`)
    if (!isAbsoluteClientPath(cwd)) throw new Error('Session cwd must be an absolute path')
    const session = this.db.createSession(actor.id, workspaceId, agent, title, cwd)
    this.audit.append({ actorId: actor.id, action: 'CreateSession', resourceType: 'Session', resourceId: session.id, decision: 'info', metadata: { workspaceId, agent, cwd } })
    return session
  }

  listSessions(actor: Principal): Session[] {
    return this.db.listSessions().filter((session) => this.decide(actor, 'ReadSession', this.sessionResource(session)).allowed)
  }

  getSession(actor: Principal, sessionId: string): Session {
    const session = this.requireSession(sessionId)
    this.check(actor, 'ReadSession', this.sessionResource(session))
    return session
  }

  defaultGatewayAgent(): string {
    const agent = this.config.gateway?.defaultAgent ?? 'goose'
    if (!resolveAgentSpec(agent, this.config.agents)) throw new Error(`Unknown gateway agent "${agent}"`)
    return agent
  }

  async shutdown(timeoutMs = 5_000): Promise<void> {
    const active = [...this.activeSessionRuns.entries()]
    for (const [, run] of active) run.controller.abort(new Error('Daemon shutting down'))
    if (active.length > 0) {
      await Promise.race([
        Promise.allSettled(active.map(([, run]) => run.settled)),
        new Promise((resolve) => setTimeout(resolve, timeoutMs)),
      ])
    }
    for (const [sessionId, run] of active) {
      if (this.activeSessionRuns.get(sessionId)?.runId !== run.runId) continue
      this.db.finishSessionRun(run.runId, 'interrupted', 'daemon_shutdown', 'Daemon shut down before the run completed')
      this.activeSessionRuns.delete(sessionId)
    }
  }

  sessionEvents(actor: Principal, sessionId: string, after = 0, limit = 200): SessionEvent[] {
    const session = this.requireSession(sessionId)
    this.check(actor, 'ReadSession', this.sessionResource(session))
    return this.db.listSessionEvents(sessionId, after, limit)
  }

  sessionRuns(actor: Principal, sessionId: string): SessionRun[] {
    const session = this.requireSession(sessionId)
    this.check(actor, 'ReadSession', this.sessionResource(session))
    return this.db.listSessionRuns(sessionId)
  }

  cancelSession(actor: Principal, sessionId: string): boolean {
    const session = this.requireSession(sessionId)
    this.check(actor, 'CancelSession', this.sessionResource(session))
    const active = this.activeSessionRuns.get(sessionId)
    active?.controller.abort(new Error('Session cancelled'))
    this.audit.append({
      actorId: actor.id,
      action: 'CancelSession',
      resourceType: 'Session',
      resourceId: sessionId,
      decision: 'info',
      metadata: { active: Boolean(active), runId: active?.runId ?? null },
    })
    return Boolean(active)
  }

  closeSession(actor: Principal, sessionId: string): Session {
    const session = this.requireSession(sessionId)
    this.check(actor, 'CloseSession', this.sessionResource(session))
    const active = this.activeSessionRuns.get(sessionId)
    active?.controller.abort(new Error('Session closed'))
    this.db.setSessionStatus(sessionId, 'stopped')
    this.audit.append({
      actorId: actor.id,
      action: 'CloseSession',
      resourceType: 'Session',
      resourceId: sessionId,
      decision: 'info',
      metadata: { cancelledRunId: active?.runId ?? null },
    })
    return this.requireSession(sessionId)
  }

  resumeSession(actor: Principal, sessionId: string, expectedCwd?: string): Session {
    const session = this.requireSession(sessionId)
    this.check(actor, 'ResumeSession', this.sessionResource(session))
    if (session.status === 'running') throw new SessionLifecycleError('SESSION_BUSY', 'Session already has an active prompt')
    if (expectedCwd && expectedCwd !== session.cwd) {
      throw new SessionLifecycleError('SESSION_CWD_MISMATCH', 'Session cwd does not match the persisted session')
    }
    const resumed = this.db.resumeSession(sessionId)
    if (!resumed) throw new SessionLifecycleError('SESSION_NOT_FOUND', 'Session not found')
    this.audit.append({ actorId: actor.id, action: 'ResumeSession', resourceType: 'Session', resourceId: sessionId, decision: 'info', metadata: { previousStatus: session.status } })
    return resumed
  }

  async prompt(actor: Principal, sessionId: string, prompt: string, options: SessionPromptOptions = {}): Promise<{ stopReason: string; events: RuntimeEvent[] }> {
    this.license.require('gateway')
    const session = this.requireSession(sessionId)
    this.check(actor, 'PromptSession', this.sessionResource(session))
    const spec = resolveAgentSpec(session.agent, this.config.agents)
    if (!spec) throw new Error(`Unknown agent "${session.agent}"`)
    const events: RuntimeEvent[] = []
    const run = this.beginRun(session, actor, options.signal)
    try {
      const runtime = this.runtimeFactory({ ...this.runtimeCommand(session.agent), promptTimeoutMs: this.config.promptTimeoutMs })
      this.db.addRuntimeEvent(session.id, run.runId, 'update', new Date().toISOString(), {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: prompt },
        messageId: `user_${run.runId}`,
      })
      this.audit.append({ actorId: actor.id, action: 'PromptSession', resourceType: 'Session', resourceId: session.id, decision: 'info', metadata: { promptBytes: Buffer.byteLength(prompt), runId: run.runId } })
      const result = await runtime.runPrompt({
        cwd: session.cwd,
        prompt,
        environment: spec.environment(),
        mcpServers: this.runtimeMcpServers(session),
        authorizeTool: async (title) => this.isToolCallAllowed(actor, session, title),
        onEvent: async (event) => {
          events.push(event)
          this.db.addRuntimeEvent(session.id, run.runId, event.kind, event.at, event.data)
          await options.onEvent?.(event)
        },
        signal: run.controller.signal,
      })
      const cancelled = run.controller.signal.aborted || result.stopReason === 'cancelled'
      this.db.finishSessionRun(run.runId, cancelled ? 'cancelled' : 'completed', cancelled ? 'cancelled' : result.stopReason)
      return { stopReason: result.stopReason, events }
    } catch (error) {
      if (run.controller.signal.aborted) {
        this.db.finishSessionRun(run.runId, 'cancelled', 'cancelled')
        return { stopReason: 'cancelled', events }
      }
      const message = safeError(error)
      this.db.finishSessionRun(run.runId, 'failed', 'error', message)
      this.audit.append({ actorId: actor.id, action: 'RuntimeFailure', resourceType: 'Session', resourceId: session.id, decision: 'info', metadata: { error: message, runId: run.runId } })
      throw error
    } finally {
      run.detachSignal?.()
      if (this.activeSessionRuns.get(sessionId)?.runId === run.runId) this.activeSessionRuns.delete(sessionId)
      run.resolveSettled()
    }
  }

  addMcpServer(actor: Principal, input: Pick<McpServer, 'name' | 'endpoint'>): McpServer {
    this.check(actor, 'ManageTools', { type: 'Deployment', id: this.license.deploymentId })
    const parsed = new URL(input.endpoint)
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only HTTP MCP transports are supported')
    const server = this.db.addMcpServer(input)
    this.audit.append({ actorId: actor.id, action: 'AddMcpServer', resourceType: 'McpServer', resourceId: server.id, decision: 'info', metadata: { name: server.name } })
    return server
  }

  listMcpServers(actor: Principal): McpServer[] {
    this.check(actor, 'ManageTools', { type: 'Deployment', id: this.license.deploymentId })
    return this.db.listMcpServers()
  }

  grantTool(actor: Principal, workspaceId: string, mcpServerId: string, toolName: string): void {
    this.check(actor, 'ManageTools', { type: 'Deployment', id: this.license.deploymentId })
    this.db.grantTool(workspaceId, mcpServerId, toolName)
    this.audit.append({ actorId: actor.id, action: 'GrantTool', resourceType: 'Tool', resourceId: `${mcpServerId}:${toolName}`, decision: 'info', metadata: { workspaceId } })
  }

  async invokeTool(actor: Principal, sessionId: string, mcpServerId: string, toolName: string, args: unknown): Promise<unknown> {
    const session = this.db.getSession(sessionId)
    if (!session) throw new Error('Session not found')
    this.check(actor, 'PromptSession', this.sessionResource(session))
    const resource = { type: 'Tool' as const, id: `${mcpServerId}:${toolName}`, attrs: { assignedUsers: cedarUsers(this.db.assignedUserIds('workspace', session.workspaceId)) } }
    this.check(actor, 'InvokeTool', resource)
    const connectorAction = connectorPolicyAction(toolName)
    if (connectorAction) this.check(actor, connectorAction, resource)
    if (!this.db.isToolGranted(session.workspaceId, mcpServerId, toolName)) {
      this.audit.append({ actorId: actor.id, action: 'InvokeTool', resourceType: 'Tool', resourceId: `${mcpServerId}:${toolName}`, decision: 'deny', metadata: { sessionId, reason: 'No workspace tool grant' } })
      throw new AuthorizationDenied('InvokeTool', `${mcpServerId}:${toolName}`)
    }
    const server = this.db.getMcpServer(mcpServerId)
    if (!server?.enabled) throw new Error('MCP server unavailable')
    const started = Date.now()
    const response = await fetch(server.endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method: 'tools/call', params: { name: toolName, arguments: args } }),
      signal: AbortSignal.timeout(30_000),
    })
    const result = await response.json()
    this.audit.append({ actorId: actor.id, action: 'InvokeTool', resourceType: 'Tool', resourceId: `${mcpServerId}:${toolName}`, decision: response.ok ? 'allow' : 'deny', metadata: { sessionId, durationMs: Date.now() - started, status: response.status } })
    if (!response.ok) throw new Error(`MCP server returned ${response.status}`)
    return result
  }

  async proxyMcp(token: string, sessionId: string, mcpServerId: string, message: Record<string, unknown>): Promise<unknown> {
    if (!this.verifyRuntimeToken(token, sessionId, mcpServerId)) throw new AuthorizationDenied('UseRuntimeMcpToken', sessionId)
    const session = this.db.getSession(sessionId)
    if (!session) throw new Error('Session not found')
    const actor = this.db.getPrincipal(session.ownerId)
    if (!actor) throw new Error('Session owner not found')
    const method = String(message.method ?? '')
    if (method === 'tools/call') {
      const params = message.params as Record<string, unknown> | undefined
      return this.invokeTool(actor, sessionId, mcpServerId, textValue(params?.name, 'tool name'), params?.arguments ?? {})
    }
    const server = this.db.getMcpServer(mcpServerId)
    if (!server?.enabled) throw new Error('MCP server unavailable')
    if (method === 'tools/list') {
      const result = await this.forwardMcp(server.endpoint, message)
      if (result && typeof result === 'object') {
        const envelope = result as { result?: { tools?: Array<{ name?: string }> } }
        if (Array.isArray(envelope.result?.tools)) envelope.result.tools = envelope.result.tools.filter((tool) => typeof tool.name === 'string' && this.db.isToolGranted(session.workspaceId, mcpServerId, tool.name))
      }
      this.audit.append({ actorId: actor.id, action: 'DiscoverTools', resourceType: 'McpServer', resourceId: mcpServerId, decision: 'allow', metadata: { sessionId } })
      return result
    }
    if (!['initialize', 'notifications/initialized', 'ping'].includes(method)) throw new AuthorizationDenied('McpMethod', method)
    return this.forwardMcp(server.endpoint, message)
  }

  activity(actor: Principal): ActivitySummary {
    this.check(actor, 'ReadActivity', { type: 'Audit', id: 'activity', attrs: { owner: cedarUser(actor.id) } })
    const own = actor.roles.some((role) => ['Owner', 'Admin', 'Auditor'].includes(role)) ? '' : ' WHERE actor_id = ?'
    const args = own ? [actor.id] : []
    const query = (action: string) => Number((this.db.sqlite.prepare(`SELECT count(*) count FROM audit_events${own}${own ? ' AND' : ' WHERE'} action=?`).get(...args, action) as { count: number }).count)
    const sessions = own ? Number((this.db.sqlite.prepare('SELECT count(*) count FROM sessions WHERE owner_id=?').get(actor.id) as { count: number }).count) : Number((this.db.sqlite.prepare('SELECT count(*) count FROM sessions').get() as { count: number }).count)
    const deniedActions = Number((this.db.sqlite.prepare(`SELECT count(*) count FROM audit_events${own}${own ? ' AND' : ' WHERE'} decision='deny'`).get(...args) as { count: number }).count)
    return { sessions, prompts: query('PromptSession'), toolCalls: query('InvokeTool'), deniedActions }
  }

  auditEvents(actor: Principal) {
    this.check(actor, 'ReadAudit', { type: 'Audit', id: 'events' })
    return { integrity: this.audit.verify(), events: this.audit.list() }
  }

  exportAuditCheckpoint(actor: Principal) {
    this.check(actor, 'ReadAudit', { type: 'Audit', id: 'checkpoint' })
    const events = this.audit.export()
    const payload = {
      deploymentId: this.license.deploymentId,
      generatedAt: new Date().toISOString(),
      count: events.length,
      firstSequence: events[0]?.sequence ?? 0,
      lastSequence: events[events.length - 1]?.sequence ?? 0,
      integrity: this.audit.verify().valid,
      events,
    }
    return { ...payload, signature: this.license.signCheckpoint(payload) }
  }

  verifyAuditCheckpoint(checkpoint: { signature?: string } & Record<string, unknown>): boolean {
    const { signature, ...payload } = checkpoint
    if (typeof signature !== 'string') return false
    return this.license.verifyCheckpoint(payload, signature)
  }

  activateLicense(actor: Principal, document: SignedLicense) {
    this.check(actor, 'ActivateLicense', { type: 'Deployment', id: this.license.deploymentId })
    const status = this.license.activate(document)
    this.audit.append({ actorId: actor.id, action: 'ActivateLicense', resourceType: 'Deployment', resourceId: this.license.deploymentId, decision: status.valid ? 'allow' : 'deny', metadata: { licenseId: document.licenseId, reason: status.reason ?? null } })
    return status
  }

  private requireSession(sessionId: string): Session {
    const session = this.db.getSession(sessionId)
    if (!session) throw new SessionLifecycleError('SESSION_NOT_FOUND', 'Session not found')
    return session
  }

  private beginRun(session: Session, actor: Principal, signal?: AbortSignal): ActiveSessionRun {
    let persistentRun: SessionRun
    try {
      persistentRun = this.db.beginSessionRun(session.id, actor.id)
    } catch (error) {
      const code = error instanceof Error ? error.message : ''
      if (code === 'SESSION_BUSY') throw new SessionLifecycleError('SESSION_BUSY', 'Session already has an active prompt')
      if (code === 'SESSION_STOPPED') throw new SessionLifecycleError('SESSION_STOPPED', 'Session is stopped; resume it before prompting')
      if (code === 'SESSION_NOT_FOUND') throw new SessionLifecycleError('SESSION_NOT_FOUND', 'Session not found')
      throw error
    }
    const controller = new AbortController()
    let resolveSettled!: () => void
    const settled = new Promise<void>((resolve) => { resolveSettled = resolve })
    const active: ActiveSessionRun = { runId: persistentRun.id, controller, settled, resolveSettled }
    if (signal) {
      const abort = (): void => controller.abort(signal.reason)
      if (signal.aborted) abort()
      else {
        signal.addEventListener('abort', abort, { once: true })
        active.detachSignal = () => signal.removeEventListener('abort', abort)
      }
    }
    this.activeSessionRuns.set(session.id, active)
    return active
  }

  private check(actor: Principal, action: PolicyAction, resource: AuthorizationResource): void {
    const decision = this.decide(actor, action, resource)
    this.audit.append({ actorId: actor.id, action, resourceType: resource.type, resourceId: resource.id, decision: decision.allowed ? 'allow' : 'deny', metadata: { reasons: decision.reasons, errors: decision.errors, cedarVersion: decision.cedarVersion } })
    if (!decision.allowed) throw new AuthorizationDenied(action, resource.id)
  }

  private decide(actor: Principal, action: PolicyAction, resource: AuthorizationResource) { return this.policy.authorize(actor, action, resource) }
  private workspaceResource(id: string): AuthorizationResource { return { type: 'Workspace', id, attrs: { assignedUsers: cedarUsers(this.db.assignedUserIds('workspace', id)) } } }
  private sessionResource(session: Session): AuthorizationResource { return { type: 'Session', id: session.id, attrs: { owner: cedarUser(session.ownerId) } } }

  private findTool(workspaceId: string, title: string): [string, string] {
    const row = this.db.sqlite.prepare('SELECT mcp_server_id,tool_name FROM tool_grants WHERE workspace_id=? AND tool_name=? LIMIT 1').get(workspaceId, title) as { mcp_server_id: string; tool_name: string } | undefined
    return row ? [row.mcp_server_id, row.tool_name] : ['', '']
  }

  /** Launch command and args for an agent. */
  runtimeCommand(agent: string): { command: string; args: string[] } {
    const spec = resolveAgentSpec(agent, this.config.agents)
    if (!spec) throw new Error(`Unknown agent "${agent}"`)
    return { command: spec.command, args: spec.args }
  }

  /** Authorizes and audits a prompt against a Papyrus session (without running it). */
  authorizeSessionPrompt(actor: Principal, session: Session): void {
    this.check(actor, 'PromptSession', this.sessionResource(session))
    this.audit.append({ actorId: actor.id, action: 'PromptSession', resourceType: 'Session', resourceId: session.id, decision: 'info', metadata: {} })
  }

  /** Authorizes a tool call (goose reports the tool title) against the workspace grant. */
  isToolCallAllowed(actor: Principal, session: Session, toolTitle: string): boolean {
    const [mcpServerId, toolName] = this.findTool(session.workspaceId, toolTitle)
    if (!mcpServerId || !toolName) return false
    try {
      this.check(actor, 'PromptSession', this.sessionResource(session))
      const resource = { type: 'Tool' as const, id: `${mcpServerId}:${toolName}`, attrs: { assignedUsers: cedarUsers(this.db.assignedUserIds('workspace', session.workspaceId)) } }
      this.check(actor, 'InvokeTool', resource)
      const connectorAction = connectorPolicyAction(toolName)
      if (connectorAction) this.check(actor, connectorAction, resource)
      return this.db.isToolGranted(session.workspaceId, mcpServerId, toolName)
    } catch { return false }
  }

  /** Session-bound Papyrus MCP proxy endpoints for the runtime to consume. */
  runtimeMcpServers(session: Session): Array<{ name: string; url: string; headers: Array<{ name: string; value: string }> }> {
    return this.db.listGrantedMcpServers(session.workspaceId).map((server) => ({
      name: server.name,
      url: `${this.config.publicOrigin}/api/runtime/mcp/${session.id}/${server.id}`,
      headers: [{ name: 'authorization', value: `Bearer ${this.issueRuntimeToken(session.id, server.id)}` }],
    }))
  }

  private issueRuntimeToken(sessionId: string, serverId: string): string {
    const body = Buffer.from(JSON.stringify({ sessionId, serverId, exp: Date.now() + 60 * 60 * 1000 })).toString('base64url')
    return `${body}.${createHmac('sha256', this.config.sessionSecret).update(body).digest('base64url')}`
  }

  private verifyRuntimeToken(token: string, sessionId: string, serverId: string): boolean {
    const [body, signature] = token.split('.')
    if (!body || !signature) return false
    const expected = createHmac('sha256', this.config.sessionSecret).update(body).digest()
    const actual = Buffer.from(signature, 'base64url')
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false
    try {
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { sessionId: string; serverId: string; exp: number }
      return payload.sessionId === sessionId && payload.serverId === serverId && payload.exp > Date.now()
    } catch { return false }
  }

  private async forwardMcp(endpoint: string, message: Record<string, unknown>): Promise<unknown> {
    const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(message), signal: AbortSignal.timeout(30_000) })
    if (!response.ok) throw new Error(`MCP server returned ${response.status}`)
    return response.json()
  }
}

function textValue(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`Missing ${name}`)
  return value
}

function secureEqual(presented: string, expected: string): boolean {
  const presentedDigest = createHash('sha256').update(presented).digest()
  const expectedDigest = createHash('sha256').update(expected).digest()
  return timingSafeEqual(presentedDigest, expectedDigest)
}

function safeError(error: unknown): string {
  const value = error instanceof Error ? `${error.name}: ${error.message}` : 'Unknown runtime failure'
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 512)
}

function isAbsoluteClientPath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)
}
