import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PapyrusDatabase } from './db.js'
import { ApprovedSourceStore } from './approved-sources.js'

test('approved source retrieval follows live identity assignments', () => {
  const db=new PapyrusDatabase(':memory:')
  try {
    const now=new Date().toISOString()
    db.sqlite.prepare('INSERT INTO users(id,external_id,display_name,email,picture_url,auth_method,token_version,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run('user-a','subject-a','Alice','alice@example.test',null,'oidc',0,now)
    db.sqlite.prepare('INSERT INTO users(id,external_id,display_name,email,picture_url,auth_method,token_version,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run('user-b','subject-b','Bob','bob@example.test',null,'oidc',0,now)
    const store=new ApprovedSourceStore(db)
    const source=store.create('Policy library','upload','upload://policy','snapshot')
    store.ingest(source.id,'upload://policy/access.md','Access policy','text/markdown','Mission records require approved identity access.')
    store.assign(source.id,'user-a')
    assert.equal(store.search('user-a','approved identity').length,1)
    assert.equal(store.search('user-b','approved identity').length,0)
    store.unassign(source.id,'user-a')
    assert.equal(store.search('user-a','approved identity').length,0)
  } finally { db.close() }
})

test('citations retain source, URI, location, and content hash', () => {
  const db=new PapyrusDatabase(':memory:')
  try {
    const now=new Date().toISOString()
    db.sqlite.prepare('INSERT INTO users(id,external_id,display_name,email,picture_url,auth_method,token_version,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run('user-a','subject-a','Alice',null,null,'mtls',0,now)
    const store=new ApprovedSourceStore(db)
    const source=store.create('Runbooks','api','https://runbooks.example.test','snapshot')
    store.assign(source.id,'user-a')
    store.ingest(source.id,'https://runbooks.example.test/restore','Restore service','text/plain','Restore the service from the signed offline package.')
    const [result]=store.search('user-a','signed offline')
    assert.ok(result)
    assert.equal(result.citation.sourceId,source.id)
    assert.equal(result.citation.uri,'https://runbooks.example.test/restore')
    assert.match(result.citation.sha256,/^[0-9a-f]{64}$/)
    assert.ok(result.citation.location)
  } finally { db.close() }
})
