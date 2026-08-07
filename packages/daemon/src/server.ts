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
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import type { TLSSocket } from 'node:tls'
import { extname, join } from 'node:path'
import { type AgentMessage, createPersonaAgent, listSkills, runSkill } from '@papyrus/agents'
import { loadOrGenerateMemberIdentity } from '@papyrus/core/auth/keygen'
import {
  type AuthContext,
  createSessionToken,
  extractAuth,
  requireAuth,
} from '@papyrus/core/auth/middleware'
import { createAdapter, WebAuthnAdapter, OIDCAdapter, CACPIVAdapter, SAMLAdapter } from '@papyrus/core'
import type { CanvasNodeDoc, EdgeDoc } from '@papyrus/core/nodes/types'
import type { ClientMsg, ServerMsg } from '@papyrus/core/sync/protocol'
import type { PresenceInfo } from '@papyrus/core/sync/protocol'
import {
  type Operation,
  appendOperation,
  applyBundle,
  applyOperationsToState,
  exportBundle,
  getOperations,
  getOperationsSince,
  verifyBundle,
} from '@papyrus/core/transfer/cross-domain'
import { type NetworkProject, PapyrusNetwork } from '@papyrus/network'
import { WebSocket, WebSocketServer } from 'ws'
import { type AuditAction, auditLog, getAuditLog, verifyAuditChain } from './audit.js'
import {
  closeDb,
  createInvite,
  createProject,
  deleteInvite,
  deleteProject,
  getInvite,
  listProjects,
  loadProject,
  saveCanvas,
  deleteWebAuthnCredential,
  getWebAuthnCredential,
  getWebAuthnCredentialsForMember,
  saveWebAuthnCredential,
  updateWebAuthnCredentialCounter,
} from './database.js'
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
import { assignRole, getProjectRoles, getRole, removeRole, requirePermission } from './rbac.js'

const PORT = Number(process.env.PAPYRUS_PORT ?? 3777)
const WEB_DIST = join(import.meta.dirname ?? '.', '../../web/dist')

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

// ── Network (Iroh P2P) ────────────────────────────────────────

const network = new PapyrusNetwork()
let networkReady = false

async function initNetwork(): Promise<void> {
  try {
    const nodeId = await network.init()
    console.log(`  IROH    ${nodeId}`)
    networkReady = true

    // Announce existing projects
    for (const p of listProjects()) {
      network.announceProject({
        id: p.id,
        name: p.name,
        ownerId: nodeId,
        nodeCount: p.nodes.length,
        updatedAt: Date.now(),
      })
    }

    // Listen for canvas sync from Iroh peers
    network.on('canvas:sync', (data) => {
      const { projectId, nodes, edges } = data as {
        projectId: string
        nodes: CanvasNodeDoc[]
        edges: EdgeDoc[]
      }
      const state = getOrCreateState(projectId)
      state.nodes = nodes
      state.edges = edges
      saveCanvas(projectId, nodes, edges)

      // Push to all connected WS clients
      broadcast(state, {
        type: 'canvas:state',
        data: { nodes, edges, presence: [...state.presence.values()] },
      })
    })
  } catch (err) {
    console.error('  IROH    Failed to initialize:', err instanceof Error ? err.message : err)
  }
}

// ── In-memory state per project ──────────────────────────────────

interface ProjectState {
  nodes: CanvasNodeDoc[]
  edges: EdgeDoc[]
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
    json(res, 200, { ok: true, projects: listProjects().length })
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

  if (url.pathname === '/api/auth/login' && method === 'POST') {
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
    revokeSessionToken()
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
      // If no role assigned but project has no roles at all, auto-assign owner
      if (!role && getProjectRoles(projectId).length === 0) {
        role = 'owner'
        assignRole(projectId, ctx.memberKey, 'owner', ctx.memberKey)
      }
    }
    json(res, 200, { memberKey: ctx.memberKey, displayName: ctx.displayName, role })
    return true
  }

  // ── WebAuthn Endpoints ──────────────────────────────────────────

  if (url.pathname === '/api/auth/webauthn/register/start' && method === 'POST') {
    const body = await parseBody(req)
    const memberKey = body.memberKey as string
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
    const body = await parseBody(req)
    const memberKey = body.memberKey as string
    const credential = body.credential as any
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
    const origin = process.env.WEBAUTHN_ORIGIN ?? new URL(body.origin as string ?? 'http://localhost:3777').origin
    const rpId = process.env.WEBAUTHN_RP_ID ?? new URL(origin).hostname
    try {
      const result = await adapter.registerComplete(
        { method: 'webauthn', data: credential },
        stored.challenge,
        origin,
        rpId,
      )
      // Save credential to database
      saveWebAuthnCredential(memberKey, result.credentialId, result.publicKey, result.counter, result.aaguid)
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
    const credential = body.credential as any
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
    const origin = process.env.WEBAUTHN_ORIGIN ?? new URL(body.origin as string ?? 'http://localhost:3777').origin
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
    json(res, 200, credentials.map((c) => ({
      credentialId: c.credentialId,
      aaguid: c.aaguid,
      counter: c.counter,
      createdAt: c.createdAt,
    })))
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
    const redirectUri = process.env.OIDC_REDIRECT_URI ?? 'http://localhost:3777/api/auth/oidc/callback'
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
    // Check if the connection has a client certificate (mTLS)
    const tlsSocket = req.socket as TLSSocket
    const peerCert = tlsSocket.peerCertificate
    const hasCert = !!peerCert && peerCert !== undefined
    json(res, 200, {
      mtlsEnabled: req.socket.constructor.name === 'TLSSocket',
      hasClientCert: hasCert,
      subject: hasCert ? (peerCert as { subject: string }).subject : null,
      issuer: hasCert ? (peerCert as { issuer: string }).issuer : null,
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
    // Try to get cert from mTLS socket first, fall back to body
    const tlsSocket = req.socket as TLSSocket
    let certPem: string | undefined

    const peerCert = tlsSocket.peerCertificate as unknown
    if (peerCert && typeof peerCert === 'object' && 'raw' in peerCert) {
      certPem = `-----BEGIN CERTIFICATE-----\n${Buffer.from((peerCert as { raw: Uint8Array }).raw).toString('base64')}\n-----END CERTIFICATE-----`
    }

    if (!certPem) {
      const body = await parseBody(req)
      certPem = body.certPem as string
    }

    if (!certPem) {
      json(res, 400, { error: 'No client certificate presented. Connect via HTTPS with a CAC/PIV card, or provide certPem in the request body.' })
      return true
    }

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
        details: { method: 'cac-piv', externalId: result.externalId, displayName: result.displayName },
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
    json(res, 200, listProjects())
    return true
  }

  if (url.pathname === '/api/projects' && method === 'POST') {
    const authCtx = requireAuth(req, res)
    if (!authCtx) return true

    const body = await parseBody(req)
    const name = (body.name as string) ?? 'Untitled Project'
    const project = createProject(name)

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
    saveCanvas(project.id, [specNode], [])

    appendOperation({
      type: 'node:create',
      projectId: project.id,
      targetId: specNode.id,
      data: specNode,
      authorKey: authCtx.memberKey,
    })

    // Announce on the network
    if (networkReady) {
      network.announceProject({
        id: project.id,
        name: project.name,
        ownerId: network.nodeId(),
        nodeCount: 1,
        updatedAt: Date.now(),
      })
    }

    json(res, 201, { ...project, nodes: [specNode] })
    return true
  }

  const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/)
  if (projectMatch && method === 'GET') {
    const id = projectMatch[1]
    if (!id) {
      json(res, 400, { error: 'missing project id' })
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
    const id = projectMatch[1]
    if (!id) {
      json(res, 400, { error: 'missing project id' })
      return true
    }
    const deleted = deleteProject(id)
    if (!deleted) {
      json(res, 404, { error: 'not found' })
      return true
    }
    // Remove from network
    if (networkReady) {
      network.removeProject(id)
    }
    // Remove from in-memory state
    projects.delete(id)
    json(res, 200, { ok: true })
    return true
  }

  // ── Network endpoints (Iroh P2P) ──────────────────────────────

  if (url.pathname === '/api/network/status') {
    json(res, 200, {
      ready: networkReady,
      nodeId: networkReady ? network.nodeId() : null,
      stats: networkReady ? network.getStats() : null,
    })
    return true
  }

  if (url.pathname === '/api/network/ticket' && method === 'GET') {
    if (!networkReady) {
      json(res, 503, { error: 'network not ready' })
      return true
    }
    const ticket = await network.getTicket()
    json(res, 200, { ticket })
    return true
  }

  if (url.pathname === '/api/network/connect' && method === 'POST') {
    if (!networkReady) {
      json(res, 503, { error: 'network not ready' })
      return true
    }
    const body = await parseBody(req)
    const ticket = body.ticket as string
    if (!ticket) {
      json(res, 400, { error: 'ticket required' })
      return true
    }
    try {
      const peerId = await network.connect(ticket)
      json(res, 200, { peerId })
    } catch (err) {
      json(res, 500, { error: err instanceof Error ? err.message : 'connect failed' })
    }
    return true
  }

  if (url.pathname === '/api/network/projects') {
    json(res, 200, networkReady ? network.getNetworkProjects() : [])
    return true
  }

  if (url.pathname === '/api/network/peers') {
    json(res, 200, networkReady ? network.getPeers() : [])
    return true
  }

  if (url.pathname === '/api/network/disconnect' && method === 'POST') {
    if (!networkReady) {
      json(res, 503, { error: 'network not ready' })
      return true
    }
    const body = await parseBody(req)
    const peerId = body.peerId as string
    if (!peerId) {
      json(res, 400, { error: 'peerId required' })
      return true
    }
    await network.disconnect(peerId)
    json(res, 200, { ok: true })
    return true
  }

  if (url.pathname === '/api/network/broadcast' && method === 'POST') {
    if (!networkReady) {
      json(res, 503, { error: 'network not ready' })
      return true
    }
    const body = await parseBody(req)
    const projectId = body.projectId as string
    if (!projectId) {
      json(res, 400, { error: 'projectId required' })
      return true
    }
    const state = projects.get(projectId)
    if (state) {
      network.broadcastCanvas(projectId, state.nodes, state.edges)
    }
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
    const sinceSeq = (body.sinceSeq as number) ?? 0

    if (!projectId) {
      json(res, 400, { error: 'projectId required' })
      return true
    }

    // Load member identity for signing
    const identity = loadOrGenerateMemberIdentity()
    const bundle = await exportBundle(
      projectId,
      sourceDomain,
      identity.publicKey,
      identity.privateKey,
      sinceSeq,
    )
    json(res, 200, bundle)
    return true
  }

  if (url.pathname === '/api/transfer/import' && method === 'POST') {
    const authCtx = requireAuth(req, res)
    if (!authCtx) return true

    const body = await parseBody(req)
    const projectId = body.projectId as string
    const bundle = body.bundle as Awaited<ReturnType<typeof exportBundle>> | undefined

    if (!projectId || !bundle) {
      json(res, 400, { error: 'projectId and bundle required' })
      return true
    }

    // Verify bundle integrity
    const valid = await verifyBundle(bundle)
    if (!valid) {
      json(res, 400, { error: 'Bundle integrity check failed' })
      return true
    }

    // Get existing operations
    const existingOps = getOperations(projectId)

    // Apply bundle
    const applied = applyBundle(bundle, projectId, existingOps)

    // Apply operations to canvas state
    const state = getOrCreateState(projectId)
    const merged = applyOperationsToState(applied, state.nodes, state.edges)
    state.nodes = merged.nodes
    state.edges = merged.edges

    // Persist
    saveCanvas(projectId, state.nodes, state.edges)

    // Broadcast to WS clients
    broadcast(state, {
      type: 'canvas:state',
      data: { nodes: state.nodes, edges: state.edges, presence: [...state.presence.values()] },
    })

    // Audit
    auditLog({
      actor: 'system',
      action: 'import',
      entityType: 'transfer',
      entityId: `bundle-${bundle.exportedAt}`,
      projectId,
      details: { operationsApplied: applied.length, sourceDomain: bundle.sourceDomain },
    })

    json(res, 200, { ok: true, operationsApplied: applied.length })
    return true
  }

  if (url.pathname === '/api/transfer/operations' && method === 'GET') {
    const projectId = url.searchParams.get('projectId')
    if (!projectId) {
      json(res, 400, { error: 'projectId required' })
      return true
    }
    const sinceSeq = Number(url.searchParams.get('sinceSeq') ?? '0')
    const ops = sinceSeq > 0 ? getOperationsSince(projectId, sinceSeq) : getOperations(projectId)
    json(res, 200, ops)
    return true
  }

  // ── Audit endpoints ───────────────────────────────────────────

  if (url.pathname === '/api/audit' && method === 'GET') {
    const projectId = url.searchParams.get('projectId')
    if (!projectId) {
      json(res, 400, { error: 'projectId required' })
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
    const projectId = url.searchParams.get('projectId')
    if (!projectId) {
      json(res, 400, { error: 'projectId required' })
      return true
    }

    const result = verifyAuditChain(projectId)
    json(res, 200, result)
    return true
  }

  // ── RBAC endpoints ────────────────────────────────────────────

  if (url.pathname === '/api/rbac/roles' && method === 'GET') {
    const projectId = url.searchParams.get('projectId')
    if (!projectId) {
      json(res, 400, { error: 'projectId required' })
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
    const apiKey = process.env.OPENROUTER_API_KEY ?? process.env.OPENAI_API_KEY ?? ''

    if (!skillId || !projectId) {
      json(res, 400, { error: 'skillId and projectId required' })
      return true
    }

    if (!apiKey) {
      json(res, 500, { error: 'OPENROUTER_API_KEY not configured' })
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
        broadcast(state, { type: 'node:upsert', data: skillNode })
      }
    }

    // Run the skill
    const result = await runSkill(skillId, inputs, apiKey)

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
      broadcast(state, { type: 'node:upsert', data: nodeDoc })
      appendOperation({
        type: 'node:create',
        projectId,
        targetId: nodeDoc.id,
        data: nodeDoc,
        authorKey: `skill:${skillId}`,
      })
    }

    // Update skill node status
    if (skillNodeId) {
      const skillNode = state.nodes.find((n) => n.id === skillNodeId)
      if (skillNode) {
        skillNode.fields.status = result.status
        skillNode.fields.runId = result.runId
        broadcast(state, { type: 'node:upsert', data: skillNode })
        appendOperation({
          type: 'node:update',
          projectId,
          targetId: skillNodeId,
          data: skillNode,
          authorKey: `skill:${skillId}`,
        })
      }
    }

    // Persist
    saveCanvas(projectId, state.nodes, state.edges)

    // Broadcast to Iroh peers
    if (networkReady) network.broadcastCanvas(projectId, state.nodes, state.edges)

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
    const apiKey = process.env.OPENROUTER_API_KEY ?? process.env.OPENAI_API_KEY ?? ''

    if (!persona || !messages) {
      json(res, 400, { error: 'persona and messages required' })
      return true
    }

    if (!apiKey) {
      json(res, 500, { error: 'OPENROUTER_API_KEY not configured' })
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
      const agent = createPersonaAgent(persona, apiKey)

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

      // If the agent produced a node, add it to the canvas
      if (response.node && projectId) {
        const nodeDoc: CanvasNodeDoc = {
          id: `node-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          projectId,
          type: response.node.type,
          category: response.node.category as CanvasNodeDoc['category'],
          flowRole: 'exit',
          position: { x: 300 + Math.random() * 400, y: 100 + Math.random() * 300 },
          fields: {
            title: response.node.title,
            content: response.node.content,
          },
          status: response.node.status ?? 'generated',
          createdBy: `agent:${persona}`,
          updatedAt: Date.now(),
        }

        // Add to project state
        const state = getOrCreateState(projectId)
        state.nodes.push(nodeDoc)
        saveCanvas(projectId, state.nodes, state.edges)

        // Log to transfer operation log
        appendOperation({
          type: 'node:create',
          projectId,
          targetId: nodeDoc.id,
          data: nodeDoc,
          authorKey: `agent:${persona}`,
        })

        // Broadcast to all connected clients
        broadcast(state, { type: 'node:upsert', data: nodeDoc })

        task.nodeId = nodeDoc.id
        task.nodeTitle = response.node.title
      }

      task.status = 'done'
      task.completedAt = new Date().toISOString()

      json(res, 200, {
        text: response.text,
        node: response.node ?? null,
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
    const projectId = url.searchParams.get('projectId')
    let all = [...tasks.values()]
    if (projectId) all = all.filter((t) => t.projectId === projectId)
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
    const apiKey = process.env.OPENROUTER_API_KEY ?? process.env.OPENAI_API_KEY ?? ''

    if (!nodeId || !projectId) {
      json(res, 400, { error: 'nodeId and projectId required' })
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
      const agent = createPersonaAgent(persona, apiKey)
      const response = await agent.chat([
        {
          role: 'user',
          content: `Regenerate the ${type} titled "${title}". Create a fresh, improved version.`,
        },
      ])

      if (response.node) {
        // Update the existing node
        existingNode.fields.title = response.node.title
        existingNode.fields.content = response.node.content
        existingNode.updatedAt = Date.now()
        existingNode.status = 'regenerated'

        saveCanvas(projectId, state.nodes, state.edges)
        appendOperation({
          type: 'node:update',
          projectId,
          targetId: nodeId,
          data: existingNode,
          authorKey: `agent:${persona}`,
        })
        broadcast(state, { type: 'node:upsert', data: existingNode })

        task.nodeId = nodeId
        task.nodeTitle = response.node.title
      }

      task.status = 'done'
      task.completedAt = new Date().toISOString()

      json(res, 200, { text: response.text, node: response.node ?? null, taskId })
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

function handleWS(ws: WebSocket, projectId: string): void {
  const state = getOrCreateState(projectId)
  state.clients.add(ws)

  // Send current canvas state
  const initMsg: ServerMsg = {
    type: 'canvas:state',
    data: {
      nodes: state.nodes,
      edges: state.edges,
      presence: [...state.presence.values()],
    },
  }
  ws.send(JSON.stringify(initMsg))

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString()) as ClientMsg
      handleClientMsg(ws, state, projectId, msg)
    } catch {
      // ignore malformed messages
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
  msg: ClientMsg,
): void {
  const actor = state.wsPeerMap.get(ws) ?? 'unknown'

  switch (msg.type) {
    case 'node:upsert': {
      const idx = state.nodes.findIndex((n) => n.id === msg.data.id)
      if (idx >= 0) {
        // Fine-grained LWW: merge fields individually
        const existing = state.nodes[idx]
        if (existing) {
          const incoming = msg.data
          // If incoming is clearly newer, replace entirely
          if (incoming.updatedAt > existing.updatedAt + 1000) {
            state.nodes[idx] = incoming
            broadcast(state, { type: 'node:upsert', data: incoming }, ws)
            appendOperation({
              type: 'node:update',
              projectId,
              targetId: incoming.id,
              data: incoming,
              authorKey: actor,
            })
          } else if (incoming.updatedAt > existing.updatedAt) {
            // Merge: keep fields from both, prefer newer values
            const merged = { ...existing }
            merged.fields = { ...existing.fields }
            // Merge incoming fields that are different
            for (const [key, value] of Object.entries(incoming.fields)) {
              if (key in existing.fields) {
                // Field exists in both — keep incoming (it's newer)
                ;(merged.fields as Record<string, unknown>)[key] = value
              } else {
                // New field from incoming
                ;(merged.fields as Record<string, unknown>)[key] = value
              }
            }
            // Keep existing fields not in incoming
            merged.updatedAt = incoming.updatedAt
            merged.status = incoming.status
            state.nodes[idx] = merged
            broadcast(state, { type: 'node:upsert', data: merged }, ws)
            appendOperation({
              type: 'node:update',
              projectId,
              targetId: merged.id,
              data: merged,
              authorKey: actor,
            })
          }
          // If existing is newer, ignore incoming (last-write-wins)
        }
      } else {
        state.nodes.push(msg.data)
        broadcast(state, { type: 'node:upsert', data: msg.data }, ws)
        appendOperation({
          type: 'node:create',
          projectId,
          targetId: msg.data.id,
          data: msg.data,
          authorKey: actor,
        })
      }
      persistIfState(projectId)
      if (networkReady) network.broadcastCanvas(projectId, state.nodes, state.edges)
      break
    }
    case 'node:delete': {
      state.nodes = state.nodes.filter((n) => n.id !== msg.data.id)
      broadcast(state, { type: 'node:delete', data: msg.data }, ws)
      appendOperation({
        type: 'node:delete',
        projectId,
        targetId: msg.data.id,
        authorKey: actor,
      })
      persistIfState(projectId)
      if (networkReady) network.broadcastCanvas(projectId, state.nodes, state.edges)
      break
    }
    case 'edge:add': {
      if (!state.edges.find((e) => e.id === msg.data.id)) {
        state.edges.push(msg.data)
        broadcast(state, { type: 'edge:add', data: msg.data }, ws)
        appendOperation({
          type: 'edge:create',
          projectId,
          targetId: msg.data.id,
          data: msg.data,
          authorKey: actor,
        })
        persistIfState(projectId)
        if (networkReady) network.broadcastCanvas(projectId, state.nodes, state.edges)
      }
      break
    }
    case 'edge:delete': {
      state.edges = state.edges.filter((e) => e.id !== msg.data.id)
      broadcast(state, { type: 'edge:delete', data: msg.data }, ws)
      appendOperation({
        type: 'edge:delete',
        projectId,
        targetId: msg.data.id,
        authorKey: actor,
      })
      persistIfState(projectId)
      if (networkReady) network.broadcastCanvas(projectId, state.nodes, state.edges)
      break
    }
    case 'presence:heartbeat': {
      const info: PresenceInfo = {
        peerId: msg.data.peerId,
        displayName: msg.data.displayName,
        color: msg.data.color,
        lastSeen: new Date().toISOString(),
      }
      state.presence.set(info.peerId, info)
      state.wsPeerMap.set(ws, info.peerId)
      broadcast(state, { type: 'presence:update', data: info }, ws)
      break
    }
    case 'cursor:move': {
      // Broadcast cursor position to all other clients
      const cursorPeerId = state.wsPeerMap.get(ws) ?? 'unknown'
      const cursorPresence = state.presence.get(cursorPeerId)
      broadcast(
        state,
        {
          type: 'cursor:update',
          data: {
            peerId: cursorPeerId,
            x: msg.data.x,
            y: msg.data.y,
            displayName: cursorPresence?.displayName ?? '',
            color: cursorPresence?.color ?? '',
          },
        },
        ws,
      )
      break
    }
  }
}

// ── Start server ─────────────────────────────────────────────────

const requestHandler = async (req: IncomingMessage, res: ServerResponse) => {
  // API routes
  if (req.url?.startsWith('/api/')) {
    const handled = await handleAPI(req, res)
    if (handled) return
  }

  // Static files from web dist
  const filePath = join(WEB_DIST, req.url === '/' ? 'index.html' : (req.url ?? ''))
  serveSPA(res, filePath)
}

// Check for TLS configuration (required for CAC/PIV mTLS)
const tlsCertPath = process.env.PAPYRUS_TLS_CERT
const tlsKeyPath = process.env.PAPYRUS_TLS_KEY
const useHttps = !!(tlsCertPath && tlsKeyPath && existsSync(tlsCertPath) && existsSync(tlsKeyPath))

const httpServer = useHttps
  ? createHttpsServer({
      cert: readFileSync(tlsCertPath!, 'utf-8'),
      key: readFileSync(tlsKeyPath!, 'utf-8'),
      ca: process.env.PAPYRUS_CAC_CA_BUNDLE && existsSync(process.env.PAPYRUS_CAC_CA_BUNDLE)
        ? readFileSync(process.env.PAPYRUS_CAC_CA_BUNDLE, 'utf-8')
        : undefined,
      requestCert: true,
      rejectUnauthorized: false,
    }, requestHandler)
  : createServer(requestHandler)

const wss = new WebSocketServer({ server: httpServer, path: '/ws' })

wss.on('connection', (ws, req) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)
  const projectId = url.searchParams.get('project')
  if (!projectId) {
    ws.close(1008, 'missing project id')
    return
  }
  handleWS(ws, projectId)
})

httpServer.listen(PORT, async () => {
  console.log('\n  PAPYRUS daemon')
  console.log('  ─────────────')
  console.log(`  ${useHttps ? 'HTTPS' : 'HTTP'}  ${useHttps ? 'https' : 'http'}://localhost:${PORT}`)
  if (useHttps) {
    console.log(`  mTLS  ${process.env.PAPYRUS_CAC_CA_BUNDLE ? 'CAC/PIV client cert verification active' : 'client certs requested (no CA bundle)'}`)
  }
  console.log(`  WS    ws://localhost:${PORT}/ws`)
  console.log(`  API   http://localhost:${PORT}/api/health`)

  // Auto-generate member identity on first run
  const identity = loadOrGenerateMemberIdentity()
  console.log(`  ID     ${identity.publicKey.slice(0, 16)}...`)

  // Initialize Iroh P2P network
  await initNetwork()

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
process.on('SIGINT', async () => {
  console.log('\n  Shutting down...')
  await network.close()
  closeDb()
  process.exit(0)
})

process.on('SIGTERM', async () => {
  await network.close()
  closeDb()
  process.exit(0)
})

export { httpServer, wss }
