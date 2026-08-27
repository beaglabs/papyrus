import { readFileSync } from 'node:fs'
import { Agent as HttpsAgent } from 'node:https'
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { SESSION_SURFACES } from '@papyrus/contracts'
import type { ActivitySummary, AdminOverview, ApprovedSource, ApprovedSourceKind, Approval, Attachment, Elicitation, Environment, Invitation, InvitationIdentityKind, McpServer, Principal, ResearchSource, Role, Session, SessionConfigOption, SessionEvent, SessionRun, SessionSurface, SignedLicense, SourceSearchResult } from '@papyrus/contracts'
import type { ContentBlock } from '@agentclientprotocol/sdk'
import type { AgentRuntime, RuntimeEvent, RuntimeLaunchOptions, RuntimeTool } from '@papyrus/acp-runtime'
import { BROWSER_POLICY_ACTIONS, connectorPolicyAction } from './catalog.js'
import { runtimeToolAction } from './mastra/authorization.js'
import { Mastra } from '@mastra/core/mastra'
import { MastraAgentWorker } from './mastra/worker.js'
import { createPapyrusMastra } from './mastra/server.js'
import type { PapyrusWorkspaceManager } from './mastra/workspace.js'
import { AuditLog } from './audit.js'
import { ApprovedSourceStore } from './approved-sources.js'
import { projectArtifacts, type ProjectedArtifact } from './artifacts.js'
import { projectResearchSources } from './sources.js'
import type { ServerConfig } from './config.js'
import { PapyrusDatabase } from './db.js'
import { LicenseService } from './license.js'
import { callMcpTool, listMcpTools, validateMcpServer } from './mcp-client.js'
import { exchangeMcpCode, normalizeMcpEndpoint, registerRemoteMcp } from './mcp-oauth.js'
import { PolicyEngine, cedarUser, cedarUsers, type AuthorizationResource, type PolicyAction } from './policy.js'

export class AuthorizationDenied extends Error {
  constructor(readonly action: string, readonly resourceId: string) { super(`Not authorized to ${action} ${resourceId}`) }
}

export class SessionLifecycleError extends Error {
  constructor(
    readonly code: 'SESSION_NOT_FOUND' | 'SESSION_BUSY' | 'SESSION_STOPPED' | 'SESSION_CWD_MISMATCH' | 'INVALID_SESSION_MODE' | 'INVALID_CONFIG_OPTION' | 'INVALID_CONFIG_VALUE',
    message: string,
  ) { super(message) }
}

export class ApprovalLifecycleError extends Error {
  constructor(readonly code: 'APPROVAL_NOT_FOUND' | 'APPROVAL_ALREADY_DECIDED' | 'APPROVAL_SESSION_MISMATCH', message: string) { super(message) }
}

export type RuntimeFactory = (options: RuntimeLaunchOptions) => AgentRuntime

export interface SessionPromptOptions {
  signal?: AbortSignal
  onEvent?: (event: RuntimeEvent) => void | Promise<void>
  onRunStarted?: (run: SessionRun) => void
  attachmentIds?: string[]
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
  readonly sources: ApprovedSourceStore
  private readonly activeSessionRuns = new Map<string, ActiveSessionRun>()
  private readonly pendingApprovalResolvers = new Map<string, (approved: boolean) => void>()
  private readonly pendingElicitationResolvers = new Map<string, (response: Record<string, unknown>) => void>()
  private readonly mastra: Mastra
  private readonly workspaces: PapyrusWorkspaceManager | undefined
  private readonly runtimeFactory: RuntimeFactory

  constructor(
    readonly db: PapyrusDatabase,
    private readonly config: ServerConfig,
    mastraOrRuntimeFactory?: Mastra | RuntimeFactory,
    workspaces?: PapyrusWorkspaceManager,
    runtimeFactory?: RuntimeFactory,
  ) {
    const bundle = typeof mastraOrRuntimeFactory === 'function'
      ? { mastra: new Mastra(), workspaces: undefined }
      : !mastraOrRuntimeFactory ? createPapyrusMastra(config, db)
      : { mastra: mastraOrRuntimeFactory, workspaces: workspaces ?? createPapyrusMastra(config, db).workspaces }
    this.mastra = bundle.mastra
    this.workspaces = bundle.workspaces
    this.runtimeFactory = typeof mastraOrRuntimeFactory === 'function'
      ? mastraOrRuntimeFactory
      : runtimeFactory ?? (() => new MastraAgentWorker(this.mastra, this.config, requireWorkspaces(this.workspaces)))
    this.audit = new AuditLog(db)
    this.sources = new ApprovedSourceStore(db)
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
    for (const approval of db.cancelPendingApprovals('daemon_restart')) {
      this.audit.append({ actorId: null, action: 'CancelApproval', resourceType: 'Approval', resourceId: approval.id, decision: 'info', metadata: { reason: 'daemon_restart', sessionId: approval.sessionId } })
    }
  }

  bootstrap(principal: Principal, secret: string): Principal {
    if (this.db.getSetting('bootstrapComplete') === 'true') throw new Error('Owner bootstrap is already complete')
    if (!this.config.bootstrapSecret || !secureEqual(secret, this.config.bootstrapSecret)) {
      this.audit.append({ actorId: principal.id, action: 'BootstrapOwner', resourceType: 'Deployment', resourceId: this.license.deploymentId, decision: 'deny', metadata: { reason: 'invalid_secret' } })
      throw new Error('Invalid bootstrap secret')
    }
    this.db.transaction(() => {
      if (this.db.getSetting('bootstrapComplete') === 'true') throw new Error('Owner bootstrap is already complete')
      this.db.setRole(principal.id, 'Owner')
      this.db.setSetting('bootstrapComplete', 'true')
    })
    this.audit.append({ actorId: principal.id, action: 'BootstrapOwner', resourceType: 'Deployment', resourceId: this.license.deploymentId, decision: 'info', metadata: {} })
    return this.db.getPrincipal(principal.id) as Principal
  }

  createInvitation(actor: Principal, input: {
    identityValue: string
    displayName: string
    email?: string
    role: Role
  }): Invitation {
    this.check(actor, 'ManageUsers', { type: 'Deployment', id: this.license.deploymentId })
    if (['Owner', 'Admin'].includes(input.role) && !actor.roles.includes('Owner')) {
      this.audit.append({ actorId: actor.id, action: 'CreateInvitation', resourceType: 'Invitation', resourceId: 'new', decision: 'deny', metadata: { role: input.role, reason: 'privileged_role_requires_owner' } })
      throw new AuthorizationDenied('CreatePrivilegedInvitation', input.identityValue)
    }
    const commercial = this.config.profile === 'commercial'
    const identityKind: InvitationIdentityKind = commercial ? 'email' : inferGovernmentIdentityKind(input.identityValue)
    const identityValue = normalizePendingIdentity(identityKind, input.identityValue)
    const displayName = input.displayName.trim()
    if (!displayName || displayName.length > 256) throw new Error('Display name is required and must not exceed 256 characters')
    const email = input.email?.trim().toLowerCase()
    if (email && !isEmail(email)) throw new Error('Optional contact email is invalid')
    const invitation = this.db.createInvitation({
      identityKind, identityValue, displayName,
      ...(commercial ? { email: identityValue } : email ? { email } : {}),
      role: input.role, authMethod: commercial ? 'oidc' : 'mtls', invitedBy: actor.id,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    })
    this.audit.append({
      actorId: actor.id, action: 'CreateInvitation', resourceType: 'Invitation', resourceId: invitation.id,
      decision: 'info', metadata: {
        identityKind: invitation.identityKind, identityValue: invitation.identityValue,
        displayName, email: invitation.email ?? null, role: input.role, authMethod: invitation.authMethod, expiresAt: invitation.expiresAt,
      },
    })
    return invitation
  }

  cancelInvitation(actor: Principal, invitationId: string): Invitation {
    this.check(actor, 'ManageUsers', { type: 'Deployment', id: this.license.deploymentId })
    const invitation = this.db.cancelInvitation(invitationId)
    if (!invitation) throw new Error('Pending invitation not found')
    this.audit.append({ actorId: actor.id, action: 'CancelInvitation', resourceType: 'Invitation', resourceId: invitation.id, decision: 'info', metadata: { email: invitation.email, role: invitation.role } })
    return invitation
  }

  assignRole(actor: Principal, userId: string, role: Role): Principal {
    this.check(actor, 'ManageUsers', { type: 'Deployment', id: this.license.deploymentId })
    const target = this.protectUserAdministration(actor, userId, 'AssignRole')
    if (['Owner', 'Admin'].includes(role) && !actor.roles.includes('Owner')) {
      this.audit.append({ actorId: actor.id, action: 'AssignRole', resourceType: 'User', resourceId: userId, decision: 'deny', metadata: { role, reason: 'privileged_role_requires_owner' } })
      throw new AuthorizationDenied('AssignPrivilegedRole', userId)
    }
    this.db.setRole(userId, role)
    this.db.incrementTokenVersion(userId)
    this.audit.append({ actorId: actor.id, action: 'AssignRole', resourceType: 'User', resourceId: userId, decision: 'info', metadata: { role, previousRoles: target.roles, resultingRoles: [...new Set([...target.roles, role])], revokedSessions: true } })
    return this.db.getPrincipal(userId) as Principal
  }

  revokeSessions(actor: Principal, userId: string): void {
    this.check(actor, 'ManageUsers', { type: 'Deployment', id: this.license.deploymentId })
    this.protectUserAdministration(actor, userId, 'RevokeSessions')
    this.db.incrementTokenVersion(userId)
    this.audit.append({ actorId: actor.id, action: 'RevokeSessions', resourceType: 'User', resourceId: userId, decision: 'info', metadata: {} })
  }

  listUsers(actor: Principal): Principal[] {
    this.check(actor, 'ManageUsers', { type: 'Deployment', id: this.license.deploymentId })
    return this.db.listPrincipals()
  }

  private protectUserAdministration(actor: Principal, userId: string, action: string): Principal {
    const target = this.db.getPrincipal(userId)
    const reason = actor.id === userId ? 'self_administration_forbidden'
      : target?.roles.includes('Owner') ? 'owner_is_protected'
      : actor.roles.includes('Admin') && target?.roles.includes('Admin') ? 'admin_peer_is_protected'
      : undefined
    if (!target || reason) {
      this.audit.append({ actorId: actor.id, action, resourceType: 'User', resourceId: userId, decision: 'deny', metadata: { reason: reason ?? 'user_not_found' } })
      throw new AuthorizationDenied(action, userId)
    }
    return target
  }

  createEnvironment(actor: Principal, input: Pick<Environment, 'name' | 'description'>): Environment {
    this.license.require('gateway')
    this.check(actor, 'ManageEnvironments', { type: 'Deployment', id: this.license.deploymentId })
    const environment = this.db.createEnvironment(input)
    this.db.assign('user', actor.id, 'environment', environment.id)
    this.audit.append({ actorId: actor.id, action: 'CreateEnvironment', resourceType: 'Environment', resourceId: environment.id, decision: 'info', metadata: { name: environment.name } })
    return environment
  }

  listEnvironments(actor: Principal): Environment[] {
    return this.db.listEnvironments().filter((environment) => this.decide(actor, 'ReadEnvironment', this.environmentResource(environment.id)).allowed)
  }

  assign(actor: Principal, principalId: string, resourceId: string): void {
    this.check(actor, 'AssignResources', { type: 'Deployment', id: this.license.deploymentId })
    this.db.assign('user', principalId, 'environment', resourceId)
    this.audit.append({ actorId: actor.id, action: 'AssignResource', resourceType: 'Environment', resourceId, decision: 'info', metadata: { principalId } })
  }

  createSession(actor: Principal, executionTargetId: string | undefined, agent: string, title: string, cwd = '/', surface: SessionSurface = 'general'): Session {
    this.license.require('gateway')
    const target = executionTargetId ? this.db.getEnvironment(executionTargetId) : this.defaultExecutionTarget(actor)
    if (!target) throw new Error('Execution target not found')
    this.check(actor, 'CreateSession', this.environmentResource(target.id))
    if (agent !== 'papyrus') throw new Error('Papyrus is the only supported session engine')
    if (!isAbsoluteClientPath(cwd)) throw new Error('Session cwd must be an absolute path')
    if (!SESSION_SURFACES.includes(surface)) throw new Error('Unsupported session surface')
    const session = this.db.createSession(actor.id, target.id, agent, title, cwd, surface)
    this.audit.append({ actorId: actor.id, action: 'CreateSession', resourceType: 'Session', resourceId: session.id, decision: 'info', metadata: { executionTargetId: target.id, agent, cwd, surface } })
    return session
  }

  private defaultExecutionTarget(actor: Principal): Environment {
    const settingKey = 'defaultExecutionTargetId'
    const configuredId = this.db.getSetting(settingKey)
    let target = configuredId ? this.db.getEnvironment(configuredId) : undefined
    if (!target) {
      target = this.db.createEnvironment({
        name: 'Deployment default',
        description: 'Internal execution target used when a session does not request an explicit enclave or runtime.',
      })
      this.db.setSetting(settingKey, target.id)
    }
    if (actor.roles.includes('User') && !this.db.isAssigned(actor.id, 'environment', target.id)) {
      this.db.assign('user', actor.id, 'environment', target.id)
    }
    return target
  }

  listSessions(actor: Principal): Session[] {
    return this.db.listSessions().filter((session) => this.decide(actor, 'ReadSession', this.sessionResource(session)).allowed)
  }

  getSession(actor: Principal, sessionId: string): Session {
    const session = this.requireSession(sessionId)
    this.check(actor, 'ReadSession', this.sessionResource(session))
    return session
  }

  async sessionGoal(actor: Principal, sessionId: string): Promise<unknown> {
    this.getSession(actor, sessionId)
    const agent = this.mastra.getAgent('papyrus')
    return await agent.getObjective({ threadId: sessionId })
  }

  async setSessionGoal(actor: Principal, sessionId: string, objective: string): Promise<unknown> {
    const session = this.requireSession(sessionId)
    this.check(actor, 'PromptSession', this.sessionResource(session))
    const agent = this.mastra.getAgent('papyrus')
    const result = await agent.setObjective(objective, { threadId: sessionId, resourceId: actor.id })
    this.audit.append({ actorId: actor.id, action: 'SetSessionGoal', resourceType: 'Session', resourceId: sessionId, decision: 'info', metadata: { objectiveBytes: Buffer.byteLength(objective) } })
    return result
  }

  async clearSessionGoal(actor: Principal, sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId)
    this.check(actor, 'PromptSession', this.sessionResource(session))
    const agent = this.mastra.getAgent('papyrus')
    await agent.clearObjective({ threadId: sessionId })
    this.audit.append({ actorId: actor.id, action: 'ClearSessionGoal', resourceType: 'Session', resourceId: sessionId, decision: 'info', metadata: {} })
  }

  async browserStream(actor: Principal, sessionId: string): Promise<Awaited<ReturnType<PapyrusWorkspaceManager['browser']['startScreencast']>>> {
    this.checkNativeBrowser(actor, sessionId)
    const workspaces = requireWorkspaces(this.workspaces)
    await workspaces.forSession(sessionId)
    this.checkNativeBrowser(actor, sessionId)
    if (!workspaces.browser.isBrowserRunning(sessionId)) await workspaces.browser.launch(sessionId)
    this.checkNativeBrowser(actor, sessionId)
    return await workspaces.browser.startScreencast({ threadId: sessionId, format: 'jpeg', quality: 72, maxWidth: 1440, maxHeight: 900 })
  }

  async browserInput(actor: Principal, sessionId: string, input: Record<string, unknown>): Promise<void> {
    this.checkNativeBrowser(actor, sessionId)
    const workspaces = requireWorkspaces(this.workspaces)
    await workspaces.forSession(sessionId)
    this.checkNativeBrowser(actor, sessionId)
    if (input.kind === 'mouse') await workspaces.browser.injectMouseEvent(input.event as never, sessionId)
    else if (input.kind === 'keyboard') await workspaces.browser.injectKeyboardEvent(input.event as never, sessionId)
    else throw new Error('Unsupported browser input')
    this.audit.append({ actorId: actor.id, action: 'BrowserInput', resourceType: 'Session', resourceId: sessionId, decision: 'info', metadata: { kind: input.kind } })
  }

  // BrowserViewer exposes an unrestricted browser: page scripts and raw input
  // can submit, download, or use credentials. Do not label this a read-only
  // capability. Restricted Users use separately governed MCP browser tools.
  private checkNativeBrowser(actor: Principal, sessionId: string): void {
    actor = this.liveActor(actor)
    const session = this.requireSession(sessionId)
    this.check(actor, 'PromptSession', this.sessionResource(session))
    this.check(actor, 'ReadEnvironment', this.environmentResource(session.environmentId))
    const resource = this.runtimeToolResource(session, 'native-browser')
    for (const action of BROWSER_POLICY_ACTIONS) this.check(actor, action, resource)
  }

  async browse(actor: Principal, sessionId: string, operation: 'navigate' | 'read', url?: string): Promise<unknown> {
    this.checkNativeBrowser(actor, sessionId)
    if (operation !== 'navigate' && operation !== 'read') throw new Error('Unsupported browser operation')
    const browser = requireWorkspaces(this.workspaces).browser
    if (operation === 'navigate') {
      const parsed = new URL(url ?? '')
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Browser navigation requires an HTTP(S) URL without credentials')
      await browser.navigate(sessionId, parsed.href)
    }
    // Recheck after asynchronous navigation before returning browser content.
    this.checkNativeBrowser(actor, sessionId)
    return await browser.readPage(sessionId)
  }

  private liveActor(actor: Principal): Principal {
    const current = this.db.getPrincipal(actor.id)
    if (!current) {
      this.audit.append({ actorId: actor.id, action: 'InvokeTool', resourceType: 'Deployment', resourceId: 'identity', decision: 'deny', metadata: { reason: 'Identity no longer exists' } })
      throw new AuthorizationDenied('InvokeTool', actor.id)
    }
    return current
  }

  private runtimeToolResource(session: Session, name: string): AuthorizationResource {
    return { type: 'Tool', id: `${session.id}:${name}`, attrs: { assignedUsers: cedarUsers(this.db.assignedUserIds('environment', session.environmentId)) } }
  }

  /** Called by Mastra's execution hook, not by its post-execution stream. */
  checkToolExecution(actor: Principal, sessionId: string, name: string): void {
    actor = this.liveActor(actor)
    const session = this.requireSession(sessionId)
    this.check(actor, 'PromptSession', this.sessionResource(session))
    this.check(actor, 'ReadEnvironment', this.environmentResource(session.environmentId))
    const action = runtimeToolAction(name)
    if (action) {
      this.check(actor, action, this.runtimeToolResource(session, name))
      if (name === 'papyrus_browser_navigate' || name === 'papyrus_browser_read') this.checkNativeBrowser(actor, sessionId)
      this.audit.append({ actorId: actor.id, action: 'InvokeTool', resourceType: 'Tool', resourceId: `${sessionId}:${name}`, decision: 'allow', metadata: { sessionId, toolName: name, policyAction: action, transport: 'mastra-builtin' } })
      return
    }
    if (this.isToolCallAllowed(actor, session, name)) return
    this.audit.append({ actorId: actor.id, action: 'InvokeTool', resourceType: 'Tool', resourceId: `${sessionId}:${name}`, decision: 'deny', metadata: { sessionId, reason: 'Tool is unknown or not granted' } })
    throw new AuthorizationDenied('InvokeTool', name)
  }

  defaultGatewayAgent(): string { return 'papyrus' }

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

  sessionArtifacts(actor: Principal, sessionId: string): ProjectedArtifact[] {
    const session = this.requireSession(sessionId)
    this.check(actor, 'ReadSession', this.sessionResource(session))
    return projectArtifacts(sessionId, this.db.listSessionEvents(sessionId, 0, Number.MAX_SAFE_INTEGER))
  }

  sessionAttachments(actor: Principal, sessionId: string): Attachment[] {
    const session = this.requireSession(sessionId)
    this.check(actor, 'ReadSession', this.sessionResource(session))
    return this.db.listAttachments(sessionId).map((attachment) => ({
      ...attachment,
      downloadUrl: `/api/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(attachment.id)}/download`,
    }))
  }

  addAttachment(actor: Principal, sessionId: string, name: string, mediaType: string, content: Buffer): Attachment {
    const session = this.requireSession(sessionId)
    this.check(actor, 'PromptSession', this.sessionResource(session))
    if (content.length === 0 || content.length > 10 * 1024 * 1024) throw new Error('Attachment must be between 1 byte and 10 MB')
    if (!allowedAttachmentType(mediaType)) throw new Error(`Attachment type "${mediaType}" is not allowed`)
    const safeName = name.replace(/[\u0000-\u001f\u007f/\\]/g, '_').trim().slice(0, 180) || 'attachment'
    const attachment = this.db.createAttachment(sessionId, safeName, mediaType, content, createHash('sha256').update(content).digest('hex'))
    this.audit.append({ actorId: actor.id, action: 'UploadAttachment', resourceType: 'Attachment', resourceId: attachment.id, decision: 'info', metadata: { sessionId, name: safeName, mediaType, size: content.length, sha256: attachment.sha256 } })
    return { ...attachment, downloadUrl: `/api/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(attachment.id)}/download` }
  }

  attachmentContent(actor: Principal, sessionId: string, attachmentId: string): Attachment & { content: Buffer } {
    const session = this.requireSession(sessionId)
    this.check(actor, 'ReadSession', this.sessionResource(session))
    const attachment = this.db.getAttachment(attachmentId)
    if (!attachment || attachment.sessionId !== sessionId) throw new Error('Attachment not found')
    return attachment
  }

  sessionApprovals(actor: Principal, sessionId: string): Approval[] {
    const session = this.requireSession(sessionId)
    this.check(actor, 'ReadSession', this.sessionResource(session))
    return this.db.listApprovals(sessionId)
  }

  sessionElicitations(actor: Principal, sessionId: string): Elicitation[] {
    const session = this.requireSession(sessionId)
    this.check(actor, 'ReadSession', this.sessionResource(session))
    return this.db.listElicitations(sessionId)
  }

  respondElicitation(actor: Principal, sessionId: string, elicitationId: string, response: Record<string, unknown>): Elicitation {
    const session = this.requireSession(sessionId)
    this.check(actor, 'PromptSession', this.sessionResource(session))
    const existing = this.db.listElicitations(sessionId).find((item) => item.id === elicitationId)
    if (!existing) throw new Error('Elicitation not found')
    const elicitation = this.db.respondElicitation(elicitationId, response)
    if (!elicitation) throw new Error('Elicitation already answered')
    this.db.addRuntimeEvent(sessionId, existing.runId, 'elicitation', new Date().toISOString(), elicitation)
    this.pendingElicitationResolvers.get(elicitationId)?.(response)
    return elicitation
  }

  sessionSources(actor: Principal, sessionId: string): ResearchSource[] {
    const session = this.requireSession(sessionId)
    this.check(actor, 'ReadSession', this.sessionResource(session))
    return projectResearchSources(sessionId, this.db.listSessionEvents(sessionId, 0, Number.MAX_SAFE_INTEGER))
  }

  researchSources(actor: Principal): ResearchSource[] {
    return this.listSessions(actor).flatMap((session) => projectResearchSources(session.id, this.db.listSessionEvents(session.id, 0, Number.MAX_SAFE_INTEGER)))
      .sort((left, right) => right.sequence - left.sequence)
  }

  decideApproval(actor: Principal, sessionId: string, approvalId: string, decision: 'approved' | 'denied', reason?: string): Approval {
    const session = this.requireSession(sessionId)
    this.check(actor, 'DecideApproval', this.sessionResource(session))
    const existing = this.db.getApproval(approvalId)
    if (!existing) throw new ApprovalLifecycleError('APPROVAL_NOT_FOUND', 'Approval not found')
    if (existing.sessionId !== sessionId) throw new ApprovalLifecycleError('APPROVAL_SESSION_MISMATCH', 'Approval does not belong to this session')
    const approval = this.db.decideApproval(approvalId, decision, actor.id, reason)
    if (!approval) throw new ApprovalLifecycleError('APPROVAL_ALREADY_DECIDED', 'Approval has already been decided')
    this.recordApprovalEvent(approval)
    this.audit.append({
      actorId: actor.id, action: 'DecideApproval', resourceType: 'Approval', resourceId: approval.id,
      decision: decision === 'approved' ? 'allow' : 'deny', metadata: { sessionId, runId: approval.runId, toolTitle: approval.toolTitle, reason: reason ?? null },
    })
    this.pendingApprovalResolvers.get(approval.id)?.(decision === 'approved')
    return approval
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

  deleteSession(actor: Principal, sessionId: string): void {
    const session = this.requireSession(sessionId)
    this.check(actor, 'DeleteSession', this.sessionResource(session))
    const active = this.activeSessionRuns.get(sessionId)
    if (active) throw new SessionLifecycleError('SESSION_BUSY', 'Cancel the active run before deleting this session')
    if (!this.db.deleteSession(sessionId)) throw new SessionLifecycleError('SESSION_NOT_FOUND', 'Session not found')
    this.audit.append({ actorId: actor.id, action: 'DeleteSession', resourceType: 'Session', resourceId: sessionId, decision: 'info', metadata: { title: session.title } })
  }

  sessionConfigOptions(actor: Principal, sessionId: string): SessionConfigOption[] {
    const session = this.getSession(actor, sessionId)
    return sessionSurfaceConfig(session.surface)
  }

  setSessionConfigOption(actor: Principal, sessionId: string, configId: string, value: string): SessionConfigOption[] {
    const session = this.requireSession(sessionId)
    this.check(actor, 'SetSessionConfig', this.sessionResource(session))
    if (configId !== 'papyrus.surface') throw new SessionLifecycleError('INVALID_CONFIG_OPTION', 'Unsupported session configuration option')
    if (!SESSION_SURFACES.includes(value as SessionSurface)) throw new SessionLifecycleError('INVALID_CONFIG_VALUE', 'Unsupported session surface')
    const surface = value as SessionSurface
    this.db.setSessionSurface(sessionId, surface)
    const configOptions = sessionSurfaceConfig(surface)
    this.db.addRuntimeEvent(sessionId, undefined, 'update', new Date().toISOString(), { sessionUpdate: 'config_option_update', configOptions })
    this.audit.append({ actorId: actor.id, action: 'SetSessionSurface', resourceType: 'Session', resourceId: sessionId, decision: 'info', metadata: { previousSurface: session.surface, surface } })
    return configOptions
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

  async startPrompt(actor: Principal, sessionId: string, prompt: string, attachmentIds: string[] = []): Promise<SessionRun> {
    let started: SessionRun | undefined
    const completion = this.prompt(actor, sessionId, prompt, {
      attachmentIds,
      onRunStarted: (run) => { started = run },
    })
    if (!started) {
      // Preserve authorization, lifecycle, and validation errors raised before a
      // durable run is accepted. A successful prompt always invokes onRunStarted
      // before its first asynchronous boundary.
      await completion
      throw new Error('Prompt could not be started')
    }
    // The run belongs to the daemon, not to the browser request that submitted it.
    // prompt() persists failures and terminal state before rejecting.
    void completion.catch(() => undefined)
    return started
  }

  async prompt(actor: Principal, sessionId: string, prompt: string, options: SessionPromptOptions = {}): Promise<{ stopReason: string; events: RuntimeEvent[] }> {
    this.license.require('gateway')
    actor = this.liveActor(actor)
    const session = this.requireSession(sessionId)
    this.check(actor, 'PromptSession', this.sessionResource(session))
    this.check(actor, 'ReadEnvironment', this.environmentResource(session.environmentId))
    const events: RuntimeEvent[] = []
    const attachments = [...new Set(options.attachmentIds ?? [])].map((id) => {
      const attachment = this.db.getAttachment(id)
      if (!attachment || attachment.sessionId !== sessionId) throw new Error('Attachment does not belong to this session')
      return attachment
    })
    const contentBlocks: ContentBlock[] = [
      ...(prompt ? [{ type: 'text' as const, text: prompt }] : []),
      ...attachments.map((attachment): ContentBlock => attachmentContentBlock(sessionId, attachment)),
    ]
    const displayedBlocks: ContentBlock[] = [
      ...(prompt ? [{ type: 'text' as const, text: prompt }] : []),
      ...attachments.map((attachment): ContentBlock => ({
        type: 'resource_link',
        uri: attachmentUri(sessionId, attachment),
        name: attachment.name,
        title: attachment.name,
        mimeType: attachment.mediaType,
        size: attachment.size,
      })),
    ]
    const run = this.beginRun(session, actor, options.signal)
    const persistentRun = this.db.getSessionRun(run.runId) as SessionRun
    options.onRunStarted?.(persistentRun)
    this.db.addRuntimeEvent(session.id, run.runId, 'run', persistentRun.startedAt, {
      sessionUpdate: 'run_started', status: 'running', runId: run.runId,
    })
    try {
      const runtime = this.runtimeFactory({ promptTimeoutMs: this.config.promptTimeoutMs })
      for (const content of displayedBlocks) {
        this.db.addRuntimeEvent(session.id, run.runId, 'update', new Date().toISOString(), {
          sessionUpdate: 'user_message_chunk',
          content,
          messageId: `user_${run.runId}`,
        })
      }
      this.audit.append({ actorId: actor.id, action: 'PromptSession', resourceType: 'Session', resourceId: session.id, decision: 'info', metadata: { promptBytes: Buffer.byteLength(prompt), attachmentIds: attachments.map((item) => item.id), runId: run.runId } })
      const result = await runtime.runPrompt({
        sessionId: session.id,
        resourceId: actor.id,
        runId: run.runId,
        cwd: session.cwd,
        prompt: attachments.length ? contentBlocks : prompt,
        tools: await this.nativeTools(session),
        invokeTool: async (name, args) => {
          // Approval can wait arbitrarily long; recheck revocations afterward.
          run.controller.signal.throwIfAborted()
          this.checkToolExecution(actor, session.id, name)
          if (name.startsWith('papyrus_sources_')) return this.invokeSourceTool(actor, name, args)
          const [mcpServerId] = this.findTool(session.environmentId, name)
          if (!mcpServerId) throw new AuthorizationDenied('InvokeTool', name)
          return await this.invokeTool(actor, session.id, mcpServerId, name, args)
        },
        authorizeTool: async (title) => this.requestToolApproval(actor, session, run.runId, title, run.controller.signal),
        checkToolExecution: async (name) => {
          run.controller.signal.throwIfAborted()
          this.checkToolExecution(actor, session.id, name)
        },
        browse: async (operation, url) => this.browse(actor, session.id, operation, url),
        elicit: async (request) => this.requestElicitation(session, run.runId, request, run.controller.signal),
        setGoal: async (objective) => await this.setSessionGoal(actor, session.id, objective),
        onEvent: async (event) => {
          events.push(event)
          this.db.addRuntimeEvent(session.id, run.runId, event.kind, event.at, event.data)
          await options.onEvent?.(event)
        },
        signal: run.controller.signal,
      })
      const cancelled = run.controller.signal.aborted || result.stopReason === 'cancelled'
      const status = cancelled ? 'cancelled' : 'completed'
      this.db.finishSessionRun(run.runId, status, cancelled ? 'cancelled' : result.stopReason)
      this.db.addRuntimeEvent(session.id, run.runId, 'run', new Date().toISOString(), {
        sessionUpdate: 'run_completed', status, runId: run.runId, stopReason: cancelled ? 'cancelled' : result.stopReason,
      })
      return { stopReason: result.stopReason, events }
    } catch (error) {
      if (run.controller.signal.aborted) {
        this.db.finishSessionRun(run.runId, 'cancelled', 'cancelled')
        this.db.addRuntimeEvent(session.id, run.runId, 'run', new Date().toISOString(), {
          sessionUpdate: 'run_completed', status: 'cancelled', runId: run.runId, stopReason: 'cancelled',
        })
        return { stopReason: 'cancelled', events }
      }
      const message = safeError(error)
      this.db.finishSessionRun(run.runId, 'failed', 'error', message)
      this.db.addRuntimeEvent(session.id, run.runId, 'run', new Date().toISOString(), {
        sessionUpdate: 'run_completed', status: 'failed', runId: run.runId, stopReason: 'error', error: message,
      })
      this.audit.append({ actorId: actor.id, action: 'RuntimeFailure', resourceType: 'Session', resourceId: session.id, decision: 'info', metadata: { error: message, runId: run.runId } })
      throw error
    } finally {
      run.detachSignal?.()
      if (this.activeSessionRuns.get(sessionId)?.runId === run.runId) this.activeSessionRuns.delete(sessionId)
      run.resolveSettled()
    }
  }

  async addMcpServer(actor: Principal, input: Pick<McpServer, 'name' | 'endpoint'>): Promise<{ server: McpServer; authorizationUrl?: string }> {
    this.check(actor, 'ManageTools', { type: 'Deployment', id: this.license.deploymentId })
    const parsed = new URL(normalizeMcpEndpoint(input.endpoint))
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['127.0.0.1', '::1', 'localhost'].includes(parsed.hostname))) throw new Error('Remote MCP endpoints must use HTTPS')
    const redirectUri = `${this.config.publicOrigin}/api/mcp/oauth/callback`
    const oauth = await registerRemoteMcp(parsed.toString(), redirectUri, `Papyrus — ${input.name}`)
    if (!oauth) await validateMcpServer(parsed.toString())
    const server = this.db.addMcpServer({ ...input, endpoint: parsed.toString(), oauthStatus: oauth ? 'authorization_required' : 'not_required', ...(oauth ? { oauthIssuer: oauth.issuer } : {}) })
    if (oauth) this.db.createMcpOauthPending({ state: oauth.state, serverId: server.id, actorId: actor.id, issuer: oauth.issuer, tokenEndpoint: oauth.tokenEndpoint, clientId: oauth.clientId, ...(oauth.clientSecret ? { clientSecret: this.seal(oauth.clientSecret) } : {}), verifier: this.seal(oauth.verifier), redirectUri, resource: oauth.resource })
    this.audit.append({ actorId: actor.id, action: 'AddMcpServer', resourceType: 'McpServer', resourceId: server.id, decision: 'info', metadata: { name: server.name } })
    return { server, ...(oauth ? { authorizationUrl: oauth.authorizationUrl } : {}) }
  }

  async completeMcpOauth(actor: Principal, state: string, code: string): Promise<McpServer> {
    const pending = this.db.getMcpOauthPending(state)
    if (!pending || String(pending.actor_id) !== actor.id) throw new Error('OAuth state is invalid or expired')
    const token = await exchangeMcpCode({ ...pending, verifier: this.open(String(pending.verifier)), ...(pending.client_secret ? { client_secret: this.open(String(pending.client_secret)) } : {}) }, code)
    const pendingServer = this.db.getMcpServer(String(pending.server_id))
    if (!pendingServer) throw new Error('MCP server registration was not found')
    await validateMcpServer(pendingServer.endpoint, token.accessToken)
    const server = this.db.finishMcpOauth(state, this.seal(token.accessToken), token.refreshToken ? this.seal(token.refreshToken) : undefined, token.expiresAt)
    if (!server) throw new Error('MCP server registration was not found')
    this.audit.append({ actorId: actor.id, action: 'AuthorizeMcpServer', resourceType: 'McpServer', resourceId: server.id, decision: 'allow', metadata: { issuer: server.oauthIssuer } })
    return server
  }

  listMcpServers(actor: Principal): McpServer[] {
    this.check(actor, 'ManageTools', { type: 'Deployment', id: this.license.deploymentId })
    return this.db.listMcpServers()
  }

  async retryMcpOauth(actor: Principal, serverId: string): Promise<{ server: McpServer; authorizationUrl: string }> {
    this.check(actor, 'ManageTools', { type: 'Deployment', id: this.license.deploymentId })
    const existing = this.db.getMcpServer(serverId)
    if (!existing) throw new Error('MCP server not found')
    if (existing.oauthStatus !== 'authorization_required' && existing.oauthStatus !== 'error') throw new Error('MCP server does not require OAuth authorization')
    const redirectUri = `${this.config.publicOrigin}/api/mcp/oauth/callback`
    const oauth = await registerRemoteMcp(existing.endpoint, redirectUri, `Papyrus — ${existing.name}`)
    if (!oauth) throw new Error('MCP server no longer requires OAuth; delete it and connect it again')
    this.db.replaceMcpOauthPending({ state: oauth.state, serverId, actorId: actor.id, issuer: oauth.issuer, tokenEndpoint: oauth.tokenEndpoint, clientId: oauth.clientId, ...(oauth.clientSecret ? { clientSecret: this.seal(oauth.clientSecret) } : {}), verifier: this.seal(oauth.verifier), redirectUri, resource: oauth.resource })
    const server = this.db.getMcpServer(serverId)
    if (!server) throw new Error('MCP server not found')
    this.audit.append({ actorId: actor.id, action: 'RetryMcpAuthorization', resourceType: 'McpServer', resourceId: serverId, decision: 'info', metadata: { issuer: oauth.issuer } })
    return { server, authorizationUrl: oauth.authorizationUrl }
  }

  deleteMcpServer(actor: Principal, serverId: string): void {
    this.check(actor, 'ManageTools', { type: 'Deployment', id: this.license.deploymentId })
    const server = this.db.getMcpServer(serverId)
    if (!server || !this.db.deleteMcpServer(serverId)) throw new Error('MCP server not found')
    this.audit.append({ actorId: actor.id, action: 'DeleteMcpServer', resourceType: 'McpServer', resourceId: serverId, decision: 'info', metadata: { name: server.name, endpoint: server.endpoint } })
  }

  setMcpServerEnabled(actor: Principal, serverId: string, enabled: boolean): McpServer {
    this.check(actor, 'ManageTools', { type: 'Deployment', id: this.license.deploymentId })
    const server = this.db.setMcpServerEnabled(serverId, enabled)
    if (!server) throw new Error('MCP server not found')
    this.audit.append({ actorId: actor.id, action: 'SetMcpServerEnabled', resourceType: 'McpServer', resourceId: serverId, decision: 'info', metadata: { enabled } })
    return server
  }

  grantMcpServer(actor: Principal, environmentId: string, mcpServerId: string): void {
    this.check(actor, 'ManageTools', { type: 'Deployment', id: this.license.deploymentId })
    if (!this.db.getEnvironment(environmentId)) throw new Error('Environment not found')
    if (!this.db.getMcpServer(mcpServerId)) throw new Error('MCP server not found')
    this.db.grantMcpServer(environmentId, mcpServerId)
    this.audit.append({ actorId: actor.id, action: 'GrantMcpServer', resourceType: 'McpServer', resourceId: mcpServerId, decision: 'info', metadata: { environmentId } })
  }

  revokeToolGrant(actor: Principal, grantId: string): void {
    this.check(actor, 'ManageTools', { type: 'Deployment', id: this.license.deploymentId })
    if (!this.db.revokeToolGrant(grantId)) throw new Error('Tool grant not found')
    this.audit.append({ actorId: actor.id, action: 'RevokeTool', resourceType: 'ToolGrant', resourceId: grantId, decision: 'info', metadata: {} })
  }

  listApprovedSources(actor: Principal): ApprovedSource[] {
    return this.sources.listForUser(actor.id)
  }

  searchApprovedSources(actor: Principal, query: string, limit = 10): SourceSearchResult[] {
    const results = this.sources.search(actor.id, query, limit)
    this.audit.append({ actorId: actor.id, action: 'SearchSources', resourceType: 'Source', resourceId: 'assigned', decision: 'allow', metadata: { queryHash: createHash('sha256').update(query).digest('hex'), resultCount: results.length } })
    return results
  }

  readApprovedSource(actor: Principal, chunkId: string): SourceSearchResult {
    const result = this.sources.read(actor.id, chunkId)
    if (!result) throw new AuthorizationDenied('ReadSource', chunkId)
    this.audit.append({ actorId: actor.id, action: 'ReadSource', resourceType: 'Source', resourceId: result.citation.sourceId, decision: 'allow', metadata: { chunkId, sha256: result.citation.sha256 } })
    return result
  }

  createApprovedSource(actor: Principal, input: { name: string; kind: ApprovedSourceKind; locator: string; mode: 'snapshot'|'live' }): ApprovedSource {
    this.check(actor, 'ManageTools', { type: 'Deployment', id: this.license.deploymentId })
    if (!['upload','domain','mcp','api'].includes(input.kind)) throw new Error('Unsupported approved source type')
    if (input.kind === 'domain') {
      const domain = new URL(input.locator)
      if (domain.protocol !== 'https:' || domain.username || domain.password || domain.port || domain.pathname !== '/' || domain.search || domain.hash) throw new Error('Domain sources must be credential-free HTTPS origins')
    }
    if (input.kind === 'api') {
      const endpoint = new URL(input.locator)
      if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['127.0.0.1','::1','localhost'].includes(endpoint.hostname))) throw new Error('API sources must use HTTPS')
    }
    if (input.kind === 'mcp') {
      const server = this.db.getMcpServer(input.locator)
      if (!server?.enabled || server.oauthStatus === 'authorization_required' || server.oauthStatus === 'error') throw new Error('Choose an enabled, validated MCP connection')
    }
    const source = this.sources.create(input.name, input.kind, input.locator, input.mode)
    this.audit.append({ actorId: actor.id, action: 'CreateSource', resourceType: 'Source', resourceId: source.id, decision: 'info', metadata: { kind: source.kind, mode: source.mode } })
    return this.sources.get(source.id)!
  }

  assignApprovedSource(actor: Principal, sourceId: string, userId: string, assigned: boolean): void {
    this.check(actor, 'AssignResources', { type: 'Deployment', id: this.license.deploymentId })
    if (assigned) this.sources.assign(sourceId,userId); else this.sources.unassign(sourceId,userId)
    this.audit.append({ actorId: actor.id, action: assigned ? 'AssignSource' : 'UnassignSource', resourceType: 'Source', resourceId: sourceId, decision: 'info', metadata: { userId } })
  }

  ingestApprovedSource(actor: Principal, sourceId: string, input: { uri: string; title: string; mediaType: string; content: string }): void {
    this.check(actor, 'ManageTools', { type: 'Deployment', id: this.license.deploymentId })
    this.sources.ingest(sourceId,input.uri,input.title,input.mediaType,input.content)
    this.audit.append({ actorId: actor.id, action: 'IndexSource', resourceType: 'Source', resourceId: sourceId, decision: 'info', metadata: { uri: input.uri, bytes: Buffer.byteLength(input.content) } })
  }

  adminOverview(actor: Principal): AdminOverview {
    this.check(actor, 'ManageUsers', { type: 'Deployment', id: this.license.deploymentId })
    return {
      deployment: {
        topology: 'on-premises', profile: this.config.profile, publicOrigin: this.config.publicOrigin,
        authentication: this.config.profile.startsWith('government') ? 'mtls' : this.config.oidc ? 'oidc' : this.config.identityProxy ? 'trusted-proxy' : 'none',
        organizationName: this.config.branding.organizationName,
        ...(this.config.branding.organizationDomain ? { organizationDomain: this.config.branding.organizationDomain } : {}),
        mtlsConfigured: Boolean(this.config.tls),
        identityProxyConfigured: Boolean(this.config.identityProxy), gatewayConfigured: Boolean(this.config.gateway),
        licenseRequired: this.config.licenseRequired,
      },
      users: this.db.listPrincipals(),
      invitations: this.db.listInvitations(),
      environments: this.db.listEnvironments().map((environment) => ({ ...environment, assignedUserIds: this.db.assignedUserIds('environment', environment.id) })),
      sources: this.sources.listAll(),
      mcpServers: this.db.listMcpServers(), toolGrants: this.db.listToolGrants(),
      license: this.license.status(),
    }
  }

  async invokeTool(actor: Principal, sessionId: string, mcpServerId: string, toolName: string, args: unknown): Promise<unknown> {
    actor = this.liveActor(actor)
    const session = this.db.getSession(sessionId)
    if (!session) throw new Error('Session not found')
    this.check(actor, 'PromptSession', this.sessionResource(session))
    const resource = { type: 'Tool' as const, id: `${mcpServerId}:${toolName}`, attrs: { assignedUsers: cedarUsers(this.db.assignedUserIds('environment', session.environmentId)) } }
    this.check(actor, 'InvokeTool', resource)
    const connectorAction = connectorPolicyAction(toolName)
    if (connectorAction) this.check(actor, connectorAction, resource)
    if (!this.db.isToolGranted(session.environmentId, mcpServerId, toolName)) {
      this.audit.append({ actorId: actor.id, action: 'InvokeTool', resourceType: 'Tool', resourceId: `${mcpServerId}:${toolName}`, decision: 'deny', metadata: { sessionId, reason: 'MCP server is not enabled for environment' } })
      throw new AuthorizationDenied('InvokeTool', `${mcpServerId}:${toolName}`)
    }
    const server = this.db.getMcpServer(mcpServerId)
    if (!server?.enabled) throw new Error('MCP server unavailable')
    const started = Date.now()
    try {
      const result = await callMcpTool(server.endpoint, this.mcpAccessToken(server.id), toolName, args)
      this.audit.append({ actorId: actor.id, action: 'InvokeTool', resourceType: 'Tool', resourceId: `${mcpServerId}:${toolName}`, decision: 'allow', metadata: { sessionId, durationMs: Date.now() - started, transport: 'mcp-typescript-sdk' } })
      return result
    } catch (error) {
      this.audit.append({ actorId: actor.id, action: 'InvokeTool', resourceType: 'Tool', resourceId: `${mcpServerId}:${toolName}`, decision: 'deny', metadata: { sessionId, durationMs: Date.now() - started, transport: 'mcp-typescript-sdk', error: safeError(error) } })
      throw error
    }
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
      const result = await this.forwardRuntimeMcp(server.endpoint, message, this.mcpAuthorization(server.id))
      if (result && typeof result === 'object') {
        const envelope = result as { result?: { tools?: Array<{ name?: string }> } }
        if (Array.isArray(envelope.result?.tools)) envelope.result.tools = envelope.result.tools.filter((tool) => typeof tool.name === 'string' && this.db.isToolGranted(session.environmentId, mcpServerId, tool.name))
      }
      this.audit.append({ actorId: actor.id, action: 'DiscoverTools', resourceType: 'McpServer', resourceId: mcpServerId, decision: 'allow', metadata: { sessionId } })
      return result
    }
    if (!['initialize', 'notifications/initialized', 'ping'].includes(method)) throw new AuthorizationDenied('McpMethod', method)
    return this.forwardRuntimeMcp(server.endpoint, message, this.mcpAuthorization(server.id))
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
  private environmentResource(id: string): AuthorizationResource { return { type: 'Environment', id, attrs: { assignedUsers: cedarUsers(this.db.assignedUserIds('environment', id)) } } }
  private sessionResource(session: Session): AuthorizationResource { return { type: 'Session', id: session.id, attrs: { owner: cedarUser(session.ownerId) } } }

  private findTool(environmentId: string, title: string): [string, string] {
    const row = this.db.sqlite.prepare("SELECT mcp_server_id FROM tool_grants WHERE workspace_id=? AND tool_name IN ('*',?) LIMIT 1").get(environmentId, title) as { mcp_server_id: string } | undefined
    return row ? [row.mcp_server_id, title] : ['', '']
  }

  /** Authorizes and audits a prompt against a Papyrus session (without running it). */
  authorizeSessionPrompt(actor: Principal, session: Session): void {
    this.check(actor, 'PromptSession', this.sessionResource(session))
    this.audit.append({ actorId: actor.id, action: 'PromptSession', resourceType: 'Session', resourceId: session.id, decision: 'info', metadata: {} })
  }

  /** Authorizes a tool call against the environment's registered MCP sources. */
  isToolCallAllowed(actor: Principal, session: Session, toolTitle: string): boolean {
    try {
      actor = this.liveActor(actor)
      this.check(actor, 'PromptSession', this.sessionResource(session))
      this.check(actor, 'ReadEnvironment', this.environmentResource(session.environmentId))
      if (['papyrus_sources_list', 'papyrus_sources_search', 'papyrus_sources_read'].includes(toolTitle)) {
        this.check(actor, 'InvokeTool', this.runtimeToolResource(session, toolTitle))
        return true // Individual source assignments are rechecked by invokeSourceTool.
      }
      const [mcpServerId, toolName] = this.findTool(session.environmentId, toolTitle)
      if (!mcpServerId || !toolName) return false
      const resource = { type: 'Tool' as const, id: `${mcpServerId}:${toolName}`, attrs: { assignedUsers: cedarUsers(this.db.assignedUserIds('environment', session.environmentId)) } }
      this.check(actor, 'InvokeTool', resource)
      const connectorAction = connectorPolicyAction(toolName)
      if (connectorAction) this.check(actor, connectorAction, resource)
      return this.db.isToolGranted(session.environmentId, mcpServerId, toolName)
    } catch { return false }
  }

  private async requestToolApproval(actor: Principal, session: Session, runId: string, toolTitle: string, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted || !this.isToolCallAllowed(actor, session, toolTitle)) return false
    const approval = this.db.createApproval(session.id, runId, actor.id, toolTitle)
    this.recordApprovalEvent(approval)
    this.audit.append({ actorId: actor.id, action: 'RequestApproval', resourceType: 'Approval', resourceId: approval.id, decision: 'info', metadata: { sessionId: session.id, runId, toolTitle } })
    return await new Promise<boolean>((resolve) => {
      let settled = false
      const finish = (approved: boolean) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', abort)
        this.pendingApprovalResolvers.delete(approval.id)
        resolve(approved)
      }
      const abort = () => {
        const cancelled = this.db.decideApproval(approval.id, 'cancelled', undefined, 'run_cancelled')
        if (cancelled) {
          this.recordApprovalEvent(cancelled)
          this.audit.append({ actorId: null, action: 'CancelApproval', resourceType: 'Approval', resourceId: approval.id, decision: 'info', metadata: { sessionId: session.id, runId, reason: 'run_cancelled' } })
        }
        finish(false)
      }
      this.pendingApprovalResolvers.set(approval.id, finish)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
  }

  private recordApprovalEvent(approval: Approval): void {
    this.db.addRuntimeEvent(approval.sessionId, approval.runId, 'approval', new Date().toISOString(), approval)
  }

  private async requestElicitation(session: Session, runId: string, request: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
    const elicitation = this.db.createElicitation(session.id, runId, request)
    this.db.addRuntimeEvent(session.id, runId, 'elicitation', new Date().toISOString(), elicitation)
    return await new Promise((resolve) => {
      const finish = (response: Record<string, unknown>) => {
        signal.removeEventListener('abort', abort)
        this.pendingElicitationResolvers.delete(elicitation.id)
        resolve(response)
      }
      const abort = () => finish({ action: 'cancel' })
      this.pendingElicitationResolvers.set(elicitation.id, finish)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
  }

  /** Discovers only the tools enabled for this session's authorization environment. */
  private invokeSourceTool(actor: Principal, name: string, args: unknown): unknown {
    actor = this.liveActor(actor)
    const input = args && typeof args === 'object' ? args as Record<string,unknown> : {}
    if (name === 'papyrus_sources_list') return { sources: this.listApprovedSources(actor) }
    if (name === 'papyrus_sources_search') return { results: this.searchApprovedSources(actor, textValue(input.query,'query'), typeof input.limit === 'number' ? input.limit : 10) }
    if (name === 'papyrus_sources_read') return this.readApprovedSource(actor,textValue(input.chunkId,'chunkId'))
    throw new Error('Unknown source tool')
  }

  private async nativeTools(session: Session): Promise<RuntimeTool[]> {
    const grantedServerIds = new Set(this.db.listToolGrants()
      .filter((grant) => grant.environmentId === session.environmentId)
      .map((grant) => grant.mcpServerId))
    const tools = new Map<string, RuntimeTool>()
    tools.set('papyrus_sources_list', { name: 'papyrus_sources_list', description: 'List only approved sources assigned to the current identity.', inputSchema: { type: 'object', properties: {} } })
    tools.set('papyrus_sources_search', { name: 'papyrus_sources_search', description: 'Search approved source content. Results include immutable citations and are filtered by live source assignments.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 20 } }, required: ['query'] } })
    tools.set('papyrus_sources_read', { name: 'papyrus_sources_read', description: 'Read a cited approved-source chunk. Access is rechecked against current assignments.', inputSchema: { type: 'object', properties: { chunkId: { type: 'string' } }, required: ['chunkId'] } })
    for (const server of this.db.listMcpServers()) {
      if (!server.enabled || !grantedServerIds.has(server.id)) continue
      const listed = await listMcpTools(server.endpoint, this.mcpAccessToken(server.id)).catch((error) => {
        this.audit.append({
          actorId: session.ownerId,
          action: 'DiscoverTools',
          resourceType: 'McpServer',
          resourceId: server.id,
          decision: 'deny',
          metadata: { sessionId: session.id, error: safeError(error) },
        })
        return []
      })
      for (const tool of listed) {
        if (tools.has(tool.name) || !this.db.isToolGranted(session.environmentId, server.id, tool.name)) continue
        tools.set(tool.name, {
          name: tool.name,
          ...(tool.description ? { description: tool.description } : {}),
          inputSchema: tool.inputSchema,
        })
      }
    }
    return [...tools.values()]
  }

  /** Session-bound Papyrus MCP proxy endpoints for the runtime to consume. */
  runtimeMcpServers(session: Session): Array<{ name: string; url: string; headers: Array<{ name: string; value: string }> }> {
    return this.db.listGrantedMcpServers(session.environmentId).map((server) => ({
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

  private mcpAccessToken(serverId: string): string | undefined {
    const token = this.db.mcpAccessToken(serverId)
    return token ? this.open(token) : undefined
  }

  private mcpAuthorization(serverId: string): Record<string, string> {
    const token = this.mcpAccessToken(serverId)
    return token ? { authorization: `Bearer ${token}` } : {}
  }

  private seal(value: string): string {
    const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(this.config.sessionSecret).digest(), iv)
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ciphertext.toString('base64url')}`
  }

  private open(value: string): string {
    const [iv, tag, ciphertext] = value.split('.'); if (!iv || !tag || !ciphertext) throw new Error('Stored MCP credential is invalid')
    const decipher = createDecipheriv('aes-256-gcm', createHash('sha256').update(this.config.sessionSecret).digest(), Buffer.from(iv, 'base64url'))
    decipher.setAuthTag(Buffer.from(tag, 'base64url'))
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8')
  }

  private async forwardRuntimeMcp(endpoint: string, message: Record<string, unknown>, authorization: Record<string, string> = {}): Promise<unknown> {
    const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...authorization }, body: JSON.stringify(message), signal: AbortSignal.timeout(30_000) })
    if (!response.ok) throw new Error(`MCP server returned ${response.status}`)
    const body = await response.text()
    return body ? JSON.parse(body) : undefined
  }
}

function attachmentUri(sessionId: string, attachment: Attachment): string {
  return `papyrus://sessions/${sessionId}/attachments/${attachment.id}/${encodeURIComponent(attachment.name)}`
}

function requireWorkspaces(workspaces: PapyrusWorkspaceManager | undefined): PapyrusWorkspaceManager {
  if (!workspaces) throw new Error('Mastra session workspaces are unavailable for this runtime')
  return workspaces
}

function attachmentContentBlock(sessionId: string, attachment: Attachment & { content: Buffer }): ContentBlock {
  const uri = attachmentUri(sessionId, attachment)
  if (attachment.mediaType.startsWith('image/')) {
    return { type: 'image', data: attachment.content.toString('base64'), mimeType: attachment.mediaType }
  }
  if (isTextAttachment(attachment.mediaType, attachment.name)) {
    return { type: 'resource', resource: { uri, mimeType: attachment.mediaType, text: attachment.content.toString('utf8') }, annotations: { audience: ['assistant'], priority: 1 } }
  }
  return { type: 'resource', resource: { uri, mimeType: attachment.mediaType, blob: attachment.content.toString('base64') }, annotations: { audience: ['assistant'], priority: 1 } }
}

function isTextAttachment(mediaType: string, name: string): boolean {
  return mediaType.startsWith('text/')
    || ['application/json', 'application/xml', 'application/yaml', 'application/x-yaml', 'application/javascript'].includes(mediaType)
    || /\.(?:md|txt|csv|tsv|json|jsonl|xml|ya?ml|js|jsx|ts|tsx|py|rs|go|java|c|cc|cpp|h|hpp|css|html|sql|sh|toml|ini|cfg|log|cob|cpy)$/i.test(name)
}

function sessionSurfaceConfig(currentValue: SessionSurface): SessionConfigOption[] {
  return [{
    id: 'papyrus.surface',
    name: 'Work surface',
    description: 'Changes how Papyrus presents the durable session without changing authorization.',
    category: '_papyrus_surface',
    type: 'select',
    currentValue,
    options: [
      { value: 'general', name: 'General use', description: 'Conversation, activity, approvals, and artifacts.' },
      { value: 'ide', name: 'IDE', description: 'Repository files, diffs, terminals, tests, and conversation.' },
      { value: 'research', name: 'Research', description: 'Sources, citations, retrieval activity, and conversation.' },
      { value: 'document', name: 'Document', description: 'Document preview, findings, citations, and metadata.' },
      { value: 'data', name: 'Data', description: 'Inputs, schemas, mappings, transformations, validation, and exports.' },
    ],
  }]
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

function inferGovernmentIdentityKind(value: string): InvitationIdentityKind {
  const normalized = value.trim()
  if (/^\d{10}$/.test(normalized)) return 'edipi'
  if (/^\d{40}$/.test(normalized)) return 'fasc_n'
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)) return 'piv_uuid'
  if (isEmail(normalized)) return 'upn'
  if (/^[0-9a-f]{24}:.+$/i.test(normalized)) return 'issuer_subject'
  throw new Error('CAC/PIV identifier must be a 10-digit EDIPI, UPN, PIV UUID, 40-digit FASC-N, or <issuer-hash>:<normalized-subject>')
}

function normalizePendingIdentity(kind: InvitationIdentityKind, value: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 1024) throw new Error('Stable identity value is required and must not exceed 1024 characters')
  if (kind === 'email' || kind === 'upn') {
    if (!isEmail(normalized)) throw new Error(`${kind === 'email' ? 'Email' : 'UPN'} must use name@domain format`)
    return normalized.toLowerCase()
  }
  if (kind === 'edipi') {
    if (!/^\d{10}$/.test(normalized)) throw new Error('EDIPI/DoD ID must contain exactly 10 digits')
    return normalized
  }
  if (kind === 'piv_uuid') {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)) throw new Error('PIV UUID must be a valid UUID')
    return normalized.toLowerCase()
  }
  if (kind === 'issuer_subject') {
    if (!/^[0-9a-f]{24}:.+$/i.test(normalized)) throw new Error('Issuer + subject mapping must use <issuer-hash>:<normalized-subject>')
    return normalized.toLowerCase().replace(/\s+/g, ' ')
  }
  return normalized.toLowerCase().replace(/\s+/g, ' ')
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

function allowedAttachmentType(mediaType: string): boolean {
  return mediaType.startsWith('text/') || mediaType.startsWith('image/') || [
    'application/pdf', 'application/json', 'application/xml', 'application/zip',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ].includes(mediaType)
}

function isAbsoluteClientPath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)
}
