import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GooseRuntime, type GooseRuntimeOptions } from '@papyrus/goose-runtime'
import type { ServerConfig } from '../src/config.js'
import { AuthService } from '../src/auth.js'
import { PapyrusDatabase } from '../src/db.js'
import { PapyrusService, type RuntimeHandle } from '../src/service.js'

type RuntimeFactory = (options: GooseRuntimeOptions) => RuntimeHandle

export function testContext(runtimeFactory?: RuntimeFactory) {
  const dataDir = mkdtempSync(join(tmpdir(), 'papyrus-test-'))
  const config: ServerConfig = {
    mode: 'local', profile: 'commercial', host: '127.0.0.1', port: 3210, dataDir,
    databasePath: ':memory:', publicOrigin: 'http://127.0.0.1:3210', promptTimeoutMs: 30_000,
    bootstrapSecret: 'correct horse battery staple',
    sessionSecret: 'test-session-secret-that-is-at-least-32-characters', licenseRequired: false, licenseAuthorities: {},
  }
  const db = new PapyrusDatabase(':memory:')
  const service = new PapyrusService(db, config, runtimeFactory ?? ((options) => new GooseRuntime(options)))
  const auth = new AuthService(config, db)
  return { dataDir, config, db, service, auth, dispose: () => { db.close(); rmSync(dataDir, { recursive: true, force: true }) } }
}
