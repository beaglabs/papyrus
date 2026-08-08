import { randomUUID } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
/**
 * Papyrus daemon — HTTP server (serves SPA + REST API) + WebSocket (canvas sync + presence).
 *
 * One daemon per user, managing multiple projects. The WebSocket endpoint
 * `/ws?project=<id>` handles real-time canvas sync and presence for a project.
 * The REST API handles project CRUD. The built SPA is served from the web
 * package's dist/ directory.
 */
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { extname, join } from 'node:path'
import { TLSSocket } from 'node:tls'
import {
  type AgentMessage,
  createPersonaAgent,
  listSkills,
  resolveModelProvider,
  runSkill,
} from '@papyrus/agents'
import {
  CACPIVAdapter,
  type LicenseFile,
  OIDCAdapter,
  SAMLAdapter,
  WebAuthnAdapter,
  createAdapter,
} from '@papyrus/core'
import { loadOrGenerateMemberIdentity } from '@papyrus/core/auth/keygen'
import {
  type AuthContext,
  createSessionToken,
  extractAuth,
  requireAuth,
  validateSessionToken,
} from '@papyrus/core/auth/middleware'
import type { CanvasNodeDoc, EdgeDoc } from '@papyrus/core/nodes/types'
import type { ClientMsg, ServerMsg } from '@papyrus/core/sync/protocol'
import type { PresenceInfo } from '@papyrus/core/sync/protocol'
import { WebSocket, WebSocketServer } from 'ws'
import * as Y from 'yjs'
import { type AuditAction, auditLog, getAuditLog, verifyAuditChain } from './audit.js'
import {
  closeDb,
  commitCanvasOperation,
  createInvite,
  createProject,
  deleteInvite,
  deleteProject,
  deleteWebAuthnCredential,
  getInvite,
  getStoredOperations,
  getWebAuthnCredential,
  getWebAuthnCredentialsForMember,
  listProjects,
  loadDocumentState,
  loadProject,
  saveCanvas,
  saveDocumentState,
  saveWebAuthnCredential,
  updateWebAuthnCredentialCounter,
} from './database.js'
import {
  type DeploymentTransferBundle,
  createDeploymentBundle,
  verifyDeploymentBundle,
} from './deployment-transfer.js'
import { LicenseService } from './license-service.js'
import {
  type OrgMembership,
  createOrg,
  currentProfile,
  findOrgByDomain,
  generateAvatarUrl,
  getMembership,
  getOrg,
  getOrgForMember,
  joinOrg,
  listOrgs,
  updateProfile,
  validateEmailForProfile,
} from './orgs.js'
import {
  assignRole,
  getMemberProjects,
  getProjectRoles,
  getRole,
  hasPermission,
  removeRole,
  requirePermission,
} from './rbac.js'

const PORT = Number(process.env.PAPYRUS_PORT ?? 3777)
const HOST = process.env.PAPYRUS_HOST ?? '127.0.0.1'
const WEB_DIST = join(import.meta.dirname ?? '.', '../../web/dist')
const licenseService = new LicenseService(currentProfile())

// ── Generation Tasks (in-memory) ─────────────────────────────

interface GenerationTask {
  id: string
  projectId: string
  persona: string
  prompt: string
  status: 'running' | 'done' | 'error'
  startedAt: string
  completedAt?: string
  nodeId?: string
  nodeTitle?: string
  error?: string
}

const tasks = new Map<string, GenerationTask>()

// ── Rate Limiting ────────────────────────────────────────────

interface RateLimitEntry {
  count: number
  resetAt: number
}

const rateLimits = new Map<string, RateLimitEntry>()
const RATE_LIMIT_WINDOW_MS = 60_000 // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 30 // per window

function checkRateLimit(key: string): boolean {
  const now = Date.now()
  const entry = rateLimits.get(key)

  if (!entry || now > entry.resetAt) {
    rateLimits.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
    return true
  }

  if (entry.count >= RATE_LIMIT_MAX_REQUESTS) {
    return false
  }

  entry.count++
  return true
}

function getRateLimitKey(req: IncomingMessage, prefix: string): string {
  const ip = req.socket.remoteAddress ?? 'unknown'
  return `${prefix}:${ip}`
}

function isLoopback(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function localAuthEnabled(req: IncomingMessage): boolean {
  if (process.env.PAPYRUS_ALLOW_LOCAL_AUTH === 'true') return true
  return process.env.NODE_ENV !== 'production' && isLoopback(req)
}

// ── CSRF Protection ──────────────────────────────────────────

const csrfTokens = new Map<string, { token: string; expiresAt: number }>()
const CSRF_TOKEN_EXPIRY_MS = 10 * 60 * 1000 // 10 minutes

// ── WebAuthn Challenge Storage ────────────────────────────────

interface WebAuthnChallenge {
  challenge: string
  expiresAt: number
}

const webauthnChallenges = new Map<string, WebAuthnChallenge>()

// Shared WebAuthn adapter instance (configurable via env vars)
const webauthnAdapter = new WebAuthnAdapter({
  rpName: process.env.WEBAUTHN_RP_NAME ?? 'Papyrus',
  rpId: process.env.WEBAUTHN_RP_ID ?? 'localhost',
  origin: process.env.WEBAUTHN_ORIGIN ?? 'http://localhost:3777',
})

// ── OIDC State Storage ────────────────────────────────────────

interface OIDCState {
  codeVerifier: string
  redirectUri: string
  expiresAt: number
}

const oidcStates = new Map<string, OIDCState>()

function generateCsrfToken(): string {
  const token = `csrf-${Date.now()}-${Math.random().toString(36).slice(2, 16)}`
  csrfTokens.set(token, { token, expiresAt: Date.now() + CSRF_TOKEN_EXPIRY_MS })
  return token
}

function validateCsrfToken(token: string): boolean {
  const entry = csrfTokens.get(token)
  if (!entry) return false
  if (Date.now() > entry.expiresAt) {
    csrfTokens.delete(token)
    return false
  }
  // Single use
  csrfTokens.delete(token)
  return true
}

// Clean up expired CSRF tokens periodically
setInterval(() => {
  const now = Date.now()
  for (const [token, entry] of csrfTokens) {
    if (now > entry.expiresAt) csrfTokens.delete(token)
  }
}, 60_000)

// ── In-memory state per project ──────────────────────────────────

interface ProjectState {
  nodes: CanvasNodeDoc[]
  edges: EdgeDoc[]
  revision: number
  documents: Map<string, Y.Doc>
  presence: Map<string, PresenceInfo>
  clients: Set<WebSocket>
  wsPeerMap: Map<WebSocket, string>
}

const projects = new Map<string, ProjectState>()

function getOrCreateState(id: string): ProjectState {
  const existing = projects.get(id)
  if (existing) return existing
  const data = loadProject(id)
  const state: ProjectState = {
    nodes: data?.nodes ?? [],
    edges: data?.edges ?? [],
    revision: data?.revision ?? 0,
    documents: new Map(),
    presence: new Map(),
    clients: new Set(),
    wsPeerMap: new Map(),
  }
  projects.set(id, state)
  return state
}

function broadcast(state: ProjectState, msg: ServerMsg, exclude?: WebSocket): void {
  const payload = JSON.stringify(msg)
  for (const client of state.clients) {
    if (client !== exclude && client.readyState === WebSocket.OPEN) {
      client.send(payload)
    }
  }
}

function persistIfState(id: string): void {
  const state = projects.get(id)
  if (state) saveCanvas(id, state.nodes, state.edges)
}

function commitStateMutation(
  projectId: string,
  state: ProjectState,
  mutation: {
    actorKey: string
    entityType: 'node' | 'edge' | 'document' | 'project'
    entityId: string
    operationType: 'create' | 'update' | 'delete'
    payload?: unknown
  },
): void {
  const result = commitCanvasOperation(
    {
      id: `op-${randomUUID()}`,
      projectId,
      ...mutation,
      baseRevision: state.revision,
    },
    state.nodes,
    state.edges,
  )
  state.revision = result.projectRevision
}

// ── REST API ─────────────────────────────────────────────────────

function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()))
      } catch {
        resolve({})
      }
    })
  })
}

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
  res.end(JSON.stringify(data))
}

async function handleAPI(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)
  const method = req.method ?? 'GET'

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    })
    res.end()
    return true
  }

  if (url.pathname === '/api/health') {
    const license = licenseService.getStatus()
    json(res, 200, {
      ok: true,
      licensed: license.valid,
      projects: license.valid ? listProjects().length : 0,
    })
    return true
  }

  // License diagnostics and activation remain available while the daemon is locked.
  if (url.pathname === '/api/license/status' && method === 'GET') {
    json(res, 200, licenseService.getStatus())
    return true
  }

  if (url.pathname === '/api/license/request' && method === 'GET') {
    json(res, 200, licenseService.activationRequest())
    return true
  }

  if (url.pathname === '/api/license/activate' && method === 'POST') {
    const body = await parseBody(req)
    const status = licenseService.activate(body as unknown as LicenseFile)
    json(res, status.valid ? 200 : 400, status)
    return true
  }

  if (!licenseService.isLicensed()) {
    json(res, 402, { error: 'Papyrus license required', license: licenseService.getStatus() })
    return true
  }

  // ── Auth endpoints ──────────────────────────────────────────

  if (url.pathname === '/api/auth/local-identity' && method === 'GET') {
    const identity = loadOrGenerateMemberIdentity()
    json(res, 200, { memberKey: identity.publicKey })
    return true
  }

  if (url.pathname === '/api/auth/csrf-token' && method === 'GET') {
    const token = generateCsrfToken()
    json(res, 200, { csrfToken: token })
    return true
  }

  if (url.pathname === '/api/auth/config' && method === 'GET') {
    const tlsSocket = req.socket instanceof TLSSocket ? req.socket : null
    const profile = currentProfile()
    json(res, 200, {
      profile,
      methods: {
        local: localAuthEnabled(req),
        webauthn: profile !== 'siprnet-il6',
        oidc:
          profile === 'commercial' &&
          Boolean(process.env.OIDC_ISSUER && process.env.OIDC_CLIENT_ID),
        saml:
          profile === 'commercial' &&
          Boolean(process.env.SAML_ENTRY_POINT && process.env.SAML_CERT),
        cac: Boolean(process.env.PAPYRUS_CAC_CA_BUNDLE && tlsSocket),
      },
    })
    return true
  }

  if (url.pathname === '/api/auth/login' && method === 'POST') {
    if (!localAuthEnabled(req)) {
      json(res, 403, { error: 'Local development authentication is disabled' })
      return true
    }
    // Rate limit auth endpoints
    const rateKey = getRateLimitKey(req, 'auth')
    if (!checkRateLimit(rateKey)) {
      json(res, 429, { error: 'Too many requests. Please try again later.' })
      return true
    }

    const body = await parseBody(req)
    const memberKey = body.memberKey as string
    const displayName = (body.displayName as string) ?? 'Anonymous'
    const csrfToken = body.csrfToken as string | undefined

    // Validate CSRF token for login
    if (csrfToken && !validateCsrfToken(csrfToken)) {
      json(res, 403, { error: 'Invalid or expired CSRF token' })
      return true
    }

    if (!memberKey) {
      json(res, 400, { error: 'memberKey required' })
      return true
    }
    const localIdentity = loadOrGenerateMemberIdentity()
    if (memberKey !== localIdentity.publicKey) {
      json(res, 403, { error: 'Local login must use this deployment host identity' })
      return true
    }

    const token = createSessionToken(memberKey, displayName)
    auditLog({
      actor: memberKey,
      action: 'create',
      entityType: 'session',
      entityId: 'login',
      projectId: 'system',
      details: { displayName },
    })
    json(res, 200, { token, memberKey, displayName })
    return true
  }

  if (url.pathname === '/api/auth/refresh' && method === 'POST') {
    // Rate limit auth endpoints
    const rateKey = getRateLimitKey(req, 'auth')
    if (!checkRateLimit(rateKey)) {
      json(res, 429, { error: 'Too many requests. Please try again later.' })
      return true
    }

    const authCtx = requireAuth(req, res)
    if (!authCtx) return true

    const authHeader = req.headers.authorization
    const oldToken = authHeader?.slice(7) ?? ''
    const { refreshSessionToken } = await import('@papyrus/core/auth/middleware')
    const newToken = refreshSessionToken(oldToken)
    if (!newToken) {
      json(res, 401, { error: 'Token refresh failed' })
      return true
    }
    json(res, 200, { token: newToken })
    return true
  }

  if (url.pathname === '/api/auth/logout' && method === 'POST') {
    const { revokeSessionToken } = await import('@papyrus/core/auth/middleware')
    const token = req.headers.authorization?.startsWith('Bearer ')
      ? req.headers.authorization.slice(7)
      : undefined
    revokeSessionToken(token)
    json(res, 200, { ok: true })
    return true
  }

  if (url.pathname === '/api/auth/me' && method === 'GET') {
    const ctx = extractAuth(req)
    if (!ctx) {
      json(res, 401, { error: 'Not authenticated' })
      return true
    }
    // Get role from RBAC if projectId is provided
    const projectId = url.searchParams.get('projectId')
    let role = null
    if (projectId) {
      role = getRole(projectId, ctx.memberKey)
    }
    json(res, 200, { memberKey: ctx.memberKey, displayName: ctx.displayName, role })
    return true
  }

  // ── WebAuthn Endpoints ──────────────────────────────────────────

  if (url.pathname === '/api/auth/webauthn/register/start' && method === 'POST') {
    const authCtx = requireAuth(req, res)
    if (!authCtx) return true
    const body = await parseBody(req)
    const memberKey = authCtx.memberKey
    const displayName = (body.displayName as string) ?? 'User'
    if (!memberKey) {
      json(res, 400, { error: 'memberKey required' })
      return true
    }
    const adapter = webauthnAdapter
    const challenge = await adapter.registerStart(memberKey, displayName)
    const challengeStr = challenge.challenge.challenge as string
    // Store challenge in memory for verification (in production, use secure session)
    const challengeKey = `webauthn_reg:${memberKey}`
    webauthnChallenges.set(challengeKey, {
      challenge: challengeStr,
      expiresAt: Date.now() + 5 * 60 * 1000, // 5 minutes
    })
    json(res, 200, { options: challenge.challenge.options, challenge: challengeStr })
    return true
  }

  if (url.pathname === '/api/auth/webauthn/register/finish' && method === 'POST') {
    const authCtx = requireAuth(req, res)
    if (!authCtx) return true
    const body = await parseBody(req)
    const memberKey = authCtx.memberKey
    const credential = body.credential as Record<string, unknown>
    if (!memberKey || !credential) {
      json(res, 400, { error: 'memberKey and credential required' })
      return true
    }
    const challengeKey = `webauthn_reg:${memberKey}`
    const stored = webauthnChallenges.get(challengeKey)
    if (!stored || stored.expiresAt < Date.now()) {
      json(res, 400, { error: 'Challenge expired or invalid' })
      return true
    }
    const adapter = webauthnAdapter
    const origin =
      process.env.WEBAUTHN_ORIGIN ??
      new URL((body.origin as string) ?? 'http://localhost:3777').origin
    const rpId = process.env.WEBAUTHN_RP_ID ?? new URL(origin).hostname
    try {
      const result = await adapter.registerComplete(
        { method: 'webauthn', data: credential },
        stored.challenge,
        origin,
        rpId,
      )
      // Save credential to database
      saveWebAuthnCredential(
        memberKey,
        result.credentialId,
        result.publicKey,
        result.counter,
        result.aaguid,
      )
      webauthnChallenges.delete(challengeKey)
      json(res, 200, { ok: true, credentialId: result.credentialId })
    } catch (e) {
      json(res, 400, { error: (e as Error).message })
    }
    return true
  }

  if (url.pathname === '/api/auth/webauthn/authenticate/start' && method === 'POST') {
    const body = await parseBody(req)
    const memberKey = body.memberKey as string
    if (!memberKey) {
      json(res, 400, { error: 'memberKey required' })
      return true
    }
    // Get existing credentials for this member
    const credentials = getWebAuthnCredentialsForMember(memberKey)
    if (credentials.length === 0) {
      json(res, 404, { error: 'No WebAuthn credentials registered for this member' })
      return true
    }
    const adapter = webauthnAdapter
    const challenge = await adapter.authenticateStart(credentials.map((c) => c.credentialId))
    const challengeStr = challenge.challenge.challenge as string
    // Store challenge for verification
    const challengeKey = `webauthn_auth:${memberKey}`
    webauthnChallenges.set(challengeKey, {
      challenge: challengeStr,
      expiresAt: Date.now() + 5 * 60 * 1000,
    })
    json(res, 200, { options: challenge.challenge.options, challenge: challengeStr })
    return true
  }

  if (url.pathname === '/api/auth/webauthn/authenticate/finish' && method === 'POST') {
    const body = await parseBody(req)
    const memberKey = body.memberKey as string
    const credential = body.credential as Record<string, unknown>
    if (!memberKey || !credential) {
      json(res, 400, { error: 'memberKey and credential required' })
      return true
    }
    const challengeKey = `webauthn_auth:${memberKey}`
    const stored = webauthnChallenges.get(challengeKey)
    if (!stored || stored.expiresAt < Date.now()) {
      json(res, 400, { error: 'Challenge expired or invalid' })
      return true
    }
    // Get the credential from the database
    const credentialId = credential.id as string
    const cred = getWebAuthnCredential(credentialId)
    if (!cred || cred.memberKey !== memberKey) {
      json(res, 400, { error: 'Credential not found or mismatch' })
      return true
    }
    const adapter = webauthnAdapter
    const origin =
      process.env.WEBAUTHN_ORIGIN ??
      new URL((body.origin as string) ?? 'http://localhost:3777').origin
    const rpId = process.env.WEBAUTHN_RP_ID ?? new URL(origin).hostname
    try {
      const result = await adapter.authenticateComplete(
        { method: 'webauthn', data: credential },
        stored.challenge,
        origin,
        rpId,
        cred.publicKey,
        cred.counter,
        cred.credentialId,
      )
      if (!result.verified) {
        json(res, 401, { error: 'WebAuthn verification failed' })
        return true
      }
      // Update counter
      updateWebAuthnCredentialCounter(credentialId, result.counter)
      webauthnChallenges.delete(challengeKey)
      // Create session token
      const token = createSessionToken(memberKey, cred.memberKey) // Use memberKey as displayName for now
      json(res, 200, { token, memberKey, displayName: cred.memberKey })
    } catch (e) {
      json(res, 400, { error: (e as Error).message })
    }
    return true
  }

  if (url.pathname === '/api/auth/webauthn/credentials' && method === 'GET') {
    const authCtx = requireAuth(req, res)
    if (!authCtx) return true
    const credentials = getWebAuthnCredentialsForMember(authCtx.memberKey)
    json(
      res,
      200,
      credentials.map((c) => ({
        credentialId: c.credentialId,
        aaguid: c.aaguid,
        counter: c.counter,
        createdAt: c.createdAt,
      })),
    )
    return true
  }

  if (url.pathname === '/api/auth/webauthn/credentials' && method === 'DELETE') {
    const authCtx = requireAuth(req, res)
    if (!authCtx) return true
    const body = await parseBody(req)
    const credentialId = body.credentialId as string
    if (!credentialId) {
      json(res, 400, { error: 'credentialId required' })
      return true
    }
    const cred = getWebAuthnCredential(credentialId)
    if (!cred || cred.memberKey !== authCtx.memberKey) {
      json(res, 404, { error: 'Credential not found' })
      return true
    }
    deleteWebAuthnCredential(credentialId)
    json(res, 200, { ok: true })
    return true
  }

  // ── OIDC Endpoints ──────────────────────────────────────────────

  if (url.pathname === '/api/auth/oidc/authorize' && method === 'GET') {
    // Build the authorization URL and redirect
    const issuer = process.env.OIDC_ISSUER ?? 'https://login.example.com'
    const clientId = process.env.OIDC_CLIENT_ID ?? 'papyrus'
    const redirectUri =
      process.env.OIDC_REDIRECT_URI ?? 'http://localhost:3777/api/auth/oidc/callback'
    const scopes = (process.env.OIDC_SCOPES ?? 'openid,profile,email').split(',')

    const oidcAdapter = new OIDCAdapter({
      issuer,
      clientId,
      redirectUri,
      scopes,
      clientSecret: process.env.OIDC_CLIENT_SECRET,
    })

    const challenge = await oidcAdapter.start()
    const state = challenge.challenge.state as string
    const codeVerifier = challenge.challenge.codeVerifier as string

    // Store PKCE state for verification
    oidcStates.set(state, {
      codeVerifier,
      redirectUri,
      expiresAt: Date.now() + 10 * 60 * 1000, // 10 minutes
    })

    // Redirect to authorization URL
    const authUrl = challenge.challenge.authorizationUrl as string
    res.writeHead(302, { Location: authUrl })
    res.end()
    return true
  }

  if (url.pathname === '/api/auth/oidc/callback' && method === 'GET') {
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    const error = url.searchParams.get('error')

    if (error) {
      json(res, 400, { error, errorDescription: url.searchParams.get('error_description') })
      return true
    }

    if (!code || !state) {
      json(res, 400, { error: 'Missing code or state parameter' })
      return true
    }

    const stored = oidcStates.get(state)
    if (!stored || stored.expiresAt < Date.now()) {
      json(res, 400, { error: 'Invalid or expired OIDC state' })
      return true
    }
    oidcStates.delete(state)

    const issuer = process.env.OIDC_ISSUER ?? 'https://login.example.com'
    const clientId = process.env.OIDC_CLIENT_ID ?? 'papyrus'

    const oidcAdapter = new OIDCAdapter({
      issuer,
      clientId,
      redirectUri: stored.redirectUri,
      clientSecret: process.env.OIDC_CLIENT_SECRET,
    })

    try {
      const result = await oidcAdapter.complete({
        method: 'oidc',
        data: {
          code,
          codeVerifier: stored.codeVerifier,
          redirectUri: stored.redirectUri,
        },
      })

      // Get or create member key for this OIDC user
      const identity = loadOrGenerateMemberIdentity()
      const token = createSessionToken(identity.publicKey, result.displayName)

      auditLog({
        actor: identity.publicKey,
        action: 'create',
        entityType: 'session',
        entityId: 'oidc-login',
        projectId: 'system',
        details: { method: 'oidc', externalId: result.externalId, displayName: result.displayName },
      })

      // Redirect to frontend with token
      const frontendUrl = process.env.PAPYRUS_WEB_URL ?? 'http://localhost:3777'
      const redirectUrl = `${frontendUrl}/?token=${encodeURIComponent(token)}&displayName=${encodeURIComponent(result.displayName)}`
      res.writeHead(302, { Location: redirectUrl })
      res.end()
    } catch (e) {
      json(res, 401, { error: `OIDC authentication failed: ${(e as Error).message}` })
    }
    return true
  }

  // ── CAC/PIV Endpoints ───────────────────────────────────────────

  if (url.pathname === '/api/auth/cac/status' && method === 'GET') {
    const tlsSocket = req.socket instanceof TLSSocket ? req.socket : null
    const peerCert = tlsSocket?.getPeerCertificate()
    const hasCert = Boolean(peerCert && Object.keys(peerCert).length > 0)
    json(res, 200, {
      mtlsEnabled: Boolean(tlsSocket),
      hasClientCert: hasCert,
      authorized: tlsSocket?.authorized ?? false,
      authorizationError: tlsSocket?.authorizationError ?? null,
      subject: hasCert ? peerCert?.subject : null,
      issuer: hasCert ? peerCert?.issuer : null,
    })
    return true
  }

  if (url.pathname === '/api/auth/cac/challenge' && method === 'GET') {
    const caBundlePath = process.env.PAPYRUS_CAC_CA_BUNDLE
    let caBundle: string | undefined
    if (caBundlePath) {
      try {
        caBundle = readFileSync(caBundlePath, 'utf-8')
      } catch {
        // CA bundle not readable
      }
    }
    const adapter = new CACPIVAdapter(caBundle ? { caBundle } : undefined)
    const challenge = await adapter.start()
    json(res, 200, challenge.challenge)
    return true
  }

  if (url.pathname === '/api/auth/cac/verify' && method === 'POST') {
    const tlsSocket = req.socket instanceof TLSSocket ? req.socket : null
    const peerCert = tlsSocket?.getPeerCertificate()
    if (!tlsSocket || !peerCert?.raw) {
      json(res, 400, { error: 'No CAC/PIV client certificate was presented over HTTPS.' })
      return true
    }

    const caBundlePath = process.env.PAPYRUS_CAC_CA_BUNDLE
    let caBundle: string | undefined
    if (!caBundlePath || !tlsSocket.authorized) {
      json(res, 401, {
        error: `CAC/PIV certificate is not trusted${tlsSocket.authorizationError ? `: ${tlsSocket.authorizationError}` : ''}`,
      })
      return true
    }
    try {
      caBundle = readFileSync(caBundlePath, 'utf-8')
    } catch {
      json(res, 500, { error: 'CAC/PIV CA bundle is not readable.' })
      return true
    }

    const certPem = `-----BEGIN CERTIFICATE-----\n${
      peerCert.raw
        .toString('base64')
        .match(/.{1,64}/g)
        ?.join('\n') ?? ''
    }\n-----END CERTIFICATE-----`
    const adapter = new CACPIVAdapter({ caBundle })
    try {
      const result = await adapter.complete({
        method: 'cac-piv',
        data: { certPem },
      })

      // Get or create member key for this CAC/PIV user
      const identity = loadOrGenerateMemberIdentity()
      const token = createSessionToken(identity.publicKey, result.displayName)

      auditLog({
        actor: identity.publicKey,
        action: 'create',
        entityType: 'session',
        entityId: 'cac-login',
        projectId: 'system',
        details: {
          method: 'cac-piv',
          externalId: result.externalId,
          displayName: result.displayName,
        },
      })

      json(res, 200, { token, memberKey: identity.publicKey, displayName: result.displayName })
    } catch (e) {
      json(res, 401, { error: `CAC/PIV verification failed: ${(e as Error).message}` })
    }
    return true
  }

  // ── SAML Endpoints ──────────────────────────────────────────────

  if (url.pathname === '/api/auth/saml/authorize' && method === 'GET') {
    const entryPoint = process.env.SAML_ENTRY_POINT ?? 'https://idp.example.com/sso'
    const issuer = process.env.SAML_ISSUER ?? 'papyrus'
    const cert = process.env.SAML_CERT ?? ''

    const samlAdapterInstance = new SAMLAdapter({ entryPoint, issuer, cert })
    const challenge = await samlAdapterInstance.start()
    const ssoUrl = challenge.challenge.ssoUrl as string

    // Redirect to SSO URL
    res.writeHead(302, { Location: ssoUrl })
    res.end()
    return true
  }

  if (url.pathname === '/api/auth/saml/acs' && method === 'POST') {
    // Assertion Consumer Service — receives SAML response from IdP
    const contentType = req.headers['content-type'] ?? ''
    let samlResponse = ''
    let relayState = ''

    if (contentType.includes('application/json')) {
      const body = await parseBody(req)
      samlResponse = body.SAMLResponse as string
      relayState = body.RelayState as string
    } else {
      // Parse form-encoded POST (standard SAML POST binding)
      const chunks: Buffer[] = []
      for await (const chunk of req) {
        chunks.push(chunk as Buffer)
      }
      const formBody = Buffer.concat(chunks).toString()
      const params = new URLSearchParams(formBody)
      samlResponse = params.get('SAMLResponse') ?? ''
      relayState = params.get('RelayState') ?? ''
    }

    if (!samlResponse) {
      json(res, 400, { error: 'SAMLResponse required' })
      return true
    }

    const entryPoint = process.env.SAML_ENTRY_POINT ?? 'https://idp.example.com/sso'
    const issuer = process.env.SAML_ISSUER ?? 'papyrus'
    const cert = process.env.SAML_CERT ?? ''

    const samlAdapterInstance = new SAMLAdapter({ entryPoint, issuer, cert })

    try {
      const result = await samlAdapterInstance.complete({
        method: 'saml',
        data: { SAMLResponse: samlResponse, RelayState: relayState },
      })

      // Get or create member key for this SAML user
      const identity = loadOrGenerateMemberIdentity()
      const token = createSessionToken(identity.publicKey, result.displayName)

      auditLog({
        actor: identity.publicKey,
        action: 'create',
        entityType: 'session',
        entityId: 'saml-login',
        projectId: 'system',
        details: { method: 'saml', externalId: result.externalId, displayName: result.displayName },
      })

      // Redirect to frontend with token
      const frontendUrl = process.env.PAPYRUS_WEB_URL ?? 'http://localhost:3777'
      const redirectUrl = `${frontendUrl}/?token=${encodeURIComponent(token)}&displayName=${encodeURIComponent(result.displayName)}`
      res.writeHead(302, { Location: redirectUrl })
      res.end()
    } catch (e) {
      json(res, 401, { error: `SAML authentication failed: ${(e as Error).message}` })
    }
    return true
  }

  if (url.pathname === '/api/projects' && method === 'GET') {
    const authCtx = requireAuth(req, res)
    if (!authCtx) return true
    const allowed = new Set(getMemberProjects(authCtx.memberKey).map((item) => item.projectId))
    json(
      res,
      200,
      listProjects().filter((project) => allowed.has(project.id)),
    )
    return true
  }

  if (url.pathname === '/api/projects' && method === 'POST') {
    const authCtx = requireAuth(req, res)
    if (!authCtx) return true

    const body = await parseBody(req)
    const name = (body.name as string) ?? 'Untitled Project'
    const membership = getOrgForMember(authCtx.memberKey)
    const project = createProject(name, membership?.org.id, authCtx.memberKey)

    // Assign owner role to creator
    assignRole(project.id, authCtx.memberKey, 'owner', authCtx.memberKey)

    // Auto-create a Specification source node
    const specNode: CanvasNodeDoc = {
      id: `node-spec-${Date.now()}`,
      projectId: project.id,
      type: 'specification',
      category: 'output',
      flowRole: 'source',
      position: { x: 100, y: 200 },
      fields: {
        title: name,
        content: `# ${name}\n\nDescribe your project vision here. What are we building? Who is it for? What problem does it solve?`,
        format: 'freeform',
      },
      status: 'draft',
      createdBy: authCtx.memberKey,
      updatedAt: Date.now(),
    }

    const state = getOrCreateState(project.id)
    state.nodes = [specNode]
    const initialOperation = commitCanvasOperation(
      {
        id: `op-${randomUUID()}`,
        projectId: project.id,
        actorKey: authCtx.memberKey,
        entityType: 'node',
        entityId: specNode.id,
        operationType: 'create',
        payload: specNode,
        baseRevision: 0,
      },
      [specNode],
      [],
    )
    state.revision = initialOperation.projectRevision

    json(res, 201, { ...project, nodes: [specNode] })
    return true
  }

  const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/)
  if (projectMatch && method === 'GET') {
    const authCtx = requireAuth(req, res)
    if (!authCtx) return true
    const id = projectMatch[1]
    if (!id) {
      json(res, 400, { error: 'missing project id' })
      return true
    }
    if (!hasPermission(id, authCtx.memberKey, 'project:read')) {
      json(res, 403, { error: 'Project access denied' })
      return true
    }
    const data = loadProject(id)
    if (!data) {
      json(res, 404, { error: 'not found' })
      return true
    }
    json(res, 200, data)
    return true
  }

  if (projectMatch && method === 'DELETE') {
    const authCtx = requireAuth(req, res)
    if (!authCtx) return true
    const id = projectMatch[1]
    if (!id) {
      json(res, 400, { error: 'missing project id' })
      return true
    }
    if (!hasPermission(id, authCtx.memberKey, 'project:delete')) {
      json(res, 403, { error: 'Project deletion denied' })
      return true
    }
    const deleted = deleteProject(id)
    if (!deleted) {
      json(res, 404, { error: 'not found' })
      return true
    }
    // Remove from in-memory state
    projects.delete(id)
    json(res, 200, { ok: true })
    return true
  }

  // ── Export endpoints ──────────────────────────────────────────

  if (url.pathname === '/api/export' && method === 'POST') {
    const authCtx = requireAuth(req, res)
    if (!authCtx) return true

    const body = await parseBody(req)
    const projectId = body.projectId as string
    const format = (body.format as string) ?? 'json'

    if (!projectId) {
      json(res, 400, { error: 'projectId required' })
      return true
    }
    if (!hasPermission(projectId, authCtx.memberKey, 'project:export')) {
      json(res, 403, { error: 'Project export denied' })
      return true
    }

    const state = projects.get(projectId)
    if (!state) {
      json(res, 404, { error: 'project not found' })
      return true
    }

    if (format === 'markdown') {
      // Export as markdown document
      const lines: string[] = ['# Project Export\n']
      lines.push(`Exported: ${new Date().toISOString()}\n`)

      for (const node of state.nodes) {
        const title = (node.fields.title as string) ?? node.type
        const content = (node.fields.content as string) ?? ''
        lines.push(`## ${title}\n`)
        lines.push(`**Type:** ${node.type}  `)
        lines.push(`**Category:** ${node.category}  `)
        lines.push(`**Status:** ${node.status}\n`)
        if (content) lines.push(`${content}\n`)
        lines.push('---\n')
      }

      const md = lines.join('\n')
      res.writeHead(200, {
        'Content-Type': 'text/markdown',
        'Content-Disposition': `attachment; filename="${projectId}-export.md"`,
      })
      res.end(md)
      return true
    }

    // Default: JSON export
    json(res, 200, {
      projectId,
      exportedAt: new Date().toISOString(),
      nodes: state.nodes,
      edges: state.edges,
    })
    return true
  }

  // ── Cross-domain transfer endpoints ───────────────────────────

  if (url.pathname === '/api/transfer/export' && method === 'POST') {
    const authCtx = requireAuth(req, res)
    if (!authCtx) return true

    const body = await parseBody(req)
    const projectId = body.projectId as string
    const sourceDomain = (body.domain as string) ?? 'unknown'
    const sinceRevision = (body.sinceRevision as number) ?? 0

    if (!projectId) {
      json(res, 400, { error: 'projectId required' })
      return true
    }
    if (!hasPermission(projectId, authCtx.memberKey, 'project:export')) {
      json(res, 403, { error: 'Project transfer export denied' })
      return true
    }

    const bundle = createDeploymentBundle(
      projectId,
      sourceDomain,
      getStoredOperations(projectId, sinceRevision),
    )
    json(res, 200, bundle)
    return true
  }

  if (url.pathname === '/api/transfer/import' && method === 'POST') {
    const authCtx = requireAuth(req, res)
    if (!authCtx) return true

    const body = await parseBody(req)
    const projectId = body.projectId as string
    const bundle = body.bundle as DeploymentTransferBundle | undefined

    if (!projectId || !bundle) {
      json(res, 400, { error: 'projectId and bundle required' })
      return true
    }
    if (!hasPermission(projectId, authCtx.memberKey, 'node:update')) {
      json(res, 403, { error: 'Project transfer import denied' })
      return true
    }

    if (bundle.projectId !== projectId) {
      json(res, 400, { error: 'Bundle project does not match import target' })
      return true
    }
    const trustedDeployments = new Set(
      (process.env.PAPYRUS_TRUSTED_DEPLOYMENT_IDS ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean),
    )
    const verification = verifyDeploymentBundle(bundle, trustedDeployments)
    if (!verification.valid) {
      json(res, 400, { error: verification.reason ?? 'Bundle verification failed' })
      return true
    }

    const state = getOrCreateState(projectId)
    let applied = 0
    for (const operation of bundle.operations) {
      if (operation.projectId !== projectId) continue
      if (operation.entityType === 'node') {
        if (operation.operationType === 'delete') {
          state.nodes = state.nodes.filter((node) => node.id !== operation.entityId)
          state.edges = state.edges.filter(
            (edge) => edge.from !== operation.entityId && edge.to !== operation.entityId,
          )
        } else if (operation.payload) {
          const node = { ...(operation.payload as CanvasNodeDoc), projectId }
          const index = state.nodes.findIndex((item) => item.id === node.id)
          state.nodes =
            index >= 0
              ? state.nodes.map((item, itemIndex) => (itemIndex === index ? node : item))
              : [...state.nodes, node]
        }
      } else if (operation.entityType === 'edge') {
        if (operation.operationType === 'delete') {
          state.edges = state.edges.filter((edge) => edge.id !== operation.entityId)
        } else if (operation.payload) {
          const edge = { ...(operation.payload as EdgeDoc), projectId }
          const index = state.edges.findIndex((item) => item.id === edge.id)
          state.edges =
            index >= 0
              ? state.edges.map((item, itemIndex) => (itemIndex === index ? edge : item))
              : [...state.edges, edge]
        }
      } else if (operation.entityType === 'document') {
        const update = (operation.payload as { update?: string } | null)?.update
        if (update) {
          const doc = getDocument(state, projectId, operation.entityId)
          Y.applyUpdate(doc, Buffer.from(update, 'base64'))
          const content = doc.getText('content').toString()
          state.nodes = state.nodes.map((node) =>
            node.id === operation.entityId
              ? { ...node, fields: { ...node.fields, content }, updatedAt: Date.now() }
              : node,
          )
        }
      }
      const result = commitCanvasOperation(
        {
          id: operation.id,
          projectId,
          actorKey: `deployment:${bundle.sourceDeploymentId}`,
          entityType: operation.entityType as 'node' | 'edge' | 'document' | 'project',
          entityId: operation.entityId,
          operationType: operation.operationType as 'create' | 'update' | 'delete',
          payload: operation.payload,
        },
        state.nodes,
        state.edges,
      )
      state.revision = result.projectRevision
      if (!result.duplicate) applied++
    }

    // Broadcast to WS clients
    broadcast(state, {
      type: 'canvas:state',
      data: {
        nodes: state.nodes,
        edges: state.edges,
        presence: [...state.presence.values()],
        revision: state.revision,
      },
    })

    // Audit
    auditLog({
      actor: 'system',
      action: 'import',
      entityType: 'transfer',
      entityId: `bundle-${bundle.exportedAt}`,
      projectId,
      details: {
        operationsApplied: applied,
        sourceDomain: bundle.sourceDomain,
        sourceDeploymentId: bundle.sourceDeploymentId,
      },
    })

    json(res, 200, { ok: true, operationsApplied: applied })
    return true
  }

  if (url.pathname === '/api/transfer/operations' && method === 'GET') {
    const authCtx = requireAuth(req, res)
    if (!authCtx) return true
    const projectId = url.searchParams.get('projectId')
    if (!projectId) {
      json(res, 400, { error: 'projectId required' })
      return true
    }
    if (!hasPermission(projectId, authCtx.memberKey, 'project:read')) {
      json(res, 403, { error: 'Project access denied' })
      return true
    }
    const sinceRevision = Number(url.searchParams.get('sinceRevision') ?? '0')
    const ops = getStoredOperations(projectId, sinceRevision)
    json(res, 200, ops)
    return true
  }

  // ── Audit endpoints ───────────────────────────────────────────

  if (url.pathname === '/api/audit' && method === 'GET') {
    const authCtx = requireAuth(req, res)
    if (!authCtx) return true
    const projectId = url.searchParams.get('projectId')
    if (!projectId) {
      json(res, 400, { error: 'projectId required' })
      return true
    }
    if (!hasPermission(projectId, authCtx.memberKey, 'audit:read')) {
      json(res, 403, { error: 'Audit access denied' })
      return true
    }

    const limit = Number(url.searchParams.get('limit') ?? '100')
    const offset = Number(url.searchParams.get('offset') ?? '0')
    const actor = url.searchParams.get('actor') ?? undefined
    const action = url.searchParams.get('action') as AuditAction | undefined

    const entries = getAuditLog({ projectId, limit, offset, actor, action })
    json(res, 200, entries)
    return true
  }

  if (url.pathname === '/api/audit/verify' && method === 'GET') {
    const authCtx = requireAuth(req, res)
    if (!authCtx) return true
    const projectId = url.searchParams.get('projectId')
    if (!projectId) {
      json(res, 400, { error: 'projectId required' })
      return true
    }
    if (!hasPermission(projectId, authCtx.memberKey, 'audit:read')) {
      json(res, 403, { error: 'Audit access denied' })
      return true
    }

    const result = verifyAuditChain(projectId)
    json(res, 200, result)
    return true
  }

  // ── RBAC endpoints ────────────────────────────────────────────

  if (url.pathname === '/api/rbac/roles' && method === 'GET') {
    const authCtx = requireAuth(req, res)
    if (!authCtx) return true
    const projectId = url.searchParams.get('projectId')
    if (!projectId) {
      json(res, 400, { error: 'projectId required' })
      return true
    }
    if (!hasPermission(projectId, authCtx.memberKey, 'project:read')) {
      json(res, 403, { error: 'Project access denied' })
      return true
    }
    const roles = getProjectRoles(projectId)
    json(res, 200, roles)
    return true
  }

  if (url.pathname === '/api/rbac/assign' && method === 'POST') {
    const authCtx = requireAuth(req, res)
    if (!authCtx) return true

    const body = await parseBody(req)
    const projectId = body.projectId as string
    const memberKey = body.memberKey as string
    const role = body.role as 'owner' | 'editor' | 'viewer'

    if (!projectId || !memberKey || !role) {
      json(res, 400, { error: 'projectId, memberKey, and role required' })
      return true
    }

    // Check if the requester has permission to assign roles
    try {
      requirePermission(projectId, authCtx.memberKey, 'role:assign')
    } catch (err) {
      json(res, 403, { error: (err as Error).message })
      return true
    }

    const assignment = assignRole(projectId, memberKey, role, authCtx.memberKey)
    auditLog({
      actor: authCtx.memberKey,
      action: 'update',
      entityType: 'role',
      entityId: memberKey,
      projectId,
      details: { role, assignedTo: memberKey },
    })
    json(res, 200, assignment)
    return true
  }

  if (url.pathname === '/api/rbac/remove' && method === 'POST') {
    const authCtx2 = requireAuth(req, res)
    if (!authCtx2) return true

    const body = await parseBody(req)
    const projectId = body.projectId as string
    const memberKey = body.memberKey as string

    if (!projectId || !memberKey) {
      json(res, 400, { error: 'projectId and memberKey required' })
      return true
    }

    // Check if the requester has permission to remove roles
    try {
      requirePermission(projectId, authCtx2.memberKey, 'role:remove')
    } catch (err) {
      json(res, 403, { error: (err as Error).message })
      return true
    }

    const removed = removeRole(projectId, memberKey)
    auditLog({
      actor: authCtx2.memberKey,
      action: 'delete',
      entityType: 'role',
      entityId: memberKey,
      projectId,
    })
    json(res, 200, { ok: removed })
    return true
  }

  // ── Member invite endpoints ─────────────────────────────────

  if (url.pathname === '/api/invite/generate' && method === 'POST') {
    const authCtx = requireAuth(req, res)
    if (!authCtx) return true

    const body = await parseBody(req)
    const projectId = body.projectId as string
    const role = (body.role as string) ?? 'editor'

    if (!projectId) {
      json(res, 400, { error: 'projectId required' })
      return true
    }

    // Check permission
    try {
      requirePermission(projectId, authCtx.memberKey, 'role:assign')
    } catch (err) {
      json(res, 403, { error: (err as Error).message })
      return true
    }

    // Generate invite code (random, short-lived)
    const inviteCode = `inv-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() // 24h

    // Store invite in database
    createInvite(inviteCode, projectId, role, authCtx.memberKey, expiresAt)

    auditLog({
      actor: authCtx.memberKey,
      action: 'create',
      entityType: 'invite',
      entityId: inviteCode,
      projectId,
      details: { role, expiresAt },
    })

    json(res, 200, {
      inviteCode,
      projectId,
      role,
      expiresAt,
      inviteUrl: `papyrus projects accept-invite ${inviteCode}`,
    })
    return true
  }

  if (url.pathname === '/api/invite/accept' && method === 'POST') {
    const authCtx = requireAuth(req, res)
    if (!authCtx) return true

    const body = await parseBody(req)
    const inviteCode = body.inviteCode as string

    if (!inviteCode) {
      json(res, 400, { error: 'inviteCode required' })
      return true
    }

    // Look up invite
    const invite = getInvite(inviteCode)

    if (!invite) {
      json(res, 404, { error: 'Invalid or expired invite code' })
      return true
    }

    // Check expiration
    if (new Date(invite.expiresAt) < new Date()) {
      deleteInvite(inviteCode)
      json(res, 400, { error: 'Invite code has expired' })
      return true
    }

    // Assign role
    const assignment = assignRole(
      invite.projectId,
      authCtx.memberKey,
      invite.role as 'owner' | 'editor' | 'viewer',
      invite.createdBy,
    )

    // Delete used invite
    deleteInvite(inviteCode)

    auditLog({
      actor: authCtx.memberKey,
      action: 'create',
      entityType: 'membership',
      entityId: authCtx.memberKey,
      projectId: invite.projectId,
      details: { role: invite.role, invitedBy: invite.createdBy },
    })

    json(res, 200, {
      ok: true,
      projectId: invite.projectId,
      role: invite.role,
    })
    return true
  }

  // ── Skill execution endpoints ──────────────────────────────────

  if (url.pathname === '/api/skills' && method === 'GET') {
    json(res, 200, listSkills())
    return true
  }

  if (url.pathname === '/api/skill/run' && method === 'POST') {
    const authCtx = requireAuth(req, res)
    if (!authCtx) return true

    const body = await parseBody(req)
    const skillId = body.skillId as string
    const projectId = body.projectId as string
    const modelProvider = resolveModelProvider()

    if (!skillId || !projectId) {
      json(res, 400, { error: 'skillId and projectId required' })
      return true
    }

    if (!hasPermission(projectId, authCtx.memberKey, 'node:update')) {
      json(res, 403, { error: 'Project mutation access denied' })
      return true
    }

    if (!modelProvider) {
      json(res, 500, { error: 'LLM provider is not fully configured' })
      return true
    }

    // Resolve inputs from upstream nodes connected to this skill node
    const skillNodeId = body.nodeId as string | undefined
    const state = getOrCreateState(projectId)
    const inputs: Array<{ node: CanvasNodeDoc; edgeLabel?: string }> = []

    if (skillNodeId) {
      // Find edges where target is this skill node
      const inputEdges = state.edges.filter((e) => e.to === skillNodeId)
      for (const edge of inputEdges) {
        const inputNode = state.nodes.find((n) => n.id === edge.from)
        if (inputNode) {
          inputs.push({ node: inputNode })
        }
      }
    }

    // Also accept explicit input node IDs
    const inputNodeIds = body.inputNodeIds as string[] | undefined
    if (inputNodeIds) {
      for (const nodeId of inputNodeIds) {
        const node = state.nodes.find((n) => n.id === nodeId)
        if (node && !inputs.find((i) => i.node.id === nodeId)) {
          inputs.push({ node })
        }
      }
    }

    // Update skill node status to running
    if (skillNodeId) {
      const skillNode = state.nodes.find((n) => n.id === skillNodeId)
      if (skillNode) {
        skillNode.fields.status = 'running'
        skillNode.updatedAt = Date.now()
        commitStateMutation(projectId, state, {
          actorKey: authCtx.memberKey,
          entityType: 'node',
          entityId: skillNode.id,
          operationType: 'update',
          payload: skillNode,
        })
        broadcast(state, { type: 'node:upsert', data: skillNode })
      }
    }

    // Run the skill
    const result = await runSkill(skillId, inputs, modelProvider)

    // Create output nodes
    const createdNodes: CanvasNodeDoc[] = []
    for (const output of result.outputs) {
      const nodeDoc: CanvasNodeDoc = {
        id: `node-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        projectId,
        type: output.type,
        category: output.category as CanvasNodeDoc['category'],
        flowRole: 'artifact',
        position: { x: 200 + Math.random() * 400, y: 200 + Math.random() * 300 },
        fields: { title: output.title, content: output.content },
        status: 'draft',
        createdBy: `skill:${skillId}`,
        updatedAt: Date.now(),
      }
      state.nodes.push(nodeDoc)
      createdNodes.push(nodeDoc)
      commitStateMutation(projectId, state, {
        actorKey: authCtx.memberKey,
        entityType: 'node',
        entityId: nodeDoc.id,
        operationType: 'create',
        payload: nodeDoc,
      })
      broadcast(state, { type: 'node:upsert', data: nodeDoc })
    }

    // Update skill node status
    if (skillNodeId) {
      const skillNode = state.nodes.find((n) => n.id === skillNodeId)
      if (skillNode) {
        skillNode.fields.status = result.status
        skillNode.fields.runId = result.runId
        skillNode.updatedAt = Date.now()
        commitStateMutation(projectId, state, {
          actorKey: authCtx.memberKey,
          entityType: 'node',
          entityId: skillNode.id,
          operationType: 'update',
          payload: skillNode,
        })
        broadcast(state, { type: 'node:upsert', data: skillNode })
      }
    }

    json(res, 200, {
      status: result.status,
      runId: result.runId,
      error: result.error ?? null,
      createdNodes: createdNodes.map((n) => ({ id: n.id, type: n.type, title: n.fields.title })),
    })
    return true
  }

  // ── Agent chat endpoint ────────────────────────────────────────

  if (url.pathname === '/api/agent' && method === 'POST') {
    const authCtx = requireAuth(req, res)
    if (!authCtx) return true

    const body = await parseBody(req)
    const persona = body.persona as string
    const messages = body.messages as AgentMessage[] | undefined
    const projectId = body.projectId as string | undefined
    const attachments = body.attachments as string[] | undefined
    const parentNodeIds = Array.isArray(body.parentNodeIds)
      ? body.parentNodeIds.filter((id): id is string => typeof id === 'string')
      : []
    const modelProvider = resolveModelProvider()

    if (!persona || !messages) {
      json(res, 400, { error: 'persona and messages required' })
      return true
    }

    if (projectId && !hasPermission(projectId, authCtx.memberKey, 'node:update')) {
      json(res, 403, { error: 'Project mutation access denied' })
      return true
    }

    if (!modelProvider) {
      json(res, 500, { error: 'LLM provider is not fully configured' })
      return true
    }

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const task: GenerationTask = {
      id: taskId,
      projectId: projectId ?? 'unknown',
      persona,
      prompt: messages[messages.length - 1]?.content ?? '',
      status: 'running',
      startedAt: new Date().toISOString(),
    }
    tasks.set(taskId, task)

    try {
      const agent = createPersonaAgent(persona, modelProvider)

      // Inject attachment context into the last user message if provided
      const effectiveMessages =
        attachments && attachments.length > 0
          ? messages.map((m, i) =>
              i === messages.length - 1 && m.role === 'user'
                ? {
                    ...m,
                    content: `${m.content}\n\n--- Attached Context ---\n${attachments.join('\n\n')}`,
                  }
                : m,
            )
          : messages

      const response = await agent.chat(effectiveMessages)

      // Materialize each agent deliverable as a reviewable canvas proposal.
      const createdNodes: CanvasNodeDoc[] = []
      if (response.nodes.length > 0 && projectId) {
        const state = getOrCreateState(projectId)
        const row = Math.max(0, Math.floor(state.nodes.length / 3))
        for (const [index, proposedNode] of response.nodes.entries()) {
          const parentNode =
            state.nodes.find((node) => node.id === proposedNode.parentId) ??
            state.nodes.find((node) => parentNodeIds.includes(node.id)) ??
            state.nodes.find((node) => node.flowRole === 'source')
          const nodeDoc: CanvasNodeDoc = {
            id: `node-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 6)}`,
            projectId,
            type: proposedNode.type,
            category: proposedNode.category as CanvasNodeDoc['category'],
            flowRole: 'review',
            position: parentNode
              ? { x: parentNode.position.x + 420, y: parentNode.position.y + index * 240 }
              : { x: 340 + (index % 3) * 380, y: 140 + row * 300 },
            fields: {
              title: proposedNode.title,
              content: proposedNode.content,
              requestedPersona: persona,
            },
            status: 'proposed',
            createdBy: `agent:${persona}`,
            updatedAt: Date.now(),
          }

          state.nodes.push(nodeDoc)
          commitStateMutation(projectId, state, {
            actorKey: authCtx.memberKey,
            entityType: 'node',
            entityId: nodeDoc.id,
            operationType: 'create',
            payload: nodeDoc,
          })

          // Broadcast to all connected clients
          broadcast(state, { type: 'node:upsert', data: nodeDoc })
          createdNodes.push(nodeDoc)

          if (parentNode) {
            const edge: EdgeDoc = {
              id: `edge-${parentNode.id}-${nodeDoc.id}`,
              projectId,
              from: parentNode.id,
              to: nodeDoc.id,
              kind: 'derives',
              createdBy: `agent:${persona}`,
              updatedAt: Date.now(),
            }
            state.edges.push(edge)
            commitStateMutation(projectId, state, {
              actorKey: authCtx.memberKey,
              entityType: 'edge',
              entityId: edge.id,
              operationType: 'create',
              payload: edge,
            })
            broadcast(state, { type: 'edge:add', data: edge })
          }
        }

        const primaryNode = createdNodes[0]
        if (primaryNode) {
          task.nodeId = primaryNode.id
          task.nodeTitle = String(primaryNode.fields.title ?? primaryNode.type)
        }
      }

      task.status = 'done'
      task.completedAt = new Date().toISOString()

      json(res, 200, {
        text: response.text,
        nodes: createdNodes.map((node) => ({
          id: node.id,
          type: node.type,
          title: node.fields.title,
          status: node.status,
        })),
        taskId,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Agent error'
      task.status = 'error'
      task.error = message
      task.completedAt = new Date().toISOString()
      json(res, 500, { error: message, taskId })
    }
    return true
  }

  // ── Task list ───────────────────────────────────────────────
  if (url.pathname === '/api/tasks' && method === 'GET') {
    const authCtx = requireAuth(req, res)
    if (!authCtx) return true
    const projectId = url.searchParams.get('projectId')
    if (projectId && !hasPermission(projectId, authCtx.memberKey, 'project:read')) {
      json(res, 403, { error: 'Project access denied' })
      return true
    }
    let all = [...tasks.values()]
    if (projectId) {
      all = all.filter((t) => t.projectId === projectId)
    } else {
      all = all.filter(
        (task) =>
          task.projectId !== 'unknown' &&
          hasPermission(task.projectId, authCtx.memberKey, 'project:read'),
      )
    }
    all.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    json(res, 200, all.slice(0, 50))
    return true
  }

  // ── Retry generation ────────────────────────────────────────
  if (url.pathname === '/api/retry' && method === 'POST') {
    const authCtx = requireAuth(req, res)
    if (!authCtx) return true

    const body = await parseBody(req)
    const nodeId = body.nodeId as string
    const projectId = body.projectId as string
    const persona = (body.persona as string) ?? 'pm'
    const modelProvider = resolveModelProvider()

    if (!nodeId || !projectId) {
      json(res, 400, { error: 'nodeId and projectId required' })
      return true
    }

    if (!hasPermission(projectId, authCtx.memberKey, 'node:update')) {
      json(res, 403, { error: 'Project mutation access denied' })
      return true
    }

    // Find the node to get its original prompt context
    const state = getOrCreateState(projectId)
    const existingNode = state.nodes.find((n) => n.id === nodeId)
    if (!existingNode) {
      json(res, 400, { error: 'node not found' })
      return true
    }

    const title = (existingNode.fields.title as string) ?? existingNode.type
    const type = existingNode.type

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const task: GenerationTask = {
      id: taskId,
      projectId,
      persona,
      prompt: `Retry: regenerate ${type} "${title}"`,
      status: 'running',
      startedAt: new Date().toISOString(),
    }
    tasks.set(taskId, task)

    try {
      if (!modelProvider) throw new Error('LLM provider is not fully configured')
      const agent = createPersonaAgent(persona, modelProvider)
      const response = await agent.chat([
        {
          role: 'user',
          content: `Regenerate the ${type} titled "${title}". Create a fresh, improved version.`,
        },
      ])

      const replacement = response.nodes[0]
      if (replacement) {
        // Update the existing node
        existingNode.fields.title = replacement.title
        existingNode.fields.content = replacement.content
        existingNode.updatedAt = Date.now()
        existingNode.status = 'regenerated'

        commitStateMutation(projectId, state, {
          actorKey: authCtx.memberKey,
          entityType: 'node',
          entityId: nodeId,
          operationType: 'update',
          payload: existingNode,
        })
        broadcast(state, { type: 'node:upsert', data: existingNode })

        task.nodeId = nodeId
        task.nodeTitle = replacement.title
      }

      task.status = 'done'
      task.completedAt = new Date().toISOString()

      json(res, 200, { text: response.text, node: replacement ?? null, taskId })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Retry error'
      task.status = 'error'
      task.error = message
      task.completedAt = new Date().toISOString()
      json(res, 500, { error: message })
    }
    return true
  }

  // ── Upload attachments ──────────────────────────────────────
  if (url.pathname === '/api/upload' && method === 'POST') {
    const authCtx = requireAuth(req, res)
    if (!authCtx) return true

    const chunks: Buffer[] = []
    const contentType = req.headers['content-type'] ?? ''
    const filename = url.searchParams.get('filename') ?? 'attachment.txt'

    await new Promise<void>((resolve) => {
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => resolve())
    })

    const content = Buffer.concat(chunks).toString('utf-8')
    const attachmentText = `### ${filename}\n\`\`\`\n${content.slice(0, 5000)}\n\`\`\``

    json(res, 200, { text: attachmentText, filename, size: content.length })
    return true
  }

  // ── Org + onboarding endpoints ────────────────────────────────

  if (url.pathname === '/api/orgs' && method === 'GET') {
    const authCtx = requireAuth(req, res)
    if (!authCtx) return true
    json(res, 200, listOrgs())
    return true
  }

  if (url.pathname === '/api/orgs' && method === 'POST') {
    const authCtx = requireAuth(req, res)
    if (!authCtx) return true

    const body = await parseBody(req)
    const name = body.name as string | undefined
    const domain = body.domain as string | undefined

    if (!name || !domain) {
      json(res, 400, { error: 'name and domain required' })
      return true
    }

    const org = createOrg(name, domain, currentProfile(), authCtx.memberKey)
    auditLog({
      actor: authCtx.memberKey,
      action: 'create',
      entityType: 'organization',
      entityId: org.id,
      projectId: 'system',
      details: { name: org.name, domain: org.domain, profile: org.profile },
    })
    json(res, 201, org)
    return true
  }

  if (url.pathname === '/api/orgs/me' && method === 'GET') {
    const authCtx = requireAuth(req, res)
    if (!authCtx) return true
    const membership = getOrgForMember(authCtx.memberKey)
    json(res, 200, {
      profile: currentProfile(),
      org: membership?.org ?? null,
      membership,
    })
    return true
  }

  if (url.pathname === '/api/orgs/join' && method === 'POST') {
    const authCtx = requireAuth(req, res)
    if (!authCtx) return true

    const body = await parseBody(req)
    const orgId = body.orgId as string | undefined
    if (!orgId) {
      json(res, 400, { error: 'orgId required' })
      return true
    }

    if (!getOrg(orgId)) {
      json(res, 404, { error: 'Organization not found' })
      return true
    }

    const existing = getOrgForMember(authCtx.memberKey)
    const email = existing?.member.email ?? ''
    const membership = joinOrg(orgId, authCtx.memberKey, email, authCtx.displayName)
    auditLog({
      actor: authCtx.memberKey,
      action: 'create',
      entityType: 'membership',
      entityId: authCtx.memberKey,
      projectId: 'system',
      details: { orgId, role: membership?.role },
    })
    json(res, 200, membership)
    return true
  }

  if (url.pathname === '/api/onboarding/status' && method === 'GET') {
    const authCtx = requireAuth(req, res)
    if (!authCtx) return true
    const membership = getOrgForMember(authCtx.memberKey)
    json(res, 200, {
      onboarded: membership !== null,
      org: membership,
    })
    return true
  }

  if (url.pathname === '/api/onboarding' && method === 'POST') {
    const authCtx = requireAuth(req, res)
    if (!authCtx) return true

    const body = await parseBody(req)
    const email = (body.email as string | undefined)?.trim() ?? ''
    const displayName = (body.displayName as string | undefined)?.trim() ?? authCtx.displayName
    const orgName = (body.orgName as string | undefined)?.trim()
    const domain = (body.domain as string | undefined)?.trim()
    const avatarUrl =
      (body.avatarUrl as string | undefined)?.trim() ||
      generateAvatarUrl(email || null, displayName)

    if (!email || !orgName || !domain) {
      json(res, 400, { error: 'email, orgName, and domain required' })
      return true
    }

    const profile = currentProfile()
    const validation = validateEmailForProfile(email, profile)
    if (!validation.valid) {
      json(res, 400, { error: validation.reason ?? 'Invalid email for this profile' })
      return true
    }

    const existingOrg = findOrgByDomain(domain)
    let orgId: string

    if (existingOrg) {
      orgId = existingOrg.id
      joinOrg(orgId, authCtx.memberKey, email, displayName)
    } else {
      const created = createOrg(orgName, domain, profile, authCtx.memberKey)
      orgId = created.id
      joinOrg(orgId, authCtx.memberKey, email, displayName)
      auditLog({
        actor: authCtx.memberKey,
        action: 'create',
        entityType: 'organization',
        entityId: orgId,
        projectId: 'system',
        details: { name: orgName, domain, profile },
      })
    }

    updateProfile(authCtx.memberKey, displayName, avatarUrl)
    const membership = getMembership(orgId, authCtx.memberKey) as OrgMembership

    auditLog({
      actor: authCtx.memberKey,
      action: 'update',
      entityType: 'profile',
      entityId: authCtx.memberKey,
      projectId: 'system',
      details: { email, displayName, orgId },
    })

    json(res, 200, { org: getOrg(orgId), membership })
    return true
  }

  if (url.pathname === '/api/profile' && method === 'PUT') {
    const authCtx = requireAuth(req, res)
    if (!authCtx) return true

    const body = await parseBody(req)
    const displayName = (body.displayName as string | undefined)?.trim() ?? authCtx.displayName
    const existing = getOrgForMember(authCtx.memberKey)
    const email = existing?.member.email ?? ''
    const avatarUrl =
      (body.avatarUrl as string | undefined)?.trim() ||
      generateAvatarUrl(email || null, displayName)

    const updated = updateProfile(authCtx.memberKey, displayName, avatarUrl)
    if (!updated) {
      json(res, 404, { error: 'No membership found. Complete onboarding first.' })
      return true
    }

    auditLog({
      actor: authCtx.memberKey,
      action: 'update',
      entityType: 'profile',
      entityId: authCtx.memberKey,
      projectId: 'system',
      details: { displayName },
    })
    json(res, 200, { ok: true, displayName, avatarUrl })
    return true
  }

  return false
}

// ── Static file serving (SPA) ────────────────────────────────────

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
}

function serveSPA(res: ServerResponse, filePath: string): void {
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    // SPA fallback: serve index.html for client-side routing
    const indexPath = join(WEB_DIST, 'index.html')
    if (existsSync(indexPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      createReadStream(indexPath).pipe(res)
    } else {
      res.writeHead(404)
      res.end('Not found')
    }
    return
  }
  const ext = extname(filePath)
  res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' })
  createReadStream(filePath).pipe(res)
}

// ── WebSocket handler ────────────────────────────────────────────

function getDocument(state: ProjectState, projectId: string, nodeId: string): Y.Doc {
  const existing = state.documents.get(nodeId)
  if (existing) return existing
  const doc = new Y.Doc()
  const persisted = loadDocumentState(projectId, nodeId)
  if (persisted) Y.applyUpdate(doc, persisted)
  state.documents.set(nodeId, doc)
  return doc
}

function handleWS(ws: WebSocket, projectId: string, auth: AuthContext): void {
  const state = getOrCreateState(projectId)
  state.clients.add(ws)
  state.wsPeerMap.set(ws, auth.memberKey)

  // Send current canvas state
  const initMsg: ServerMsg = {
    type: 'canvas:state',
    data: {
      nodes: state.nodes,
      edges: state.edges,
      presence: [...state.presence.values()],
      revision: state.revision,
    },
  }
  ws.send(JSON.stringify(initMsg))
  for (const node of state.nodes) {
    const persisted = loadDocumentState(projectId, node.id)
    if (!persisted) continue
    ws.send(
      JSON.stringify({
        type: 'document:sync',
        data: {
          nodeId: node.id,
          update: Buffer.from(persisted).toString('base64'),
          revision: state.revision,
        },
      } satisfies ServerMsg),
    )
  }

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString()) as ClientMsg
      handleClientMsg(ws, state, projectId, auth, msg)
    } catch (error) {
      ws.send(
        JSON.stringify({
          type: 'operation:reject',
          data: {
            operationId: 'malformed',
            code: 'invalid-message',
            message: error instanceof Error ? error.message : 'Invalid message',
            projectRevision: state.revision,
          },
        } satisfies ServerMsg),
      )
    }
  })

  ws.on('close', () => {
    state.clients.delete(ws)
    // Remove presence and cursor mapping for this client
    const peerId = state.wsPeerMap.get(ws)
    state.wsPeerMap.delete(ws)
    if (peerId) {
      state.presence.delete(peerId)
      broadcast(state, { type: 'presence:leave', data: { peerId } })
      broadcast(state, { type: 'cursor:leave', data: { peerId } })
    }
  })
}

function handleClientMsg(
  ws: WebSocket,
  state: ProjectState,
  projectId: string,
  auth: AuthContext,
  msg: ClientMsg,
): void {
  const actor = auth.memberKey

  if (msg.type === 'presence:heartbeat') {
    const info: PresenceInfo = {
      peerId: actor,
      displayName: auth.displayName,
      color: msg.data.color,
      lastSeen: new Date().toISOString(),
    }
    state.presence.set(actor, info)
    broadcast(state, { type: 'presence:update', data: info }, ws)
    return
  }

  if (msg.type === 'cursor:move') {
    const cursorPresence = state.presence.get(actor)
    broadcast(
      state,
      {
        type: 'cursor:update',
        data: {
          peerId: actor,
          x: msg.data.x,
          y: msg.data.y,
          displayName: auth.displayName,
          color: cursorPresence?.color ?? '',
        },
      },
      ws,
    )
    return
  }

  const operationId = msg.operationId ?? `op-${randomUUID()}`
  const permission =
    msg.type === 'node:upsert'
      ? state.nodes.some((node) => node.id === msg.data.id)
        ? 'node:update'
        : 'node:create'
      : msg.type === 'node:delete'
        ? 'node:delete'
        : msg.type === 'edge:add'
          ? 'edge:create'
          : msg.type === 'edge:delete'
            ? 'edge:delete'
            : 'node:update'

  if (!hasPermission(projectId, actor, permission)) {
    ws.send(
      JSON.stringify({
        type: 'operation:reject',
        data: {
          operationId,
          code: 'permission-denied',
          message: `Permission required: ${permission}`,
          projectRevision: state.revision,
        },
      } satisfies ServerMsg),
    )
    return
  }

  const previousNodes = state.nodes
  const previousEdges = state.edges
  let broadcastMessage: ServerMsg | null = null
  let entityType: 'node' | 'edge' | 'document' = 'node'
  let entityId = ''
  let operationType: 'create' | 'update' | 'delete' = 'update'
  let payload: unknown

  switch (msg.type) {
    case 'node:upsert': {
      const idx = state.nodes.findIndex((n) => n.id === msg.data.id)
      const incoming: CanvasNodeDoc = {
        ...msg.data,
        projectId,
        createdBy: idx >= 0 ? (state.nodes[idx]?.createdBy ?? actor) : actor,
        updatedAt: Date.now(),
      }
      if (idx >= 0) {
        state.nodes = state.nodes.map((node, index) => (index === idx ? incoming : node))
        operationType = 'update'
      } else {
        state.nodes = [...state.nodes, incoming]
        operationType = 'create'
      }
      entityId = incoming.id
      payload = incoming
      broadcastMessage = { type: 'node:upsert', data: incoming }
      break
    }
    case 'node:delete': {
      state.nodes = state.nodes.filter((n) => n.id !== msg.data.id)
      state.edges = state.edges.filter(
        (edge) => edge.from !== msg.data.id && edge.to !== msg.data.id,
      )
      entityId = msg.data.id
      operationType = 'delete'
      broadcastMessage = { type: 'node:delete', data: msg.data }
      break
    }
    case 'edge:add': {
      entityType = 'edge'
      entityId = msg.data.id
      operationType = 'create'
      if (!state.edges.find((e) => e.id === msg.data.id)) {
        const edge = { ...msg.data, projectId, createdBy: actor, updatedAt: Date.now() }
        state.edges = [...state.edges, edge]
        payload = edge
        broadcastMessage = { type: 'edge:add', data: edge }
      }
      break
    }
    case 'edge:delete': {
      entityType = 'edge'
      entityId = msg.data.id
      operationType = 'delete'
      state.edges = state.edges.filter((e) => e.id !== msg.data.id)
      broadcastMessage = { type: 'edge:delete', data: msg.data }
      break
    }
    case 'document:sync': {
      entityType = 'document'
      entityId = msg.data.nodeId
      operationType = 'update'
      const update = Buffer.from(msg.data.update, 'base64')
      const doc = getDocument(state, projectId, msg.data.nodeId)
      Y.applyUpdate(doc, update)
      const content = doc.getText('content').toString()
      state.nodes = state.nodes.map((node) =>
        node.id === msg.data.nodeId
          ? { ...node, fields: { ...node.fields, content }, updatedAt: Date.now() }
          : node,
      )
      payload = { update: msg.data.update }
      broadcastMessage = {
        type: 'document:sync',
        data: { nodeId: msg.data.nodeId, update: msg.data.update, revision: state.revision + 1 },
      }
      break
    }
    default:
      return
  }

  try {
    const result = commitCanvasOperation(
      {
        id: operationId,
        projectId,
        actorKey: actor,
        entityType,
        entityId,
        operationType,
        payload,
        baseRevision: msg.baseRevision,
      },
      state.nodes,
      state.edges,
    )
    state.revision = result.projectRevision
    if (entityType === 'document') {
      const doc = getDocument(state, projectId, entityId)
      saveDocumentState(projectId, entityId, Y.encodeStateAsUpdate(doc), state.revision)
    }
    if (broadcastMessage && !result.duplicate) broadcast(state, broadcastMessage)
    ws.send(
      JSON.stringify({
        type: 'operation:ack',
        data: {
          operationId,
          projectRevision: result.projectRevision,
          duplicate: result.duplicate || undefined,
        },
      } satisfies ServerMsg),
    )
  } catch (error) {
    state.nodes = previousNodes
    state.edges = previousEdges
    ws.send(
      JSON.stringify({
        type: 'operation:reject',
        data: {
          operationId,
          code: 'operation-rejected',
          message: error instanceof Error ? error.message : 'Operation rejected',
          projectRevision: state.revision,
        },
      } satisfies ServerMsg),
    )
  }
}

// ── Start server ─────────────────────────────────────────────────

const requestHandler = async (req: IncomingMessage, res: ServerResponse) => {
  // API routes
  if (req.url?.startsWith('/api/')) {
    const handled = await handleAPI(req, res)
    if (handled) return
  }

  if (!licenseService.isLicensed()) {
    json(res, 402, { error: 'Papyrus license required', license: licenseService.getStatus() })
    return
  }

  // Static files from web dist
  const filePath = join(WEB_DIST, req.url === '/' ? 'index.html' : (req.url ?? ''))
  serveSPA(res, filePath)
}

// Check for TLS configuration (required for CAC/PIV mTLS)
const tlsCertPath = process.env.PAPYRUS_TLS_CERT
const tlsKeyPath = process.env.PAPYRUS_TLS_KEY
const useHttps = !!(tlsCertPath && tlsKeyPath && existsSync(tlsCertPath) && existsSync(tlsKeyPath))

const httpServer = (() => {
  if (!useHttps || !tlsCertPath || !tlsKeyPath) return createServer(requestHandler)
  return createHttpsServer(
    {
      cert: readFileSync(tlsCertPath, 'utf-8'),
      key: readFileSync(tlsKeyPath, 'utf-8'),
      ca:
        process.env.PAPYRUS_CAC_CA_BUNDLE && existsSync(process.env.PAPYRUS_CAC_CA_BUNDLE)
          ? readFileSync(process.env.PAPYRUS_CAC_CA_BUNDLE, 'utf-8')
          : undefined,
      requestCert: true,
      rejectUnauthorized: false,
    },
    requestHandler,
  )
})()

const wss = new WebSocketServer({ server: httpServer, path: '/ws' })

wss.on('connection', (ws, req) => {
  if (!licenseService.isLicensed()) {
    ws.close(1008, 'Papyrus license required')
    return
  }
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)
  const projectId = url.searchParams.get('project')
  const tokenProtocol = req.headers['sec-websocket-protocol']
    ?.split(',')
    .map((value) => value.trim())
    .find((value) => value.startsWith('papyrus-token.'))
  const token = tokenProtocol?.slice('papyrus-token.'.length)
  const session = token ? validateSessionToken(token) : null
  if (!projectId || !session) {
    ws.close(1008, 'authenticated project session required')
    return
  }
  if (!hasPermission(projectId, session.memberKey, 'project:read')) {
    ws.close(1008, 'project access denied')
    return
  }
  handleWS(ws, projectId, {
    memberKey: session.memberKey,
    displayName: session.displayName,
    expired: false,
  })
})

httpServer.listen(PORT, HOST, async () => {
  console.log('\n  PAPYRUS daemon')
  console.log('  ─────────────')
  console.log(`  ${useHttps ? 'HTTPS' : 'HTTP'}  ${useHttps ? 'https' : 'http'}://${HOST}:${PORT}`)
  if (useHttps) {
    console.log(
      `  mTLS  ${process.env.PAPYRUS_CAC_CA_BUNDLE ? 'CAC/PIV client cert verification active' : 'client certs requested (no CA bundle)'}`,
    )
  }
  console.log(`  WS    ${useHttps ? 'wss' : 'ws'}://${HOST}:${PORT}/ws`)
  console.log(`  API   ${useHttps ? 'https' : 'http'}://${HOST}:${PORT}/api/health`)

  // Auto-generate member identity on first run
  const identity = loadOrGenerateMemberIdentity()
  console.log(`  ID     ${identity.publicKey.slice(0, 16)}...`)

  const license = licenseService.getStatus()
  console.log(
    `  LICENSE ${license.valid ? `valid — ${license.licensee}` : `locked — ${license.reason}`}`,
  )
  console.log(`  DEPLOY  ${license.deploymentId}`)

  console.log()
})

// Prevent crashes from WebSocket disconnects or unhandled errors
process.on('uncaughtException', (err) => {
  console.error('  Uncaught exception:', err.message)
})
process.on('unhandledRejection', (err) => {
  console.error('  Unhandled rejection:', err)
})

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n  Shutting down...')
  closeDb()
  process.exit(0)
})

process.on('SIGTERM', () => {
  closeDb()
  process.exit(0)
})

export { httpServer, wss }
