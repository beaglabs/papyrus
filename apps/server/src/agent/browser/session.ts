import { request as httpsRequest } from 'node:https'
import { request as httpRequest } from 'node:http'
import { ConsoleTransportError, type ConsolePolicy } from './policy.js'
import type { CredentialLease } from './credential.js'

/**
 * Minimal HTTP transport for an authenticated device session.
 *
 * `node:https` is used directly rather than global `fetch` for two reasons that
 * both matter against an appliance: TLS verification has to be controllable per
 * integration without mutating process-wide agent state, and Set-Cookie values
 * have to be observed verbatim because a device session is frequently the only
 * thing standing between a page read and a state change.
 */

export interface ConsoleRequest {
  method: 'GET' | 'POST'
  url: string
  /** Header name is lower-cased by the transport before it is sent. */
  headers?: Record<string, string>
  body?: string
}

export interface ConsoleResponse {
  status: number
  url: string
  headers: Record<string, string>
  mediaType: string
  body: string
  /** True when the body was cut off at the read limit. */
  truncated: boolean
}

export interface ConsoleTransportOptions {
  policy: ConsolePolicy
  timeoutMs?: number
  maxBytes?: number
}

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const TIMEOUT_MS = 15_000
const MAX_REDIRECTS = 3

export class ConsoleCookieJar {
  private readonly cookies = new Map<string, string>()

  get size(): number {
    return this.cookies.size
  }

  /**
   * Record response cookies and produce the request header.
   *
   * Cookies are held per host only. Path and attribute scoping is deliberately
   * not implemented: a device console is a single origin, and a jar that sent a
   * session cookie to a path the device never granted would be worse than one
   * that cannot leak outside the origin the policy already pins.
   */
  observe(host: string, values: string[]): void {
    for (const value of values) {
      const [pair] = value.split(';')
      if (!pair) continue
      const equals = pair.indexOf('=')
      if (equals < 1) continue
      const name = pair.slice(0, equals).trim()
      const data = pair.slice(equals + 1).trim()
      if (!name) continue
      if (!data || data === '""') this.cookies.delete(`${host}\u0000${name}`)
      else this.cookies.set(`${host}\u0000${name}`, data)
    }
  }

  /** Name/value pairs for one host, shaped for a cookie jar in another transport. */
  entriesFor(url: string): Array<{ name: string; value: string }> {
    let host: string
    try {
      host = new URL(url).host
    } catch {
      return []
    }
    const prefix = `${host}\u0000`
    const entries: Array<{ name: string; value: string }> = []
    for (const [key, value] of this.cookies) {
      if (key.startsWith(prefix)) entries.push({ name: key.slice(prefix.length), value })
    }
    return entries
  }

  headerFor(url: string): string | undefined {
    let host: string
    try {
      host = new URL(url).host
    } catch {
      return undefined
    }
    const prefix = `${host}\u0000`
    const pairs: string[] = []
    for (const [key, value] of this.cookies) {
      if (key.startsWith(prefix)) pairs.push(`${key.slice(prefix.length)}=${value}`)
    }
    return pairs.length ? pairs.join('; ') : undefined
  }

  clear(): void {
    this.cookies.clear()
  }
}

/**
 * A device session: one origin, one cookie jar, one pinned policy.
 *
 * The session deliberately does not hold a credential. A lease is passed to the one
 * call that needs it and dropped when that call returns, so no object in this
 * boundary carries a device password between requests, nothing that survives into a
 * snapshot can contain one, and a session handed to a reader has no secret to leak.
 */
/**
 * The read-only slice of a session.
 *
 * `DeviceConsoleReader` is typed against this rather than `ConsoleSession`, so a read
 * path cannot post a form or log in even by accident: those methods are not on the
 * type it holds. That is what makes the read/write split in `tools.ts` a structural
 * fact instead of a convention the next edit can break.
 */
export interface ConsoleReadTransport {
  readonly policy: ConsolePolicy
  get(url: string): Promise<ConsoleResponse>
  /**
   * Session cookies the device already handed out, for one URL.
   *
   * Read-only data derived from a response header, and it is what lets a render carry
   * the session the operator already established instead of rendering a login page.
   * It is scoped to the origin the policy pins, so no caller can use it to collect a
   * jar for a host the session was never authorized to speak to.
   */
  cookiesFor(url: string): Array<{ name: string; value: string }>
}

export class ConsoleSession implements ConsoleReadTransport {
  private readonly cookies = new ConsoleCookieJar()
  private loggedIn = false

  constructor(
    readonly id: string,
    readonly integrationId: string,
    readonly policy: ConsolePolicy,
    private readonly options: ConsoleTransportOptions = { policy },
  ) {}

  /** True once a login exchange has run on this jar. Never implies success. */
  get authenticated(): boolean {
    return this.loggedIn
  }

  cookiesFor(url: string): Array<{ name: string; value: string }> {
    // Pinned here as well as at request time: a cookie accessor that trusted its
    // caller to have checked the origin would be the one place credentials could
    // leave for a host the integration was never registered for.
    const target = this.policy.assertAllowed(url)
    return this.cookies.entriesFor(target.toString())
  }

  async get(url: string): Promise<ConsoleResponse> {
    return this.send({ method: 'GET', url }, true)
  }

  /** Post a form body. Called by the executor after approval, never by a tool. */
  async post(url: string, body: string, contentType: string): Promise<ConsoleResponse> {
    return this.send({
      method: 'POST',
      url,
      headers: { 'content-type': contentType },
      body,
    }, false)
  }

  /**
   * Exchange the integration credential for a device session.
   *
   * Login is the one place a secret is sent, so it happens here and nowhere else.
   * The username and password are read from the lease and written straight into
   * the encoded body; the assembled body is never returned, logged, or stored, and
   * the tool layer only ever sees the resulting status.
   */
  async login(credential: CredentialLease, form: { url: string; userField: string; passwordField: string; extraFields?: Record<string, string> }): Promise<ConsoleResponse> {
    if (!credential.secret) throw new ConsoleTransportError('EMPTY_CREDENTIAL', 'The device credential resolved to an empty secret')
    const pairs: Array<[string, string]> = [
      [form.userField, credential.username ?? ''],
      [form.passwordField, credential.secret],
      ...Object.entries(form.extraFields ?? {}),
    ]
    const body = new URLSearchParams(pairs.filter((pair) => pair[0].length > 0)).toString()
    const response = await this.send({ method: 'POST', url: form.url, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body }, false)
    // Only a response that set a cookie counts as a session. A 200 that handed back
    // the login form again would otherwise be reported to the operator as logged in.
    this.loggedIn = this.cookies.size > 0 && response.status < 400
    return response
  }

  private async send(request: ConsoleRequest, follow: boolean, hops = 0): Promise<ConsoleResponse> {
    const target = this.policy.assertAllowed(request.url)
    const response = await this.dispatch(request, target)
    if (follow && [301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers['location']
      if (!location) return response
      if (hops >= MAX_REDIRECTS) throw new ConsoleTransportError('REDIRECT_LIMIT', `Device redirected more than ${MAX_REDIRECTS} times`)
      const next = new URL(location, target).toString()
      // A redirect off the pinned origin is a different trust domain, and the one
      // that matters here is the operator's management network.
      if (this.policy.originOf(next) !== target.origin) {
        throw new ConsoleTransportError('OFF_ORIGIN_REDIRECT', `Device redirected off the integration origin to ${new URL(next).host}`)
      }
      // 303 after a mutation always becomes a GET. Re-following a POST would send
      // the state change twice, which on a firewall is not a retry but a second rule.
      const method = response.status === 303 || (response.status !== 307 && response.status !== 308) ? 'GET' : request.method
      return this.send({ method, url: next, ...(method === 'POST' && request.body ? { body: request.body } : {}) }, follow, hops + 1)
    }
    return response
  }

  private dispatch(request: ConsoleRequest, target: URL): Promise<ConsoleResponse> {
    const jar = this.cookies
    const transport = target.protocol === 'https:' ? httpsRequest : httpRequest
    const headers: Record<string, string> = {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
      'user-agent': 'Papyrus-Agent-Console/1.0',
      ...lowerCaseKeys(request.headers),
    }
    const cookie = jar.headerFor(target.toString())
    if (cookie) headers.cookie = cookie
    if (request.body !== undefined) {
      headers['content-length'] = String(Buffer.byteLength(request.body, 'utf8'))
    }

    return new Promise<ConsoleResponse>((resolve, reject) => {
      const startedAt = Date.now()
      const handle = transport(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port ? Number(target.port) : undefined,
          path: `${target.pathname}${target.search}`,
          method: request.method,
          headers,
          // The per-integration decision, applied exactly where the socket opens.
          rejectUnauthorized: this.policy.verifyTls,
          // An appliance CA is supplied per integration rather than trusted for the
          // whole process, so verifying one device cannot widen what every other
          // outbound connection in this daemon is willing to believe.
          ...(this.policy.ca ? { ca: this.policy.ca } : {}),
          servername: this.policy.serverName(target.hostname),
          timeout: this.options.timeoutMs ?? TIMEOUT_MS,
        },
        (response) => {
          const status = response.statusCode ?? 0
          const flat: Record<string, string> = {}
          const setCookies: string[] = []
          for (const [name, value] of Object.entries(response.headers)) {
            if (value === undefined) continue
            if (name === 'set-cookie') {
              setCookies.push(...(Array.isArray(value) ? value : [value]))
              continue
            }
            flat[name] = Array.isArray(value) ? value.join(', ') : value
          }
          const location = flat['location']
          if (location) {
            try {
              flat['location'] = new URL(location, target).toString()
            } catch {
              // Leave an unparsable location alone; the caller refuses it anyway.
            }
          }
          const host = target.host
          jar.observe(host, setCookies)

          const limit = this.options.maxBytes ?? MAX_RESPONSE_BYTES
          const chunks: Buffer[] = []
          let bytes = 0
          let truncated = false
          response.on('data', (chunk: Buffer) => {
            bytes += chunk.length
            if (bytes <= limit) chunks.push(chunk)
            else if (!truncated) {
              truncated = true
              chunks.push(chunk.subarray(0, Math.max(0, limit - (bytes - chunk.length))))
              response.destroy()
            }
          })
          response.on('error', (cause) => {
            if (!truncated) reject(transportError(cause, target, startedAt))
          })
          response.on('close', () => {
            if (truncated) {
              resolve({ status, url: target.toString(), headers: flat, mediaType: mediaTypeOf(flat), body: concat(chunks), truncated })
            }
          })
          response.on('end', () => {
            resolve({ status, url: target.toString(), headers: flat, mediaType: mediaTypeOf(flat), body: concat(chunks), truncated })
          })
        },
      )
      handle.on('timeout', () => {
        handle.destroy(new Error(`device session timed out after ${this.options.timeoutMs ?? TIMEOUT_MS}ms`))
      })
      handle.on('error', (cause) => reject(transportError(cause, target, startedAt)))
      if (request.body !== undefined) handle.write(request.body)
      handle.end()
    })
  }
}

function transportError(cause: unknown, target: URL, sentAt: number): ConsoleTransportError {
  const message = cause instanceof Error ? cause.message : String(cause)
  const code = /self[- ]signed|self signed|unable to verify|certificate|CERT|ssl/i.test(message)
    ? 'TLS_VERIFICATION_FAILED'
    : /ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|ENOTFOUND|timed out/i.test(message)
      ? 'DEVICE_UNREACHABLE'
      : 'DEVICE_REQUEST_FAILED'
  const hint = code === 'TLS_VERIFICATION_FAILED'
    ? ` The device presented a certificate ${target.hostname} could not verify against the configured trust store. Import the appliance CA through PAPYRUS_TLS_CA, or set tlsVerify=false on this integration only while understanding what that removes.`
    : ''
  return new ConsoleTransportError(code, `${message} (${target.origin}, ${Date.now() - sentAt}ms)${hint}`)
}

function lowerCaseKeys(headers: Record<string, string> | undefined): Record<string, string> {
  if (!headers) return {}
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]))
}

function mediaTypeOf(headers: Record<string, string>): string {
  return headers['content-type']?.split(';')[0]?.trim().toLowerCase() ?? 'application/octet-stream'
}

function concat(chunks: Buffer[]): string {
  return Buffer.concat(chunks).toString('utf8')
}

/** Build a session for an integration, given an already-evaluated policy. */
export function openConsoleSession(policy: ConsolePolicy): ConsoleSession {
  return new ConsoleSession(`console:${policy.integrationId}`, policy.integrationId, policy)
}
