import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerConfig } from '../src/config.js'
import { PapyrusDatabase } from '../src/db.js'
import { PapyrusService } from '../src/service.js'

export function testContext() {
  const dataDir = mkdtempSync(join(tmpdir(), 'papyrus-test-'))
  const config: ServerConfig = {
    mode: 'local', profile: 'commercial', host: '127.0.0.1', port: 3210, dataDir,
    databasePath: ':memory:', publicOrigin: 'http://127.0.0.1:3210', bootstrapSecret: 'correct horse battery staple',
    sessionSecret: 'test-session-secret-that-is-at-least-32-characters', licenseRequired: false, licenseAuthorities: {},
  }
  const db = new PapyrusDatabase(':memory:')
  const service = new PapyrusService(db, config)
  return { dataDir, config, db, service, dispose: () => { db.close(); rmSync(dataDir, { recursive: true, force: true }) } }
}
