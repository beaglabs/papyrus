import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentRuntime, RuntimeLaunchOptions } from '@papyrus/acp-runtime'
import type { ServerConfig } from '../src/config.js'
import { AuthService } from '../src/auth.js'
import { PapyrusDatabase } from '../src/db.js'
import { PapyrusService } from '../src/service.js'

type RuntimeFactory = (options: RuntimeLaunchOptions) => AgentRuntime

export function testContext(runtimeFactory?: RuntimeFactory) {
  const dataDir = mkdtempSync(join(tmpdir(), 'papyrus-test-'))
  const config: ServerConfig = {
    mode: 'local', profile: 'commercial', host: '127.0.0.1', port: 3210, dataDir,
    databasePath: ':memory:', publicOrigin: 'http://127.0.0.1:3210', branding: { organizationName: 'Test Organization', organizationDomain: 'example.test' }, promptTimeoutMs: 30_000,
    bootstrapSecret: 'correct horse battery staple',
    sessionSecret: 'test-session-secret-that-is-at-least-32-characters', licenseRequired: false, licenseAuthorities: {},
  }
  const db = new PapyrusDatabase(':memory:')
  const service = new PapyrusService(db, config, runtimeFactory)
  const auth = new AuthService(config, db)
  return { dataDir, config, db, service, auth, dispose: () => { db.close(); rmSync(dataDir, { recursive: true, force: true }) } }
}
