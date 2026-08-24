import { IncomingMessage } from 'node:http'
import { MastraAuthProvider, type MastraAuthRequest } from '@mastra/core/server'
import type { Principal } from '@papyrus/contracts'
import { AuthService } from '../auth.js'

export class PapyrusAuthUser {
  constructor(readonly principal: Principal) {}

  get id(): string { return this.principal.id }
  get displayName(): string { return this.principal.displayName }
  get roles(): readonly string[] { return this.principal.roles }
}

// Bridges Papyrus's existing `AuthService` to the Mastra auth provider
// contract. Mastra's auth pipeline hands us a `MastraAuthRequest` that may be
// either a Web `Request` (already used by its Hono adapter) or a Hono-like
// wrapper. We translate back into an `IncomingMessage`-shaped view by reading
// the headers via the helper Mastra exposes for that purpose.
export class PapyrusMastraAuthProvider extends MastraAuthProvider<PapyrusAuthUser> {
  constructor(private readonly auth: AuthService) {
    super({
      name: 'papyrus',
      authorizeUser: () => true,
      public: ['/api/agents/health', '/api/agents/openapi.json'],
    })
  }

  async authenticateToken(token: string, request: MastraAuthRequest): Promise<PapyrusAuthUser | null> {
    const incoming = request instanceof IncomingMessage
      ? request
      : this.toIncomingMessage(request, token)
    if (!incoming) return null
    const principal = this.auth.authenticate(incoming)
    return principal ? new PapyrusAuthUser(principal) : null
  }

  authorizeUser(_user: PapyrusAuthUser, _request: MastraAuthRequest): boolean {
    return true
  }

  private toIncomingMessage(request: MastraAuthRequest, token: string): IncomingMessage | null {
    const headers: Record<string, string | string[] | undefined> = {}
    if (request instanceof Request) {
      request.headers.forEach((value, key) => {
        const lower = key.toLowerCase()
        const existing = headers[lower]
        if (existing === undefined) headers[lower] = value
        else if (Array.isArray(existing)) headers[lower] = [...existing, value]
        else headers[lower] = [existing, value]
      })
    } else {
      const raw = request.raw?.headers ?? request.headers
      if (raw && typeof (raw as { get?: unknown }).get === 'function') {
        const h = raw as { get(name: string): string | null }
        for (const key of ['authorization', 'x-secret-key', 'cookie', 'x-papyrus-session']) {
          const v = h.get(key); if (v) headers[key] = v
        }
      }
    }
    headers.authorization ??= `Bearer ${token}`
    const synthetic = Object.create(IncomingMessage.prototype) as IncomingMessage
    Object.defineProperty(synthetic, 'headers', { value: headers, enumerable: true })
    Object.defineProperty(synthetic, 'method', { value: 'GET', enumerable: true })
    Object.defineProperty(synthetic, 'url', { value: '/api/agents/me', enumerable: true })
    Object.defineProperty(synthetic, 'socket', { value: { authorized: true, encrypted: false, getPeerX509Certificate: () => undefined } })
    return synthetic
  }
}