import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { posix } from 'node:path'
import type { AgentLink, LinkInbound } from '@papyrus/contracts'
import {
  attachmentMatches,
  attachmentParameters,
  attachmentTarget,
  LinkExecutorAttachmentStore,
  type WebhookExecutorAttachment,
  type WebhookExecutionContext,
} from './link-executor-attachments.js'
import { fetchUrlPreviewImage } from './mastra/fetch-preview.js'
import { linkInboundHeaders, type MastraRuntime } from './mastra/runtime.js'

const MAX_LINK_BODY = 512 * 1024
const MAX_LINK_RESPONSE = 2 * 1024 * 1024
const MAX_LINK_ASSET = 100 * 1024 * 1024

/**
 * Public Link pages remain sandboxed and cannot execute scripts or make fetch/XHR
 * requests, but they may intentionally reference HTTPS photos (for example an image
 * selected from a public source while the page is being composed). `img-src` is the
 * narrow CSP directive that governs both <img> elements and CSS background images,
 * so allowing HTTPS here does not relax connect-src, frame-src, object-src, or forms.
 */
export const PUBLIC_LINK_WEBPAGE_CSP = "sandbox; default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; media-src 'self'; font-src 'self' data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'"

export async function handlePublicLink(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  mastra: MastraRuntime,
): Promise<boolean> {
  if (url.pathname === '/api/branding/entra-app-logo') {
    if (!['GET', 'HEAD'].includes(request.method ?? '')) return methodNotAllowed(response, ['GET', 'HEAD'])
    const logoUrl = process.env.PAPYRUS_ENTRA_APP_LOGO_URL?.trim()
    if (!logoUrl) return publicError(response, 404, 'ENTRA_APP_LOGO_NOT_CONFIGURED', 'Microsoft Entra App Registration logo is not configured')
    try {
      const image = await fetchUrlPreviewImage(logoUrl)
      const bytes = Buffer.from(image.bytes)
      publicHeaders(response)
      response.setHeader('cache-control', 'private, max-age=3600')
      response.setHeader('content-type', image.contentType)
      response.setHeader('content-length', String(bytes.byteLength))
      response.setHeader('content-disposition', 'inline; filename="entra-app-logo"')
      response.writeHead(200)
      response.end(request.method === 'HEAD' ? undefined : bytes)
      return true
    } catch {
      return publicError(response, 502, 'ENTRA_APP_LOGO_UNAVAILABLE', 'Microsoft Entra App Registration logo could not be loaded')
    }
  }

  const assetMatch = url.pathname.match(/^\/l\/([^/]+)\/assets\/([^/]+)$/)
  const match = url.pathname.match(/^\/l\/([^/]+)$/)
  if (!assetMatch && !match) return false

  let slug: string
  try { slug = decodeURIComponent((assetMatch?.[1] ?? match?.[1]) as string) } catch { return publicError(response, 400, 'INVALID_LINK', 'Invalid Link path') }

  const link = mastra.links.getBySlug(slug)
  if (!link || link.state !== 'live') return publicError(response, 404, 'LINK_NOT_FOUND', 'Link not found')

  try {
    if (assetMatch) {
      let assetName: string
      try { assetName = decodeURIComponent(assetMatch[2] as string) } catch { return publicError(response, 400, 'INVALID_LINK_ASSET', 'Invalid Link asset path') }
      return await serveLinkAsset(request, response, mastra, link, assetName)
    }
    if (link.type === 'webpage') return await serveWebpage(request, response, mastra, link)
    if (link.type === 'api') return await serveApi(request, response, url, mastra, link)
    return await acceptWebhook(request, response, url, mastra, link)
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'Link request failed'
    return publicError(response, 500, 'LINK_REQUEST_FAILED', message)
  }
}

async function serveLinkAsset(
  request: IncomingMessage,
  response: ServerResponse,
  mastra: MastraRuntime,
  link: AgentLink,
  assetName: string,
): Promise<true> {
  if (!['GET', 'HEAD'].includes(request.method ?? '')) return methodNotAllowed(response, ['GET', 'HEAD'])
  if (!assetName || posix.basename(assetName) !== assetName || assetName === '.' || assetName === '..') {
    return publicError(response, 400, 'INVALID_LINK_ASSET', 'Invalid Link asset path')
  }

  const assetPath = `${posix.dirname(link.blobPath)}/assets/${assetName}`
  if (!(await mastra.workspaceFilesystem.exists(assetPath))) return publicError(response, 404, 'LINK_ASSET_NOT_FOUND', 'Link asset not found')
  const file = await mastra.workspaceFilesystem.describeLibraryFile(assetPath)
  if (file.size > MAX_LINK_ASSET) return publicError(response, 413, 'LINK_ASSET_TOO_LARGE', 'Published Link asset exceeds the serving limit')
  const value = await mastra.workspaceFilesystem.readFile(assetPath)
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value)
  mastra.links.recordPing(link.id, { method: request.method ?? 'GET', surface: 'asset', asset: assetName })

  publicHeaders(response)
  response.setHeader('content-type', file.mediaType)
  response.setHeader('content-disposition', `inline; filename="${assetName.replace(/["\\]/g, '_')}"`)
  response.setHeader('accept-ranges', 'bytes')

  const range = typeof request.headers.range === 'string' ? request.headers.range : undefined
  const parsed = range ? parseByteRange(range, bytes.length) : undefined
  if (range && !parsed) {
    response.setHeader('content-range', `bytes */${bytes.length}`)
    response.writeHead(416)
    response.end()
    return true
  }

  if (parsed) {
    const chunk = bytes.subarray(parsed.start, parsed.end + 1)
    response.setHeader('content-range', `bytes ${parsed.start}-${parsed.end}/${bytes.length}`)
    response.setHeader('content-length', String(chunk.length))
    response.writeHead(206)
    response.end(request.method === 'HEAD' ? undefined : chunk)
    return true
  }

  response.setHeader('content-length', String(bytes.length))
  response.writeHead(200)
  response.end(request.method === 'HEAD' ? undefined : bytes)
  return true
}

async function serveWebpage(
  request: IncomingMessage,
  response: ServerResponse,
  mastra: MastraRuntime,
  link: AgentLink,
): Promise<true> {
  if (!['GET', 'HEAD'].includes(request.method ?? '')) return methodNotAllowed(response, ['GET', 'HEAD'])
  const stat = await mastra.workspaceFilesystem.stat(link.blobPath)
  if (stat.size > MAX_LINK_RESPONSE) return publicError(response, 413, 'LINK_TOO_LARGE', 'Published webpage exceeds the serving limit')
  const html = String(await mastra.workspaceFilesystem.readFile(link.blobPath, { encoding: 'utf8' }))
  mastra.links.recordPing(link.id, { method: request.method ?? 'GET', surface: 'webpage' })

  publicHeaders(response)
  response.setHeader('content-type', 'text/html; charset=utf-8')
  response.setHeader('content-security-policy', PUBLIC_LINK_WEBPAGE_CSP)
  response.writeHead(200)
  response.end(request.method === 'HEAD' ? undefined : html)
  return true
}

async function serveApi(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  mastra: MastraRuntime,
  link: AgentLink,
): Promise<true> {
  if (request.method === 'OPTIONS') {
    publicHeaders(response, true)
    response.setHeader('access-control-allow-methods', link.workflowId ? 'GET, POST, OPTIONS' : 'GET, HEAD, OPTIONS')
    response.setHeader('access-control-allow-headers', 'content-type')
    response.writeHead(204)
    response.end()
    return true
  }
  const allowed = link.workflowId ? ['GET', 'POST', 'HEAD'] : ['GET', 'HEAD']
  if (!allowed.includes(request.method ?? '')) return methodNotAllowed(response, allowed)

  mastra.links.recordPing(link.id, { method: request.method ?? 'GET', surface: 'api' })

  if (!link.workflowId) {
    const stat = await mastra.workspaceFilesystem.stat(link.blobPath)
    if (stat.size > MAX_LINK_RESPONSE) return publicError(response, 413, 'LINK_TOO_LARGE', 'Published API response exceeds the serving limit', true)
    const raw = String(await mastra.workspaceFilesystem.readFile(link.blobPath, { encoding: 'utf8' }))
    try { JSON.parse(raw) } catch { return publicError(response, 500, 'INVALID_LINK_RESPONSE', 'Published API snapshot is not valid JSON', true) }
    publicHeaders(response, true)
    response.setHeader('content-type', 'application/json; charset=utf-8')
    response.writeHead(200)
    response.end(request.method === 'HEAD' ? undefined : raw)
    return true
  }

  const body = request.method === 'POST' ? await jsonBody(request) : {}
  const input = {
    source: `papyrus-link:${link.id}`,
    kind: 'link-api',
    summary: `API Link ${link.name} invoked via ${request.method ?? 'GET'}`,
    payload: {
      method: request.method ?? 'GET',
      query: Object.fromEntries(url.searchParams.entries()),
      body,
    },
  }
  if (request.method === 'POST') {
    const inbound = await persistInbound(request, url, mastra, link, body)
    await mastra.acceptLinkInbound(link, inbound, input.payload)
  }
  const result = await mastra.runWorkflow(link.workflowId, input)
  publicHeaders(response, true)
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.writeHead(200)
  response.end(request.method === 'HEAD' ? undefined : JSON.stringify({ linkId: link.id, workflowId: link.workflowId, result }))
  return true
}

async function acceptWebhook(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  mastra: MastraRuntime,
  link: AgentLink,
): Promise<true> {
  const allowed = ['POST', 'PUT', 'PATCH']
  if (!allowed.includes(request.method ?? '')) return methodNotAllowed(response, allowed)
  const body = await jsonBody(request)
  const inbound = await persistInbound(request, url, mastra, link, body)
  const attachmentStore = new LinkExecutorAttachmentStore(mastra.actionStore.db)
  const attachments = attachmentStore.list(link.id)
  const enabledAttachments = attachments.filter((attachment) => attachment.enabled)

  // The session receives a projection of the durable attachment configuration so
  // agent_decides attachments are visible to reasoning without granting authority.
  const agentPayload = enabledAttachments.length
    ? {
        ...body,
        __papyrusExecutors: enabledAttachments.map((attachment) => ({
          attachmentId: attachment.id,
          executorIntegrationId: attachment.executorIntegrationId,
          executorName: attachment.executorName,
          action: attachment.action,
          target: attachment.target,
          invocationMode: attachment.invocationMode,
          approvalPolicy: attachment.approvalPolicy,
        })),
      }
    : body
  const signal = await mastra.acceptLinkWebhook(link, inbound, agentPayload, linkInboundHeaders(request.headers))
  const approvalIds = proposeAttachedWebhookActions(mastra, link, inbound, body, enabledAttachments)

  let workflowResult: unknown
  if (link.workflowId) {
    workflowResult = await mastra.runWorkflow(link.workflowId, {
      source: `papyrus-link:${link.id}`,
      kind: 'link-webhook',
      summary: `Webhook Link ${link.name} received ${request.method ?? 'POST'}`,
      payload: {
        inboundId: inbound.id,
        blobPath: inbound.blobPath,
        method: inbound.method,
        body,
      },
    })
  }

  publicHeaders(response, true)
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.writeHead(202)
  response.end(JSON.stringify({
    accepted: true,
    linkId: link.id,
    inboundId: inbound.id,
    sessionId: signal.sessionId,
    approvalIds,
    ...(link.workflowId ? { workflowId: link.workflowId, workflowResult } : {}),
  }))
  return true
}

function proposeAttachedWebhookActions(
  mastra: MastraRuntime,
  link: AgentLink,
  inbound: LinkInbound,
  body: Record<string, unknown>,
  attachments: WebhookExecutorAttachment[],
): string[] {
  const context: WebhookExecutionContext = {
    body,
    link: { id: link.id, slug: link.slug, name: link.name },
    inbound: { id: inbound.id, blobPath: inbound.blobPath, method: inbound.method, receivedAt: inbound.receivedAt },
  }
  const approvalIds: string[] = []

  for (const attachment of attachments) {
    if (!attachmentMatches(attachment, context)) continue
    const executor = mastra.actionStore.db.getIntegration(attachment.executorIntegrationId)
    // Attachment configuration is durable. Runtime availability is evaluated again here and
    // again on approval; an inactive executor never receives an action merely because it was
    // active when attached.
    if (!executor || executor.state !== 'active') continue

    const investigation = mastra.actionStore.createInvestigation({
      title: `Webhook action · ${link.name} → ${attachment.executorName}`,
      trigger: 'signal',
      triggerIntegrationId: attachment.executorIntegrationId,
      triggerMessageId: inbound.id,
    })
    const proposal = mastra.actionStore.createProposal({
      investigationId: investigation.id,
      proposedByOperatorId: `webhook-link:${link.id}`,
      executorIntegrationId: attachment.executorIntegrationId,
      action: attachment.action,
      target: attachmentTarget(attachment, context),
      parameters: attachmentParameters(attachment, context),
      rationaleClaimIds: [],
    })
    mastra.actionStore.db.recordActionEvent(attachment.executorIntegrationId, `webhook-link:${link.id}`, 'WebhookActionProposed', {
      proposalId: proposal.id,
      investigationId: investigation.id,
      linkId: link.id,
      inboundId: inbound.id,
      attachmentId: attachment.id,
      action: proposal.action,
      target: proposal.target,
      approvalPolicy: attachment.approvalPolicy,
    })
    approvalIds.push(proposal.id)
  }
  return approvalIds
}

async function persistInbound(
  request: IncomingMessage,
  url: URL,
  mastra: MastraRuntime,
  link: AgentLink,
  body: Record<string, unknown>,
): Promise<LinkInbound> {
  const receivedAt = new Date().toISOString()
  const envelope = {
    linkId: link.id,
    receivedAt,
    method: request.method ?? 'POST',
    path: url.pathname,
    query: Object.fromEntries(url.searchParams.entries()),
    headers: linkInboundHeaders(request.headers),
    body,
  }
  const bytes = Buffer.from(JSON.stringify(envelope, null, 2) + '\n')
  const blobPath = `/Library/Links/Inbound/${link.id}/${Date.now()}-${randomUUID()}.json`
  await mastra.workspaceFilesystem.writeFile(blobPath, bytes, { recursive: true, overwrite: false })
  const file = await mastra.workspaceFilesystem.describeLibraryFile(blobPath)
  return mastra.links.recordInbound({
    linkId: link.id,
    blobPath,
    method: request.method ?? 'POST',
    ...(typeof request.headers['content-type'] === 'string' ? { contentType: request.headers['content-type'] } : {}),
    receivedAt,
    size: file.size,
    sha256: file.sha256,
  })
}

async function jsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += value.length
    if (size > MAX_LINK_BODY) throw new Error('Link inbound body exceeds 512 KiB')
    chunks.push(value)
  }
  if (!chunks.length) return {}
  let parsed: unknown
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new Error('Link inbound body must be valid JSON') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Link inbound body must be a JSON object')
  return parsed as Record<string, unknown>
}

function parseByteRange(value: string, size: number): { start: number; end: number } | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim())
  if (!match || size <= 0) return undefined
  const startText = match[1] ?? ''
  const endText = match[2] ?? ''

  if (!startText) {
    const suffix = Number(endText)
    if (!Number.isInteger(suffix) || suffix <= 0) return undefined
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }

  const start = Number(startText)
  const requestedEnd = endText ? Number(endText) : size - 1
  if (!Number.isInteger(start) || !Number.isInteger(requestedEnd) || start < 0 || start >= size || requestedEnd < start) return undefined
  return { start, end: Math.min(requestedEnd, size - 1) }
}

function publicHeaders(response: ServerResponse, cors = false): void {
  response.setHeader('cache-control', 'no-store')
  response.setHeader('referrer-policy', 'no-referrer')
  response.setHeader('x-content-type-options', 'nosniff')
  response.setHeader('x-frame-options', 'SAMEORIGIN')
  response.setHeader('cross-origin-resource-policy', cors ? 'cross-origin' : 'same-origin')
  if (cors) response.setHeader('access-control-allow-origin', '*')
}

function publicError(response: ServerResponse, status: number, code: string, message: string, cors = false): true {
  publicHeaders(response, cors)
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.writeHead(status)
  response.end(JSON.stringify({ error: message, code }))
  return true
}

function methodNotAllowed(response: ServerResponse, methods: string[]): true {
  publicHeaders(response)
  response.setHeader('allow', methods.join(', '))
  response.writeHead(405)
  response.end()
  return true
}
