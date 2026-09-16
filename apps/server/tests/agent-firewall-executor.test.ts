import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { IntegrationConfiguration } from '@papyrus/contracts'
import { AgentDatabase } from '../src/agent/database.js'
import type { AgentConfig } from '../src/agent/config.js'
import type { ActionExecutorContext } from '../src/agent/action-worker.js'
import {
  FIREWALL_ACTIONS,
  FirewallExecutor,
  UnconfiguredConnectorCredentialResolver,
  planFirewallWrite,
  type ConnectorCredential,
  type ConnectorCredentialResolver,
} from '../src/agent/executors/firewall-executor.js'

/**
 * A stand-in policy endpoint. It records every request it receives so a test can assert
 * exactly what left the daemon, and it can be told to answer with a status and body so
 * the response classes (2xx, 3xx, 4xx, 5xx) are exercised without a live firewall.
 */
interface Received {
  method: string
  url: string
  headers: Record<string, string>
  body: string
}

let endpoint: Server
let origin = ''
const received: Received[] = []
// A response body that must never reach an action result: it stands in for connector
// output the daemon is not allowed to echo into the ledger or into chat.
const SECRET_BODY = '{"token":"do-not-leak-into-the-result"}'
let reply: { status: number; body: string; headers?: Record<string, string> } = { status: 200, body: SECRET_BODY }

beforeAll(async () => {
  endpoint = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      received.push({
        method: request.method ?? '',
        url: request.url ?? '',
        headers: Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : String(value ?? '')])),
        body: Buffer.concat(chunks).toString('utf8'),
      })
      response.writeHead(reply.status, { 'content-type': 'application/json', ...(reply.headers ?? {}) })
      response.end(reply.body)
    })
  })
  await new Promise<void>((resolve) => endpoint.listen(0, '127.0.0.1', resolve))
  const address = endpoint.address() as AddressInfo
  origin = `http://127.0.0.1:${address.port}`
})

afterAll(async () => { await new Promise<void>((resolve) => endpoint.close(() => resolve())) })

// Reset both the recorded traffic and the canned reply, so a mutation in one test cannot
// look like an executor bug in the next.
afterEach(() => { received.length = 0; reply = { status: 200, body: SECRET_BODY } })

function seedIntegration(db: AgentDatabase, integration: IntegrationConfiguration): IntegrationConfiguration {
  db.sqlite.prepare(`INSERT INTO agent_integrations(
    id,catalog_id,name,integration_class,authority,risk,state,endpoint,scope,credential_ref,settings_json,health,created_by_oid,created_at,updated_at,version
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    integration.id, integration.catalogId, integration.name, integration.integrationClass,
    integration.authority, integration.risk, integration.state, integration.endpoint ?? null, integration.scope,
    integration.credentialRef ?? null, JSON.stringify(integration.settings), integration.health,
    integration.createdByOid, integration.createdAt, integration.updatedAt, integration.version,
  )
  return integration
}

function configFor(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return { profile: 'commercial', dataDir: '/tmp', tls: {}, ...overrides } as unknown as AgentConfig
}

function integrationFor(overrides: Partial<IntegrationConfiguration> = {}): IntegrationConfiguration {
  return {
    id: 'intl-edge-fw',
    catalogId: 'firewall-executor',
    name: 'Edge policy endpoint',
    integrationClass: 'action_executor',
    authority: 'controlled_actions',
    risk: 'critical',
    state: 'active',
    endpoint: origin,
    scope: 'edge',
    credentialRef: 'vault://edge/readwrite',
    settings: {},
    health: 'unknown',
    createdByOid: 'oid',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    version: 1,
    ...overrides,
  }
}

interface ContextOptions {
  action?: string
  target?: string
  parameters?: Record<string, unknown>
  idempotencyKey?: string
}

function contextFor(integration: IntegrationConfiguration, options: ContextOptions = {}): ActionExecutorContext {
  const action = options.action ?? 'block_route'
  return {
    job: {
      id: 'job-1',
      proposalId: 'prop-1',
      executorIntegrationId: integration.id,
      action,
      target: options.target ?? '10.20.30.0/24',
      parameters: options.parameters ?? { path: '/api/rules', body: { deny: true } },
      idempotencyKey: options.idempotencyKey ?? 'idem-abc123',
    } as never,
    proposal: { executorIntegrationId: integration.id, action } as never,
    config: configFor(),
    signal: new AbortController().signal,
  }
}

/** A resolver that hands back one header, standing in for a customer vault. */
const stubCredentials: ConnectorCredentialResolver = {
  resolve: async (): Promise<ConnectorCredential> => ({ headers: { Authorization: 'Bearer customer-token' } }),
}

describe('controlled write planning', () => {
  const integration = integrationFor()

  it('defaults to POST and accepts a relative path on the registered origin', () => {
    expect(planFirewallWrite(integration, { path: '/api/rules' })).toEqual({ method: 'POST', path: '/api/rules', body: '' })
  })

  it('refuses a method that is not a write', () => {
    expect(() => planFirewallWrite(integration, { path: '/api/rules', method: 'GET' })).toThrow(/must be one of POST, PUT, PATCH/)
    expect(() => planFirewallWrite(integration, { path: '/api/rules', method: 'DELETE' })).toThrow(/must be one of/)
  })

  it('requires a path and refuses one that names another origin', () => {
    expect(() => planFirewallWrite(integration, {})).toThrow(/parameters\.path is required/)
    expect(() => planFirewallWrite(integration, { path: 'https://attacker.example/rules' })).toThrow(/must be relative to the registered origin/)
  })

  it('honours the operator write prefix and cannot be widened by the proposal', () => {
    const narrowed = integrationFor({ settings: { writePathPrefix: '/api/v2/rules' } })
    expect(planFirewallWrite(narrowed, { path: '/api/v2/rules/inbound' }).path).toBe('/api/v2/rules/inbound')
    expect(() => planFirewallWrite(narrowed, { path: '/api/rules' })).toThrow(/outside the configured writePathPrefix/)
  })

  it('accepts only a JSON object body', () => {
    expect(planFirewallWrite(integration, { path: '/api/rules', body: { deny: true } }).body).toBe('{"deny":true}')
    expect(() => planFirewallWrite(integration, { path: '/api/rules', body: 'deny=true' })).toThrow(/must be a JSON object/)
    expect(() => planFirewallWrite(integration, { path: '/api/rules', body: [1, 2] })).toThrow(/must be a JSON object/)
  })

  it('exposes a fixed action vocabulary', () => {
    expect([...FIREWALL_ACTIONS]).toEqual(['block_route', 'quarantine_segment', 'revoke_temporary_rule'])
  })
})

describe('controlled write executor', () => {
  it('sends one origin-pinned write with the ledger idempotency key and never echoes the response', async () => {
    const db = new AgentDatabase(':memory:')
    const integration = seedIntegration(db, integrationFor())
    const executor = new FirewallExecutor(db, stubCredentials)

    const result = await executor.execute(contextFor(integration))

    expect(result).toMatchObject({ result: 'success' })
    // The response body carries material the daemon must not reproduce anywhere.
    expect(result.message).not.toContain('do-not-leak-into-the-result')
    expect(result.message).toMatch(/response sha256 [0-9a-f]{16}/)

    expect(received).toHaveLength(1)
    const request = received[0]!
    expect(request.method).toBe('POST')
    expect(request.url).toBe('/api/rules')
    expect(request.headers['idempotency-key']).toBe('idem-abc123')
    expect(request.headers['authorization']).toBe('Bearer customer-token')
    expect(request.headers['content-type']).toBe('application/json')
    expect(JSON.parse(request.body)).toEqual({ deny: true })
    db.close()
  })

  it('completes a refused request instead of retrying it', async () => {
    const db = new AgentDatabase(':memory:')
    const integration = seedIntegration(db, integrationFor())
    const executor = new FirewallExecutor(db, stubCredentials)
    reply = { status: 404, body: '{"error":"no such rule endpoint"}' }

    const result = await executor.execute(contextFor(integration))

    expect(result.result).toBe('failure')
    expect(result.message).toMatch(/HTTP 404/)
    expect(received).toHaveLength(1)
    db.close()
  })

  it('never follows a redirect away from an approved write', async () => {
    const db = new AgentDatabase(':memory:')
    const integration = seedIntegration(db, integrationFor())
    const executor = new FirewallExecutor(db, stubCredentials)
    reply = { status: 302, body: '', headers: { location: 'https://attacker.example/collect' } }

    const result = await executor.execute(contextFor(integration))

    expect(result.result).toBe('failure')
    expect(result.message).toMatch(/redirect/)
    // Exactly one request: the redirect target was not chased.
    expect(received).toHaveLength(1)
    db.close()
  })

  it('throws on a server fault so the worker retries under its backoff', async () => {
    const db = new AgentDatabase(':memory:')
    const integration = seedIntegration(db, integrationFor())
    const executor = new FirewallExecutor(db, stubCredentials)
    reply = { status: 503, body: '{"error":"try later"}' }

    await expect(executor.execute(contextFor(integration))).rejects.toThrow(/HTTP 503/)
    db.close()
  })

  it('sends nothing when the credential boundary is unconfigured', async () => {
    const db = new AgentDatabase(':memory:')
    const integration = seedIntegration(db, integrationFor())
    const executor = new FirewallExecutor(db, new UnconfiguredConnectorCredentialResolver())

    const result = await executor.execute(contextFor(integration))

    expect(result.result).toBe('failure')
    expect(result.message).toMatch(/credential resolver/i)
    expect(received).toHaveLength(0)
    db.close()
  })

  it('refuses credential headers that would displace the executor’s own', async () => {
    const db = new AgentDatabase(':memory:')
    const integration = seedIntegration(db, integrationFor())
    const executor = new FirewallExecutor(db, { resolve: async () => ({ headers: { 'idempotency-key': 'attacker-chosen' } }) })

    const result = await executor.execute(contextFor(integration))

    expect(result.result).toBe('failure')
    expect(result.message).toMatch(/may not set the idempotency-key header/)
    expect(received).toHaveLength(0)
    db.close()
  })

  it('refuses an integration that is inactive, mis-scoped, or of another catalog', async () => {
    const cases: Array<[Partial<IntegrationConfiguration>, RegExp]> = [
      [{ state: 'disabled' }, /is disabled/],
      [{ authority: 'read_only' }, /not controlled_actions/],
      [{ catalogId: 'appliance-console' }, /registered for firewall-executor/],
    ]
    for (const [overrides, expected] of cases) {
      const db = new AgentDatabase(':memory:')
      const integration = seedIntegration(db, integrationFor(overrides))
      const executor = new FirewallExecutor(db, stubCredentials)

      const result = await executor.execute(contextFor(integration))

      expect(result.result, JSON.stringify(overrides)).toBe('failure')
      expect(result.message).toMatch(expected)
      db.close()
    }
    // None of the three ever reached the network.
    expect(received).toHaveLength(0)
  })

  it('refuses an action outside the vocabulary', async () => {
    const db = new AgentDatabase(':memory:')
    const integration = seedIntegration(db, integrationFor())
    const executor = new FirewallExecutor(db, stubCredentials)

    const result = await executor.execute(contextFor(integration, { action: 'factory_reset' }))

    expect(result.result).toBe('failure')
    expect(result.message).toMatch(/does not support action factory_reset/)
    expect(received).toHaveLength(0)
    db.close()
  })

  it('refuses plaintext and credential-bearing endpoints on a government profile', async () => {
    const db = new AgentDatabase(':memory:')
    const integration = seedIntegration(db, integrationFor())
    const executor = new FirewallExecutor(db, stubCredentials)

    const plaintext = await executor.execute({
      ...contextFor(integration),
      config: configFor({ profile: 'government-il4' }),
    })
    expect(plaintext.result).toBe('failure')
    expect(plaintext.message).toMatch(/Plain http/)

    const smuggled = seedIntegration(db, integrationFor({ id: 'intl-smuggled', endpoint: origin.replace('http://', 'http://user:pass@') }))
    const credentialInUrl = await executor.execute(contextFor(smuggled))
    expect(credentialInUrl.result).toBe('failure')
    expect(credentialInUrl.message).toMatch(/must not carry credentials/)
    expect(received).toHaveLength(0)
    db.close()
  })
})

describe('controlled write health test', () => {
  it('reports reachability without claiming it authenticated or wrote anything', async () => {
    const db = new AgentDatabase(':memory:')
    const integration = seedIntegration(db, integrationFor())
    const executor = new FirewallExecutor(db, new UnconfiguredConnectorCredentialResolver())

    const result = await executor.test(contextFor(integration))

    expect(result.reachable).toBe(true)
    expect(result.authenticated).toBe(false)
    expect(result.message).toMatch(/No write was attempted and no credential was resolved/)
    expect(received.every((request) => request.method === 'GET')).toBe(true)
    db.close()
  })

  it('reports an unreachable endpoint instead of throwing', async () => {
    const db = new AgentDatabase(':memory:')
    const integration = seedIntegration(db, integrationFor({ endpoint: 'http://127.0.0.1:1' }))
    const executor = new FirewallExecutor(db, stubCredentials)

    const result = await executor.test(contextFor(integration))

    expect(result.reachable).toBe(false)
    expect(result.authenticated).toBe(false)
    db.close()
  })

  it('reports a configuration refusal without resolving a credential', async () => {
    const db = new AgentDatabase(':memory:')
    const integration = seedIntegration(db, integrationFor({ endpoint: undefined }))
    const executor = new FirewallExecutor(db, stubCredentials)

    const result = await executor.test(contextFor(integration))

    expect(result.reachable).toBe(false)
    expect(result.message).toMatch(/no endpoint/)
    db.close()
  })
})
