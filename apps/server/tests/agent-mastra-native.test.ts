import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentConfig } from '../src/agent/config.js'
import { ActionStore } from '../src/agent/action-store.js'
import { AgentDatabase } from '../src/agent/database.js'
import { fetchUrlPreview, htmlMetadata, UnsafeFetchTargetError } from '../src/agent/mastra/fetch-preview.js'
import { modelGatewayRequest } from '../src/agent/mastra/agent-ui-tools.js'
import { MastraRuntime } from '../src/agent/mastra/runtime.js'
import { PapyrusModelGateway } from '../src/agent/model-gateway.js'
import { ModelStore } from '../src/agent/model-store.js'
import { AgentService } from '../src/agent/service.js'
import { TerrainStore } from '../src/agent/terrain-store.js'

describe('Mastra-native product surface', () => {
  const disposers: Array<() => Promise<void> | void> = []
  afterEach(async () => { while (disposers.length) await disposers.pop()?.(); vi.unstubAllGlobals() })

  function config(dataDir: string): AgentConfig {
    return {
      mode: 'local', profile: 'gcc', host: 'localhost', port: 3210, publicOrigin: 'http://localhost:3210',
      dataDir, databasePath: ':memory:', portalSecret: 'portal-secret-at-least-thirty-two-characters',
      organizationName: 'Example Agency', cloud: 'Public', licenseRequired: false, licenseAuthorities: {},
    }
  }

  function runtime(dataDir: string) {
    const db = new AgentDatabase(':memory:')
    const terrain = new TerrainStore(db)
    const actions = new ActionStore(db)
    const service = new AgentService(db, config(dataDir), terrain, undefined, actions)
    return { db, subject: new MastraRuntime(config(dataDir), actions, terrain, service), service }
  }

  it('rejects SSRF targets before fetch', async () => {
    await expect(fetchUrlPreview('http://169.254.169.254/latest/meta-data')).rejects.toBeInstanceOf(UnsafeFetchTargetError)
    await expect(fetchUrlPreview('https://localhost/admin')).rejects.toBeInstanceOf(UnsafeFetchTargetError)
    await expect(fetchUrlPreview('file:///etc/passwd')).rejects.toBeInstanceOf(UnsafeFetchTargetError)
  })

  it('persists model profiles without storing secret material', () => {
    const db = new AgentDatabase(':memory:')
    disposers.push(() => db.close())
    const store = new ModelStore(db)
    const profile = store.create({ name: 'Test gateway', gatewayKind: 'openai-compatible', provider: 'openai', model: 'gpt-test', baseUrl: 'https://inference.example.gov/v1', authScheme: 'credential_ref', credentialRef: 'env://PAPYRUS_TEST_MODEL_KEY', scope: 'test', capabilities: ['chat'] }, 'owner', true)
    expect(profile.isDefault).toBe(true)
    expect(profile).not.toHaveProperty('apiKey')
    expect(store.getDefault()?.id).toBe(profile.id)
    expect(() => store.create({ name: 'Bad gateway', gatewayKind: 'openai-compatible', provider: 'openai', model: 'gpt-test', baseUrl: 'http://inference.example.gov/v1', authScheme: 'none', scope: 'test' }, 'owner')).toThrow('loopback')
  })

  it('resolves an env credential only through the Papyrus gateway', async () => {
    const db = new AgentDatabase(':memory:')
    disposers.push(() => db.close())
    const store = new ModelStore(db)
    const profile = store.create({ name: 'Gateway auth test', gatewayKind: 'openai-compatible', provider: 'openai', model: 'gpt-test', baseUrl: 'https://inference.example.gov/v1', authScheme: 'credential_ref', credentialRef: 'env://PAPYRUS_TEST_MODEL_KEY', scope: 'test' }, 'owner', true)
    process.env.PAPYRUS_TEST_MODEL_KEY = 'not-persisted-secret'
    try {
      const gateway = new PapyrusModelGateway(store)
      expect((await gateway.fetchProviders())[profile.id]).toMatchObject({ url: profile.baseUrl, models: [profile.model] })
      await expect(gateway.resolveAuth({ providerId: profile.id, modelId: profile.model } as never)).resolves.toMatchObject({ apiKey: 'not-persisted-secret', source: 'gateway' })
    } finally { delete process.env.PAPYRUS_TEST_MODEL_KEY }
  })

  it('describes model setup as a secret-free agent form', () => {
    const request = modelGatewayRequest()
    expect(request.kind).toBe('model_gateway_request')
    expect(request.fields.some((field) => field.name === 'baseUrl')).toBe(true)
    expect(JSON.stringify(request)).not.toMatch(/apiKey|clientSecret|password/i)
  })

  it('extracts rich Open Graph preview metadata and resolves relative assets', () => {
    const metadata = htmlMetadata(`
      <html><head>
        <title>Fallback title</title>
        <meta property="og:title" content="Papyrus Runtime">
        <meta content="Customer-hosted agent operations" property="og:description">
        <meta property="og:site_name" content="Beag Labs">
        <meta property="og:type" content="website">
        <meta property="og:image" content="/social/papyrus.png">
        <meta property="og:image:alt" content="Papyrus control plane">
        <link rel="icon" href="/favicon.png">
      </head></html>
    `, new URL('https://www.example.com/products/papyrus'))

    expect(metadata).toEqual({
      title: 'Papyrus Runtime',
      description: 'Customer-hosted agent operations',
      siteName: 'Beag Labs',
      type: 'website',
      image: 'https://www.example.com/social/papyrus.png',
      imageAlt: 'Papyrus control plane',
      favicon: 'https://www.example.com/favicon.png',
    })
  })

  it('bounds URL preview redirects and response text', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://example.com/loop' } }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(fetchUrlPreview('https://example.com/loop', new Set(['example.com']))).rejects.toThrow('exceeded 5 redirects')
    expect(fetchMock).toHaveBeenCalledTimes(6)

    vi.stubGlobal('fetch', vi.fn(async () => new Response('x'.repeat(600_000), { headers: { 'content-type': 'text/plain' } })))
    const preview = await fetchUrlPreview('https://example.com/large', new Set(['example.com']))
    expect(preview.excerpt).toHaveLength(700)
  })

  it('persists session history across daemon runtime restart', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'papyrus-native-session-'))
    disposers.push(() => rmSync(dataDir, { recursive: true, force: true }))
    const first = runtime(dataDir)
    await first.subject.start()
    const created = await first.subject.createSession('Persistent operator task') as { id: string }
    await first.subject.stop(); first.db.close()

    const restarted = runtime(dataDir)
    disposers.push(async () => { await restarted.subject.stop(); restarted.db.close() })
    await restarted.subject.start()
    expect(await restarted.subject.listSessions()).toContainEqual(expect.objectContaining({ id: created.id, title: 'Persistent operator task' }))
  })

  it('keeps schedule operations scoped to the current Agent thread', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'papyrus-agentic-schedule-'))
    disposers.push(() => rmSync(dataDir, { recursive: true, force: true }))
    const { db, subject } = runtime(dataDir)
    disposers.push(async () => { await subject.stop().catch(() => undefined); db.close() })

    const rows = [
      { id: 'schedule-a', resourceId: 'papyrus:gcc:Example Agency', threadId: 'thread-a', name: 'A' },
      { id: 'schedule-b', resourceId: 'papyrus:gcc:Example Agency', threadId: 'thread-b', name: 'B' },
    ]
    const create = vi.fn(async (value: Record<string, unknown>) => ({ id: 'created', ...value }))
    const remove = vi.fn(async () => undefined)
    ;(subject as unknown as { mastra: unknown }).mastra = {
      agent: {},
      instance: {
        schedules: {
          list: vi.fn(async () => rows),
          create,
          get: vi.fn(async (id: string) => rows.find((row) => row.id === id) ?? null),
          delete: remove,
        },
      },
      memory: {
        getThreadById: vi.fn(async ({ threadId }: { threadId: string }) => ({ id: threadId, resourceId: 'papyrus:gcc:Example Agency', metadata: {} })),
      },
    }

    expect(await subject.listSchedules('thread-a')).toEqual([expect.objectContaining({ id: 'schedule-a' })])
    await subject.createSchedule({ name: 'Morning brief', cron: '0 8 * * *', prompt: 'Review signals', timezone: 'UTC', threadId: 'thread-a' })
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      resourceId: 'papyrus:gcc:Example Agency',
      threadId: 'thread-a',
      ifActive: { behavior: 'deliver' },
      metadata: { createdBy: 'papyrus-agent', threadScoped: true },
    }))

    await expect(subject.deleteSchedule('schedule-b', 'thread-a')).rejects.toThrow(/current Agent session/)
    await subject.deleteSchedule('schedule-a', 'thread-a')
    expect(remove).toHaveBeenCalledWith('schedule-a')
  })

  it('runs the deterministic signal workflow without an LLM', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'papyrus-native-workflow-'))
    disposers.push(() => rmSync(dataDir, { recursive: true, force: true }))
    const { db, subject } = runtime(dataDir)
    disposers.push(async () => { await subject.stop(); db.close() })
    await subject.start()
    const result = await subject.runWorkflow('signal-intake', { source: 'smoke', kind: 'test', summary: 'hello', payload: {} }) as { status: string; result?: unknown }
    expect(result.status).toBe('success')
  })
})
