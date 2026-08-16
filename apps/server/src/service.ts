import { createHmac, timingSafeEqual } from 'node:crypto'
import type { ActivitySummary, McpServer, Principal, Role, Runtime, Session, SignedLicense, Workspace } from '@papyrus/contracts'
import { GooseRuntime, type GoosePromptEvent } from '@papyrus/goose-runtime'
import { AuditLog } from './audit.js'
import type { ServerConfig } from './config.js'
import { PapyrusDatabase } from './db.js'
import { LicenseService } from './license.js'
import { PolicyEngine, cedarUser, cedarUsers, type AuthorizationResource, type PolicyAction } from './policy.js'

export class AuthorizationDenied extends Error {
  constructor(readonly action: string, readonly resourceId: string) { super(`Not authorized to ${action} ${resourceId}`) }
}

export class PapyrusService {
  readonly audit: AuditLog
  readonly policy = new PolicyEngine()
  readonly license: LicenseService

  constructor(readonly db: PapyrusDatabase, private readonly config: ServerConfig) {
    this.audit = new AuditLog(db)
    this.license = new LicenseService(db, config.dataDir, config.profile, config.licenseAuthorities, config.licenseRequired)
  }

  bootstrap(principal: Principal, secret: string): Principal {
    if (this.db.getSetting('bootstrapComplete') === 'true') throw new Error('Owner bootstrap is already complete')
    if (!this.config.bootstrapSecret || secret !== this.config.bootstrapSecret) throw new Error('Invalid bootstrap secret')
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
    this.audit.append({ actorId: actor.id, action: 'AssignRole', resourceType: 'User', resourceId: userId, decision: 'info', metadata: { role } })
    const principal = this.db.getPrincipal(userId)
    if (!principal) throw new Error('User not found')
    return principal
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

  createRuntime(actor: Principal, input: Omit<Runtime, 'id' | 'kind' | 'createdAt'>): Runtime {
    this.license.require('gateway')
    this.check(actor, 'ManageRuntimes', { type: 'Deployment', id: this.license.deploymentId })
    const runtime = this.db.createRuntime(input)
    this.db.assign('user', actor.id, 'runtime', runtime.id)
    this.audit.append({ actorId: actor.id, action: 'CreateRuntime', resourceType: 'Runtime', resourceId: runtime.id, decision: 'info', metadata: { name: runtime.name, kind: 'goose', model: runtime.model.model } })
    return runtime
  }

  listRuntimes(actor: Principal): Runtime[] {
    return this.db.listRuntimes().filter((runtime) => this.decide(actor, 'ReadRuntime', this.runtimeResource(runtime.id)).allowed)
  }

  assign(actor: Principal, principalId: string, resourceType: 'workspace' | 'runtime', resourceId: string): void {
    this.check(actor, 'AssignResources', { type: 'Deployment', id: this.license.deploymentId })
    this.db.assign('user', principalId, resourceType, resourceId)
    this.audit.append({ actorId: actor.id, action: 'AssignResource', resourceType, resourceId, decision: 'info', metadata: { principalId } })
  }

  createSession(actor: Principal, workspaceId: string, runtimeId: string, title: string): Session {
    this.license.require('gateway')
    this.check(actor, 'CreateSession', this.workspaceResource(workspaceId))
    this.check(actor, 'CreateSession', this.runtimeResource(runtimeId))
    if (!this.db.getWorkspace(workspaceId) || !this.db.getRuntime(runtimeId)) throw new Error('Workspace or runtime not found')
    const session = this.db.createSession(actor.id, workspaceId, runtimeId, title)
    this.audit.append({ actorId: actor.id, action: 'CreateSession', resourceType: 'Session', resourceId: session.id, decision: 'info', metadata: { workspaceId, runtimeId } })
    return session
  }

  listSessions(actor: Principal): Session[] {
    return this.db.listSessions().filter((session) => this.decide(actor, 'ReadSession', this.sessionResource(session)).allowed)
  }

  async prompt(actor: Principal, sessionId: string, prompt: string): Promise<{ stopReason: string; events: GoosePromptEvent[] }> {
    this.license.require('gateway')
    const session = this.db.getSession(sessionId)
    if (!session) throw new Error('Session not found')
    this.check(actor, 'PromptSession', this.sessionResource(session))
    const runtimeConfig = this.db.getRuntime(session.runtimeId)
    if (!runtimeConfig) throw new Error('Runtime not found')
    const events: GoosePromptEvent[] = []
    const runtime = new GooseRuntime(runtimeConfig.command ? { command: runtimeConfig.command } : {})
    this.db.setSessionStatus(session.id, 'running')
    this.audit.append({ actorId: actor.id, action: 'PromptSession', resourceType: 'Session', resourceId: session.id, decision: 'info', metadata: { promptBytes: Buffer.byteLength(prompt) } })
    try {
      const result = await runtime.runPrompt({
        cwd: this.config.dataDir,
        prompt,
        environment: this.modelEnvironment(runtimeConfig),
        mcpServers: this.db.listGrantedMcpServers(session.workspaceId).map((server) => ({
          name: server.name,
          url: `${this.config.publicOrigin}/api/runtime/mcp/${session.id}/${server.id}`,
          headers: [{ name: 'authorization', value: `Bearer ${this.issueRuntimeToken(session.id, server.id)}` }],
        })),
        authorizeTool: async (title) => this.db.isToolGranted(session.workspaceId, ...this.findTool(session.workspaceId, title)),
        onEvent: (event) => {
          events.push(event)
          this.db.addRuntimeEvent(session.id, event.kind, event.at, event.data)
        },
      })
      this.db.setSessionStatus(session.id, 'ready')
      return { stopReason: result.stopReason, events }
    } catch (error) {
      this.db.setSessionStatus(session.id, 'failed')
      this.audit.append({ actorId: actor.id, action: 'RuntimeFailure', resourceType: 'Session', resourceId: session.id, decision: 'info', metadata: { message: error instanceof Error ? error.message : 'Unknown runtime failure' } })
      throw error
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
    this.check(actor, 'InvokeTool', { type: 'Tool', id: `${mcpServerId}:${toolName}`, attrs: { assignedUsers: cedarUsers(this.db.assignedUserIds('workspace', session.workspaceId)) } })
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

  activateLicense(actor: Principal, document: SignedLicense) {
    this.check(actor, 'ActivateLicense', { type: 'Deployment', id: this.license.deploymentId })
    const status = this.license.activate(document)
    this.audit.append({ actorId: actor.id, action: 'ActivateLicense', resourceType: 'Deployment', resourceId: this.license.deploymentId, decision: status.valid ? 'allow' : 'deny', metadata: { licenseId: document.licenseId, reason: status.reason ?? null } })
    return status
  }

  private check(actor: Principal, action: PolicyAction, resource: AuthorizationResource): void {
    const decision = this.decide(actor, action, resource)
    this.audit.append({ actorId: actor.id, action, resourceType: resource.type, resourceId: resource.id, decision: decision.allowed ? 'allow' : 'deny', metadata: { reasons: decision.reasons, errors: decision.errors, cedarVersion: decision.cedarVersion } })
    if (!decision.allowed) throw new AuthorizationDenied(action, resource.id)
  }

  private decide(actor: Principal, action: PolicyAction, resource: AuthorizationResource) { return this.policy.authorize(actor, action, resource) }
  private workspaceResource(id: string): AuthorizationResource { return { type: 'Workspace', id, attrs: { assignedUsers: cedarUsers(this.db.assignedUserIds('workspace', id)) } } }
  private runtimeResource(id: string): AuthorizationResource { return { type: 'Runtime', id, attrs: { assignedUsers: cedarUsers(this.db.assignedUserIds('runtime', id)) } } }
  private sessionResource(session: Session): AuthorizationResource { return { type: 'Session', id: session.id, attrs: { owner: cedarUser(session.ownerId) } } }

  private findTool(workspaceId: string, title: string): [string, string] {
    const row = this.db.sqlite.prepare('SELECT mcp_server_id,tool_name FROM tool_grants WHERE workspace_id=? AND tool_name=? LIMIT 1').get(workspaceId, title) as { mcp_server_id: string; tool_name: string } | undefined
    return row ? [row.mcp_server_id, row.tool_name] : ['', '']
  }

  private modelEnvironment(runtime: Runtime): Record<string, string> {
    const secretName = `PAPYRUS_SECRET_${runtime.model.secretRef.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`
    const secret = process.env[secretName]
    if (!secret) throw new Error(`Missing server-side model credential ${secretName}`)
    const common = { GOOSE_MODEL: runtime.model.model }
    if (runtime.model.provider === 'openai-compatible') return { ...common, GOOSE_PROVIDER: 'openai', OPENAI_HOST: runtime.model.baseUrl, OPENAI_API_KEY: secret }
    if (runtime.model.provider === 'azure-openai') return { ...common, GOOSE_PROVIDER: 'azure', AZURE_OPENAI_ENDPOINT: runtime.model.baseUrl, AZURE_OPENAI_API_KEY: secret }
    return { ...common, GOOSE_PROVIDER: 'anthropic', ANTHROPIC_HOST: runtime.model.baseUrl, ANTHROPIC_API_KEY: secret }
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
