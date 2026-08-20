import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { createGatewayServer } from '../src/gateway.js'
import { testContext } from './helpers.js'

describe('ACP gateway authentication boundary', () => {
  it('rejects development credentials in URL query parameters', async () => {
    const ctx = testContext()
    const devToken = 'gateway-development-token-with-32-characters'
    ctx.config.gateway = { host: '127.0.0.1', port: 3220, devToken }
    const server = createGatewayServer(ctx.config, ctx.service, ctx.auth)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address() as AddressInfo
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/acp?token=${devToken}`)
      expect(response.status).toBe(401)
      expect(response.headers.get('content-type')).toContain('application/json')
      expect(await response.json()).toEqual({
        error: 'authentication_required',
        code: 'UNAUTHENTICATED',
        methods: [],
      })
    } finally {
      server.close()
      await once(server, 'close')
      ctx.dispose()
    }
  })
})
