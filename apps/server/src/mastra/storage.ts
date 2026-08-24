import { dirname } from 'node:path'
import { mkdirSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { LibSQLStore } from '@mastra/libsql'

// Mastra's storage lives in a separate SQLite file from Papyrus's
// identity/session tables. This keeps the libsql swap contained: the existing
// `PapyrusDatabase` continues to own Papyrus rows, and Mastra owns its
// threads/messages/memory tables. The two files can be migrated independently.
export function createMastraStorage(databasePath: string): LibSQLStore {
  const target = databasePath === ':memory:' ? ':memory:' : databasePath.replace(/\.db$/, '-mastra.db')
  const url = target === ':memory:' ? ':memory:' : pathToFileURL(target).href
  if (url !== ':memory:') mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
  return new LibSQLStore({ id: 'papyrus-mastra', url })
}