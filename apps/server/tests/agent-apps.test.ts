import { describe, expect, it } from 'vitest'
import { AgentDatabase } from '../src/agent/database.js'
import { AppStore, appFilePath } from '../src/agent/apps/store.js'
import { PolicyStore } from '../src/agent/policies/store.js'
import { LinkStore } from '../src/agent/link-store.js'
import type { PapyrusAgentFSFilesystem } from '../src/agent/mastra/workspace-agentfs.js'
const owner = { oid:'owner', tenantId:'tenant', displayName:'Owner',roles:['Papyrus.System.Owner' as const],groups:[],source:'entra' as const }
describe('durable app authority', () => {
  it('rejects traversal and reserved dependency paths', () => {
    for (const p of ['../secret','/etc/passwd','a/../b','node_modules/x.js','a\\b','a//b']) expect(() => appFilePath(p)).toThrow()
    expect(appFilePath('src/App.tsx')).toBe('src/App.tsx')
  })
  it('publishes only an approved immutable candidate', () => {
    const db = new AgentDatabase(':memory:')
    try {
      const store = new AppStore(db)
      const app = store.create('Intake', owner.oid, 'thread')
      const release = store.candidate(app.id, 'source', '<h1>Hello</h1>')
      expect(store.get(app.id).liveReleaseId).toBeUndefined()
      const id = store.requestPublish(app.id, release.id, owner.oid)
      new PolicyStore(db).approve(id, owner, (kind,resource,version,body) => store.apply(kind,resource,version,body,owner.oid))
      expect(store.get(app.id).liveReleaseId).toBe(release.id)
      expect(() => new PolicyStore(db).approve(id, owner)).toThrow()
    } finally { db.close() }
  })
  it('rejects stale publication approvals', () => {
    const db = new AgentDatabase(':memory:')
    try {
      const store = new AppStore(db), policies = new PolicyStore(db)
      const app = store.create('Intake', owner.oid, 'thread')
      const a = store.candidate(app.id,'one','one'), b=store.candidate(app.id,'two','two')
      const first = store.requestPublish(app.id,a.id,owner.oid), second=store.requestPublish(app.id,b.id,owner.oid)
      const apply=(k:string,r:string,v:number,b:unknown)=>store.apply(k,r,v,b,owner.oid)
      policies.approve(second,owner,apply)
      expect(()=>policies.approve(first,owner,apply)).toThrow(/stale/i)
      expect(store.get(app.id).liveReleaseId).toBe(b.id)
    } finally { db.close() }
  })
  it('registers a published build as an App Link', () => {
    const db = new AgentDatabase(':memory:')
    try {
      new LinkStore(db, {} as PapyrusAgentFSFilesystem)
      const store = new AppStore(db)
      const app = store.create('Intake', owner.oid, 'thread')
      const release = store.candidate(app.id, 'source', '<h1>Hello</h1>')
      const change = store.requestPublish(app.id, release.id, owner.oid)
      new PolicyStore(db).approve(change, owner, (kind, resource, version, body) => store.apply(kind, resource, version, body, owner.oid))
      expect(db.sqlite.prepare('SELECT type,public_path,source_sha256 FROM agent_links WHERE id=?').get(app.id)).toMatchObject({type:'app',public_path:`/a/${app.id}`,source_sha256:release.artifactDigest})
    } finally { db.close() }
  })
})
