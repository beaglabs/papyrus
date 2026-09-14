import { createHash } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { IntegrationConfiguration } from '@papyrus/contracts'
import type { AgentDatabase } from '../database.js'
import { ConsolePolicy } from '../browser/policy.js'
import type { ActionResult, ActionExecutor, ActionExecutorContext } from '../action-worker.js'
import { FIREWALL_CATALOG_ID } from '../catalog.js'

/**
 * Connector writes for the controlled-action executor class.
 *
 * This is the vendor-neutral half of `firewall-executor`: it performs one bounded,
 * origin-pinned HTTPS write that an operator already released through the action
 * ledger. It makes no policy decision of its own beyond the endpoint, method, path,
 * and size rules below, because validation, authorization, queueing, and idempotency
 * belong to the ledger and the worker that calls it.
 *
 * Three rules matter more than the rest:
 *
 * 1. The request can only ever reach the origin the operator registered for this
 *    integration. `ConsolePolicy` is reused deliberately: an appliance or firewall
 *    lives at 10.x.x.x, so the guard for it is the integration, not an address range.
 *    A path that names another origin is refused rather than followed.
 * 2. A credential is resolved at this boundary and never returned, logged, or placed
 *    in an action result. The default resolver refuses until the customer wires its
 *    own vault, so an unconfigured deployment cannot write anywhere.
 * 3. Failures are separated by whether retrying could help. A malformed proposal is
 *    completed as `failure`; a transport fault throws so the worker's lease and
 *    backoff apply. Throwing on a validation error would retry it `maxAttempts` times
 *    for no reason.
 */

/** Action vocabulary for this executor, mirroring the catalog entry's capabilities. */
export const FIREWALL_ACTIONS = ['block_route', 'quarantine_segment', 'revoke_temporary_rule'] as const
export type FirewallAction = (typeof FIREWALL_ACTIONS)[number]

const ALLOWED_METHODS = ['POST', 'PUT', 'PATCH'] as const
const MAX_REQUEST_BYTES = 256 * 1024
const MAX_RESPONSE_BYTES = 64 * 1024
const DEFAULT_TIMEOUT_MS = 15_000

/** Headers the credential resolver may not supply, because the executor owns them. */
const RESERVED_HEADERS = new Set(['host', 'content-length', 'content-type', 'idempotency-key', 'transfer-encoding', 'connection'])

export interface ConnectorCredential {
  /** Headers the customer's credential material produces, such as Authorization. */
  headers?: Record<string, string>
}

/**
 * Turns an integration's opaque `credentialRef` into request headers at execution
 * time. Implementations must never return a value that reaches chat, a log, or an
 * action result.
 */
export interface ConnectorCredentialResolver {
  resolve(integration: IntegrationConfiguration, signal?: AbortSignal): Promise<ConnectorCredential>
}

export class ConnectorCredentialUnavailableError extends Error {
  constructor(message = 'No connector credential resolver is configured for this integration') {
    super(message)
    this.name = 'ConnectorCredentialUnavailableError'
  }
}

/** The default boundary refuses rather than guessing, matching the device and Graph resolvers. */
export class UnconfiguredConnectorCredentialResolver implements ConnectorCredentialResolver {
  async resolve(integration: IntegrationConfiguration): Promise<ConnectorCredential> {
    throw new ConnectorCredentialUnavailableError(
      `No connector credential resolver is configured, so ${integration.name} cannot be authenticated. `
      + `Wire the customer vault resolver for ${integration.credentialRef ?? 'this integration'} before releasing a write to it.`,
    )
  }
}

export class ConnectorWriteRefusedError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'ConnectorWriteRefusedError'
  }
}

export interface WritePlan {
  method: (typeof ALLOWED_METHODS)[number]
  path: string
  body: string
}

interface WriteOutcome {
  status: number
  bytes: number
  sha256: string
  truncated: boolean
}

export class FirewallExecutor implements ActionExecutor {
  private readonly timeoutMs: number
  private readonly maxResponseBytes: number

  constructor(
    private readonly db: AgentDatabase,
    private readonly credentials: ConnectorCredentialResolver,
    options: { timeoutMs?: number; maxResponseBytes?: number } = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxResponseBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES
  }

  /**
   * A health check is a read that changes nothing. It reports reachability and TLS
   * posture and never claims the endpoint is authenticated, because authenticating
   * would require resolving the customer's credential and this is a test, not a write.
   */
  async test(context: ActionExecutorContext): Promise<{ reachable: boolean; authenticated: boolean; message: string }> {
    let integration: IntegrationConfiguration
    let policy: ConsolePolicy
    try {
      integration = this.integration(context)
      policy = ConsolePolicy.forIntegration(integration, context.config)
    } catch (cause) {
      return { reachable: false, authenticated: false, message: `${this.name(context)} is not writable: ${message(cause)}` }
    }

    try {
      const outcome = await this.send(policy, { method: 'GET' }, undefined, context.signal)
      return {
        reachable: true,
        authenticated: false,
        message: `${integration.name} responded HTTP ${outcome.status} at ${policy.origin} (TLS verification ${policy.verifyTls ? 'on' : 'OFF'}). No write was attempted and no credential was resolved.`,
      }
    } catch (cause) {
      return { reachable: false, authenticated: false, message: `${integration.name} did not respond: ${message(cause)}` }
    }
  }

  async execute(context: ActionExecutorContext): Promise<ActionResult> {
    // Every policy refusal below is terminal. Retrying one would replay the identical
    // request until maxAttempts and fail identically, so only transport faults throw and
    // inherit the worker's lease and backoff.
    let integration: IntegrationConfiguration
    try {
      integration = this.integration(context)
    } catch (cause) {
      return { result: 'failure', message: `Approved action was not sent: ${message(cause)}` }
    }

    const action = context.proposal.action
    if (!FIREWALL_ACTIONS.includes(action as FirewallAction)) {
      return this.refused(integration, `does not support action ${action}; expected one of ${FIREWALL_ACTIONS.join(', ')}`)
    }

    let plan: WritePlan
    let policy: ConsolePolicy
    let target: URL
    try {
      policy = ConsolePolicy.forIntegration(integration, context.config)
      plan = planFirewallWrite(integration, context.job.parameters)
      target = policy.assertAllowed(plan.path)
    } catch (cause) {
      return this.refused(integration, message(cause))
    }

    let credential: ConnectorCredential
    try {
      credential = await this.credentials.resolve(integration, context.signal)
    } catch (cause) {
      return this.refused(integration, message(cause))
    }

    let headers: Record<string, string>
    try {
      headers = this.headers(credential, context)
    } catch (cause) {
      return this.refused(integration, message(cause))
    }

    const outcome = await this.send(policy, plan, headers, context.signal, target)
    const detail = `HTTP ${outcome.status}, response sha256 ${outcome.sha256.slice(0, 16)}, ${outcome.bytes} bytes${outcome.truncated ? ' (truncated at the read limit)' : ''}`

    // A 4xx is the endpoint refusing this request on its own terms; re-sending the
    // identical body will not change the answer. A 5xx is the endpoint failing, so it
    // throws and the worker retries under its backoff.
    if (outcome.status >= 500) throw new Error(`${integration.name} returned ${detail} for approved action ${action}`)
    if (outcome.status >= 400) return { result: 'failure', message: `${integration.name} refused approved action ${action} with ${detail}` }
    if (outcome.status >= 300) {
      return { result: 'failure', message: `${integration.name} answered approved action ${action} with a redirect (${detail}); a write is never followed to another location` }
    }

    return {
      result: 'success',
      message: `Applied approved action ${action} to ${target.toString()} for ${context.job.target} (${detail})`,
    }
  }

  /** Validation problems are completed rather than thrown, so they are not retried. */
  private refused(integration: IntegrationConfiguration, reason: string): ActionResult {
    return { result: 'failure', message: `Approved action ${reason} on ${integration.name}` }
  }

  private plan(context: ActionExecutorContext, integration: IntegrationConfiguration): WritePlan {
    return planFirewallWrite(integration, context.job.parameters)
  }

  private headers(credential: ConnectorCredential, context: ActionExecutorContext): Record<string, string> {
    const headers: Record<string, string> = {
      // The ledger's idempotency key travels as the request key so a replay the worker
      // considers new work is still recognisable to the endpoint as the same write.
      'idempotency-key': context.job.idempotencyKey,
      accept: 'application/json',
    }
    for (const [name, value] of Object.entries(credential.headers ?? {})) {
      const key = name.toLowerCase()
      if (RESERVED_HEADERS.has(key)) {
        throw new ConnectorWriteRefusedError('RESERVED_HEADER', `The credential resolver may not set the ${key} header`)
      }
      if (typeof value !== 'string') {
        throw new ConnectorWriteRefusedError('BAD_CREDENTIAL_HEADER', `The credential resolver returned a non-string value for ${key}`)
      }
      headers[key] = value
    }
    return headers
  }

  private send(policy: ConsolePolicy, request: { method: string; body?: string | undefined }, headers: Record<string, string> | undefined, signal: AbortSignal, target?: URL): Promise<WriteOutcome> {
    const url = target ?? policy.assertAllowed(policy.origin)
    const body = request.method === 'GET' ? undefined : request.body
    const outgoing: Record<string, string> = { ...(headers ?? {}) }
    if (body !== undefined && body !== '') outgoing['content-type'] = 'application/json'

    return new Promise<WriteOutcome>((resolve, reject) => {
      const transport = url.protocol === 'https:' ? httpsRequest : httpRequest
      const controller = new AbortController()
      const abort = () => controller.abort()
      signal.addEventListener('abort', abort, { once: true })
      const timer = setTimeout(() => controller.abort(), this.timeoutMs)
      timer.unref?.()

      const finish = (error: Error | undefined, outcome?: WriteOutcome) => {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        if (error) reject(error)
        else if (outcome) resolve(outcome)
      }

      const client = transport({
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: request.method,
        headers: outgoing,
        // Verification defaults to ON and is only ever relaxed by an operator setting
        // the console policy already validated against the deployment profile.
        rejectUnauthorized: policy.verifyTls,
        ...(policy.ca ? { ca: policy.ca } : {}),
        signal: controller.signal,
      }, (response) => {
        const hash = createHash('sha256')
        let bytes = 0
        let truncated = false
        response.on('data', (chunk: Buffer) => {
          if (bytes >= this.maxResponseBytes) { truncated = true; return }
          const slice = chunk.subarray(0, Math.max(0, this.maxResponseBytes - bytes))
          bytes += slice.byteLength
          hash.update(slice)
          // The body is digested, not retained: a connector response is customer data
          // and may carry material that must not reach an action result or the ledger.
          if (slice.byteLength < chunk.byteLength) truncated = true
        })
        response.on('end', () => finish(undefined, {
          status: response.statusCode ?? 0,
          bytes,
          sha256: hash.digest('hex'),
          truncated,
        }))
        response.on('error', (cause) => finish(cause))
      })

      client.on('error', (cause: Error) => {
        // An abort is either the worker's cancellation or our own timeout; both are
        // transient from the ledger's point of view, so they surface as a thrown error.
        finish(controller.signal.aborted
          ? new Error(`The write to ${url.origin} was aborted after ${this.timeoutMs}ms or cancelled by the worker`)
          : cause)
      })
      client.on('timeout', () => client.destroy(new Error(`The write to ${url.origin} timed out after ${this.timeoutMs}ms`)))

      if (body !== undefined && body !== '') client.write(body)
      client.end()
    })
  }

  /** An integration is only writable when it is active, of this catalog, and controlled-action scoped. */
  private integration(context: ActionExecutorContext): IntegrationConfiguration {
    const integration = this.db.getIntegration(context.proposal.executorIntegrationId)
    if (!integration) {
      throw new ConnectorWriteRefusedError('INTEGRATION_MISSING', `Integration ${context.proposal.executorIntegrationId} was not found`)
    }
    if (integration.catalogId !== FIREWALL_CATALOG_ID) {
      throw new ConnectorWriteRefusedError('WRONG_CATALOG', `This executor is registered for ${FIREWALL_CATALOG_ID}, not ${integration.catalogId}`)
    }
    if (integration.state !== 'active') {
      throw new ConnectorWriteRefusedError('INTEGRATION_INACTIVE', `Approved action requires an active ${FIREWALL_CATALOG_ID} integration, and ${integration.name} is ${integration.state}`)
    }
    // The catalog declares this, but the stored row is what a write actually obeys, so
    // the authority class is re-checked here rather than trusted from the manifest.
    if (integration.authority !== 'controlled_actions') {
      throw new ConnectorWriteRefusedError('NOT_CONTROLLED', `${integration.name} is ${integration.authority}, not controlled_actions; this executor will not write through it`)
    }
    return integration
  }

  private name(context: ActionExecutorContext): string {
    return this.db.getIntegration(context.proposal.executorIntegrationId)?.name ?? 'This integration'
  }
}

/**
 * The single rule set for a controlled write, shared by the propose-time tool and the
 * execute-time executor. Validating in one place is the point: a proposal that the
 * executor would refuse must never reach an operator, and a proposal the tool accepted
 * must not be refused later for a rule that drifted.
 */
export function planFirewallWrite(integration: IntegrationConfiguration, parameters: Record<string, unknown> | undefined): WritePlan {
  const values = (parameters ?? {}) as Record<string, unknown>
  const rawMethod = values['method']
  const method = rawMethod === undefined ? 'POST' : String(rawMethod).toUpperCase()
  if (!ALLOWED_METHODS.includes(method as (typeof ALLOWED_METHODS)[number])) {
    throw new ConnectorWriteRefusedError('METHOD_NOT_ALLOWED', `parameters.method must be one of ${ALLOWED_METHODS.join(', ')}, not ${method}`)
  }

  const path = values['path']
  if (typeof path !== 'string' || !path.trim()) {
    throw new ConnectorWriteRefusedError('PATH_REQUIRED', 'parameters.path is required and must name a path on the registered integration origin')
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(path.trim())) {
    throw new ConnectorWriteRefusedError('ABSOLUTE_PATH_REFUSED', `parameters.path must be relative to the registered origin, not ${path.trim()}`)
  }

  // An operator may narrow the writable surface further than the origin with a
  // prefix. It is a setting, not a proposal field, so the agent cannot widen it.
  const prefix = typeof integration.settings['writePathPrefix'] === 'string' ? String(integration.settings['writePathPrefix']) : '/'
  const pathname = new URL(path.trim(), 'https://placeholder.invalid').pathname
  if (!pathname.startsWith(prefix)) {
    throw new ConnectorWriteRefusedError('PATH_OUTSIDE_PREFIX', `parameters.path ${pathname} is outside the configured writePathPrefix ${prefix}`)
  }

  const rawBody = values['body']
  let body = ''
  if (rawBody !== undefined) {
    if (typeof rawBody !== 'object' || rawBody === null || Array.isArray(rawBody)) {
      throw new ConnectorWriteRefusedError('BODY_NOT_OBJECT', 'parameters.body must be a JSON object when present')
    }
    body = JSON.stringify(rawBody)
    if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) {
      throw new ConnectorWriteRefusedError('BODY_TOO_LARGE', `parameters.body exceeds the ${Math.floor(MAX_REQUEST_BYTES / 1024)} KiB write limit`)
    }
  }

  return { method: method as (typeof ALLOWED_METHODS)[number], path: path.trim(), body }
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
