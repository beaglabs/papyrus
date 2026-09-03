import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CyberConfig } from '../src/cyber/config.js'
import { ActionStore } from '../src/cyber/action-store.js'
import { CyberDatabase } from '../src/cyber/database.js'
import { INTEGRATION_CATALOG } from '../src/cyber/catalog.js'
import { fetchUrlPreview, UnsafeFetchTargetError } from '../src/cyber/mastra/fetch-preview.js'
import { connectionRequest, pluginToolId } from '../src/cyber/mastra/plugin-tools.js'
import { MastraRuntime } from '../src/cyber/mastra/runtime.js'
import { CyberService } from '../src/cyber/service.js'
import { TerrainStore } from '../src/cyber/terrain-store.js'

describe('Mastra-native product surface', () => {
  const disposers: Array<() => Promise<void> | void> = []
  afterEach(async () => { while (disposers.length) await disposers.pop()?.(); vi.unstubAllGlobals() })

  function config(dataDir: string): CyberConfig {
    return {
      mode: 'local', profile: 'gcc', host: '127.0.0.1', port: 3210, publicOrigin: 'http://127.0.0.1:3210',
      dataDir, databasePath: ':memory:', portalSecret: 'portal-secret-at-least-thirty-two-characters',
      organizationName: 'Example Agency', cloud: 'Public', licenseRequired: false, licenseAuthorities: {},
    }
  }

  function runtime(dataDir: string) {
    const db = new CyberDatabase(':memory:')
    const terrain = new TerrainStore(db)
    const actions = new ActionStore(db)
    const service = new CyberService(db, config(dataDir), terrain, undefined, actions)
    return { db, subject: new MastraRuntime(config(dataDir), actions, terrain, service), service }
  }

  it('generates a secure connection tool and form for every catalog plugin', () => {
    const ids = new Set<string>()
    for (const entry of INTEGRATION_CATALOG) {
      const id = pluginToolId(entry)
      expect(id).toMatch(/^connect_[a-z0-9_]+$/)
      expect(ids.has(id)).toBe(false)
      ids.add(id)
      const request = connectionRequest(entry)
      expect(request.catalogId).toBe(entry.id)
      expect(request.kind).toBe('plugin_connection_request')
      expect(request.fields.some((field) => field.name === 'name')).toBe(true)
      expect(JSON.stringify(request)).not.toMatch(/apiKey|clientSecret|password/i)
    }
  })

  it('rejects SSRF targets before fetch', async () => {
    await expect(fetchUrlPreview('http://169.254.169.254/latest/meta-data')).rejects.toBeInstanceOf(UnsafeFetchTargetError)
    await expect(fetchUrlPreview('https://localhost/admin')).rejects.toBeInstanceOf(UnsafeFetchTargetError)
    await expect(fetchUrlPreview('file:///etc/passwd')).rejects.toBeInstanceOf(UnsafeFetchTargetError)
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

  it('turns an authenticated plugin event into a durable signal session and outbox record', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'papyrus-native-signal-'))
    disposers.push(() => rmSync(dataDir, { recursive: true, force: true }))
    const { db, subject, service } = runtime(dataDir)
    disposers.push(async () => { await subject.stop(); db.close() })
    await subject.start()
    const owner = { oid: 'owner', tenantId: 'tenant', displayName: 'Owner', roles: ['Papyrus.System.Owner'], groups: [], source: 'development' }
    const source = service.createIntegration(owner as never, 'observation-api', { name: 'Webhook source', scope: 'daemon', settings: {} })

    const accepted = await subject.acceptWebhook(source.id, { kind: 'alert', summary: 'A new event arrived' }, { authorization: 'must-not-persist' })
    expect(accepted.sessionId).toBe(`papyrus-signal-${source.id}`)
    expect(subject.signals.get(accepted.signalId)).toMatchObject({ type: 'external_signal', status: 'pending' })
    expect(await subject.listSessions()).toContainEqual(expect.objectContaining({ id: accepted.sessionId, attention: true, kind: 'signal_session' }))
    expect(subject.signals.get(accepted.signalId)?.payload.headers).toEqual({})
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
