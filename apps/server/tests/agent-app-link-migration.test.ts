import { describe,expect,it } from 'vitest'
import { AgentDatabase } from '../src/agent/database.js'
import { LinkStore } from '../src/agent/link-store.js'
import type { PapyrusAgentFSFilesystem } from '../src/agent/mastra/workspace-agentfs.js'
describe('app link migration',()=>{
 it('preserves existing Links and references while allowing app type',()=>{
  const db=new AgentDatabase(':memory:')
  try{
   db.sqlite.exec("CREATE TABLE agent_links(id TEXT PRIMARY KEY,slug TEXT UNIQUE,name TEXT,type TEXT CHECK(type IN ('webpage','api','webhook')),state TEXT,updated_at TEXT)")
   db.sqlite.prepare("INSERT INTO agent_links VALUES('old','old','Old','webpage','live','2026')").run()
   new LinkStore(db,{} as PapyrusAgentFSFilesystem)
   const sql=(db.sqlite.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_links'").get() as {sql:string}).sql
   expect(sql).toContain("'app'")
   expect((db.sqlite.prepare("SELECT type FROM agent_links WHERE id='old'").get() as {type:string}).type).toBe('webpage')
   db.sqlite.prepare("INSERT INTO agent_links(id,slug,name,type,state,updated_at) VALUES('app','app','App','app','live','2026')").run()
   expect(db.sqlite.pragma('foreign_key_check')).toEqual([])
   new LinkStore(db,{} as PapyrusAgentFSFilesystem)
  } finally{db.close()}
 })
})
