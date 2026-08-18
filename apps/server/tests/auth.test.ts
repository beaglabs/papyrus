import { createHmac } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import { testContext } from './helpers.js'

function cookieRequest(token: string): IncomingMessage {
  return { headers: { cookie: `papyrus_session=${encodeURIComponent(token)}` } } as unknown as IncomingMessage
}

function base64url(value: string): string {
  return Buffer.from(value).toString('base64url')
}

function sign(ctx: ReturnType<typeof testContext>, body: string): string {
  return createHmac('sha256', ctx.config.sessionSecret).update(body).digest('base64url')
}

describe('session authentication', () => {
  it('authenticates a valid session and rejects a tampered signature', () => {
    const ctx = testContext()
    try {
      const user = ctx.db.upsertUser({ externalId: 'oidc:issuer:sub', displayName: 'Alice', authMethod: 'oidc' })
      const token = ctx.auth.issueSession(user.id)
      expect(ctx.auth.authenticate(cookieRequest(token))?.id).toBe(user.id)
      const [body, signature] = token.split('.')
      const flipped = signature[0] === 'A' ? 'B' : 'A'
      expect(ctx.auth.authenticate(cookieRequest(`${body}.${flipped}${signature.slice(1)}`))).toBeUndefined()
    } finally { ctx.dispose() }
  })

  it('rejects an expired session', () => {
    const ctx = testContext()
    try {
      const user = ctx.db.upsertUser({ externalId: 'oidc:issuer:sub', displayName: 'Alice', authMethod: 'oidc' })
      const body = base64url(JSON.stringify({ userId: user.id, v: 0, exp: Date.now() - 1_000 }))
      expect(ctx.auth.authenticate(cookieRequest(`${body}.${sign(ctx, body)}`))).toBeUndefined()
    } finally { ctx.dispose() }
  })

  it('rejects a session signed with the wrong secret', () => {
    const ctx = testContext()
    try {
      const user = ctx.db.upsertUser({ externalId: 'oidc:issuer:sub', displayName: 'Alice', authMethod: 'oidc' })
      const body = base64url(JSON.stringify({ userId: user.id, v: 0, exp: Date.now() + 60_000 }))
      const wrong = createHmac('sha256', 'a-different-secret-that-is-also-long-enough').update(body).digest('base64url')
      expect(ctx.auth.authenticate(cookieRequest(`${body}.${wrong}`))).toBeUndefined()
    } finally { ctx.dispose() }
  })

  it('revokes outstanding sessions by bumping the token version', () => {
    const ctx = testContext()
    try {
      const user = ctx.db.upsertUser({ externalId: 'oidc:issuer:sub', displayName: 'Alice', authMethod: 'oidc' })
      const token = ctx.auth.issueSession(user.id)
      expect(ctx.auth.authenticate(cookieRequest(token))?.id).toBe(user.id)
      ctx.auth.revokeSessions(user.id)
      expect(ctx.auth.authenticate(cookieRequest(token))).toBeUndefined()
      const fresh = ctx.auth.issueSession(user.id)
      expect(ctx.auth.authenticate(cookieRequest(fresh))?.id).toBe(user.id)
    } finally { ctx.dispose() }
  })

  it('rejects a stale version carried in a forged token', () => {
    const ctx = testContext()
    try {
      const user = ctx.db.upsertUser({ externalId: 'oidc:issuer:sub', displayName: 'Alice', authMethod: 'oidc' })
      ctx.auth.revokeSessions(user.id) // version becomes 1
      const body = base64url(JSON.stringify({ userId: user.id, v: 0, exp: Date.now() + 60_000 }))
      expect(ctx.auth.authenticate(cookieRequest(`${body}.${sign(ctx, body)}`))).toBeUndefined()
    } finally { ctx.dispose() }
  })
})
