import type { AgentDatabase } from '../database.js'
/** SQLite cannot alter a CHECK constraint; rebuild without renaming the old table so child FKs keep their target. */
export function migrateAppLinkType(db:AgentDatabase):void {
  const row=db.sqlite.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_links'").get() as {sql:string}|undefined
  if(!row||row.sql.includes("'app'"))return
  const indexes=db.sqlite.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='agent_links' AND sql IS NOT NULL").all() as {sql:string}[]
  const enabled=Number(db.sqlite.pragma('foreign_keys',{simple:true}))
  db.sqlite.pragma('foreign_keys = OFF')
  try {
    db.sqlite.transaction(()=>{
      db.sqlite.exec(row.sql.replace(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?["`]?agent_links["`]?/i,'CREATE TABLE agent_links_with_apps').replace("'webpage','api','webhook'","'webpage','api','webhook','app'"))
      db.sqlite.exec('INSERT INTO agent_links_with_apps SELECT * FROM agent_links; DROP TABLE agent_links; ALTER TABLE agent_links_with_apps RENAME TO agent_links;')
      for(const index of indexes)db.sqlite.exec(index.sql)
      if((db.sqlite.pragma('foreign_key_check') as unknown[]).length)throw new Error('App Link migration failed foreign-key validation')
    })()
  } finally {db.sqlite.pragma(`foreign_keys = ${enabled ? 'ON' : 'OFF'}`)}
}
