import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { createPapyrusServer } from '../src/http.js'
import { testContext } from './helpers.js'

async function withServer<T>(run: (origin: string, ctx: ReturnType<typeof testContext>) => Promise<T>): Promise<T> {
  const ctx = testContext()
  const server = createPapyrusServer(ctx.config, ctx.service, ctx.auth)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address() as AddressInfo
  try {
    return await run(`http://127.0.0.1:${address.port}`, ctx)
  } finally {
    server.close()
    await once(server, 'close')
    ctx.dispose()
  }
}

async function withOidcServer<T>(run: (origin: string, ctx: ReturnType<typeof testContext>) => Promise<T>): Promise<T> {
  const ctx = testContext()
  ctx.config.oidc = {
    issuer: 'https://identity.example.test',
    clientId: 'papyrus',
    redirectUri: 'http://127.0.0.1:3210/api/auth/oidc/callback',
  }
  const server = createPapyrusServer(ctx.config, ctx.service, ctx.auth)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address() as AddressInfo
  try {
    return await run(`http://127.0.0.1:${address.port}`, ctx)
  } finally {
    server.close()
    await once(server, 'close')
    ctx.dispose()
  }
}

describe('daemon authentication HTTP contract', () => {
  it('serves the login-capable web shell while keeping APIs unauthenticated', async () => {
    await withOidcServer(async (origin) => {
      const root = await fetch(`${origin}/`)
      expect(root.status).toBe(200)
      expect(root.headers.get('content-type')).toContain('text/html')
      expect(await root.text()).toContain('<div id="root"></div>')

      const api = await fetch(`${origin}/api/me`)
      expect(api.status).toBe(401)
      expect(await api.json()).toMatchObject({ code: 'UNAUTHENTICATED', methods: ['oidc'] })
    })
  })

  it('returns a structured 401 challenge with the OIDC login URL', async () => {
    await withOidcServer(async (origin, ctx) => {
      const response = await fetch(`${origin}/api/me`)
      expect(response.status).toBe(401)
      expect(response.headers.get('www-authenticate')).toBe('Bearer realm="Papyrus"')
      expect(await response.json()).toEqual({
        error: 'authentication_required',
        code: 'UNAUTHENTICATED',
        methods: ['oidc'],
        login_url: 'http://127.0.0.1:3210/api/auth/oidc/start',
        native_start_url: 'http://127.0.0.1:3210/api/auth/oidc/native/start',
      })
    })
  })

  it('returns empty methods when no authentication is configured', async () => {
    await withServer(async (origin) => {
      const response = await fetch(`${origin}/api/me`)
      expect(response.status).toBe(401)
      expect(await response.json()).toMatchObject({ code: 'UNAUTHENTICATED', methods: [] })
    })
  })

  it('accepts and revokes a daemon bearer session', async () => {
    await withServer(async (origin, ctx) => {
      const user = ctx.db.upsertUser({ externalId: 'oidc:issuer:daemon', displayName: 'Daemon User', authMethod: 'oidc' })
      const token = ctx.auth.issueSession(user.id)
      const headers = { authorization: `Bearer ${token}` }

      const me = await fetch(`${origin}/api/me`, { headers })
      expect(me.status).toBe(200)
      expect((await me.json() as { id: string }).id).toBe(user.id)

      const logout = await fetch(`${origin}/api/auth/logout`, { method: 'POST', headers })
      expect(logout.status).toBe(204)
      expect(logout.headers.get('set-cookie')).toContain('Max-Age=0')

      expect((await fetch(`${origin}/api/me`, { headers })).status).toBe(401)
    })
  })

  it('creates user via test helper for session-based auth', async () => {
    await withServer(async (origin, ctx) => {
      const user = ctx.db.upsertUser({ externalId: 'oidc:issuer:testuser', displayName: 'Test User', authMethod: 'oidc' })
      const token = ctx.auth.issueSession(user.id)
      const cookie = `papyrus_session=${encodeURIComponent(token)}`

      const me = await fetch(`${origin}/api/me`, { headers: { cookie } })
      expect(me.status).toBe(200)
      const principal = await me.json() as { id: string; displayName: string }
      expect(principal.id).toBe(user.id)
      expect(principal.displayName).toBe('Test User')

      const logout = await fetch(`${origin}/api/auth/logout`, { method: 'POST', headers: { cookie } })
      expect(logout.status).toBe(204)
      expect((await fetch(`${origin}/api/me`, { headers: { cookie } })).status).toBe(401)
    })
  })
})