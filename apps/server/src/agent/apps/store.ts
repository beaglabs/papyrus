import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import type { AppConnectorGrant, AppRelease, HostedApp } from '@papyrus/contracts'
import type { AgentDatabase } from '../database.js'
import { hash, PolicyError, PolicyStore } from '../policies/store.js'

export function appFilePath(path: string): string {
  if (!/^[a-zA-Z0-9_.@/-]{1,240}$/.test(path) || path.startsWith('/') || path.split('/').some(p => !p || p === '.' || p === '..' || p === 'node_modules' || p.startsWith('.'))) throw new PolicyError('INVALID_APP_PATH','Invalid app project path',400)
  return path
}
export interface AppExecutionScope { db: AgentDatabase; appId: string; releaseId: string; actorOid: string; operation: string; integrationId?: string; approved?: boolean }
const scope = new AsyncLocalStorage<AppExecutionScope>()
export function runWithAppScope<T>(value: AppExecutionScope, operation: () => T): T { return scope.run(value,operation) }
export function currentAppScope(): AppExecutionScope | undefined { return scope.getStore() }
export function requireAppConnector(db: AgentDatabase, appId: string, integrationId: string, operation: string, actorOid: string, releaseId: string, approved = false) {
  const store = new AppStore(db), app = store.get(appId)
  if (app.liveReleaseId !== releaseId) throw new PolicyError('APP_RELEASE_REVOKED','App release is no longer live')
  const integration = db.getIntegration(integrationId)
  if (!integration || integration.state !== 'active') throw new PolicyError('INTEGRATION_NOT_ACTIVE','Integration is not active')
  const grant = store.grants(appId).find(g => g.integrationId === integrationId)
  if (!grant?.operations.includes(operation)) throw new PolicyError('APP_CONNECTOR_NOT_BOUND','Operation is not granted to this app')
  new PolicyStore(db).assert({appId,linkId:appId,actorOid,connectorId:integrationId,operation},{approved})
  return integration
}
export class AppStore {
  constructor(readonly db: AgentDatabase) {
    new PolicyStore(db)
    db.sqlite.exec(`CREATE TABLE IF NOT EXISTS hosted_apps(id TEXT PRIMARY KEY,body TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS app_releases(id TEXT PRIMARY KEY,app_id TEXT NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS app_grants(app_id TEXT NOT NULL,integration_id TEXT NOT NULL,body TEXT NOT NULL,version INTEGER NOT NULL,PRIMARY KEY(app_id,integration_id));
      CREATE TABLE IF NOT EXISTS app_runtime_sessions(token_hash TEXT PRIMARY KEY,app_id TEXT NOT NULL,release_id TEXT NOT NULL,actor_oid TEXT NOT NULL,expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS app_action_scopes(proposal_id TEXT PRIMARY KEY,app_id TEXT NOT NULL,release_id TEXT NOT NULL,actor_oid TEXT NOT NULL,operation TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS app_releases_no_update BEFORE UPDATE ON app_releases BEGIN SELECT RAISE(ABORT,'App releases are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS app_releases_no_delete BEFORE DELETE ON app_releases BEGIN SELECT RAISE(ABORT,'App releases are immutable'); END;`)
  }
  list(owner?: string): HostedApp[] { const all=(this.db.sqlite.prepare('SELECT body FROM hosted_apps').all() as {body:string}[]).map(r=>JSON.parse(r.body) as HostedApp); return owner ? all.filter(a=>a.ownerOid===owner) : all }
  create(name:string,ownerOid:string,sessionId:string): HostedApp {
    if (!name.trim() || name.length > 160 || !ownerOid || !sessionId) throw new PolicyError('INVALID_APP','App name, owner and session required',400)
    const id=randomUUID(), app:HostedApp={id,name:name.trim(),ownerOid,sessionId,projectRoot:`/Library/Apps/${id}`,revision:''}
    this.db.sqlite.prepare('INSERT INTO hosted_apps(id,body) VALUES(?,?)').run(id,JSON.stringify(app)); return app
  }
  get(id:string): HostedApp { const r=this.db.sqlite.prepare('SELECT body FROM hosted_apps WHERE id=?').get(id) as {body:string}|undefined; if (!r) throw new PolicyError('APP_NOT_FOUND','App not found',404); return JSON.parse(r.body) as HostedApp }
  candidate(appId:string,sourceDigest:string,html:string): AppRelease {
    this.get(appId)
    if (Buffer.byteLength(html)>8*1024*1024) throw new PolicyError('APP_TOO_LARGE','App build exceeds 8 MiB',413)
    const release:AppRelease={id:randomUUID(),appId,sourceDigest,artifactDigest:hash(html),html,createdAt:new Date().toISOString()}
    this.db.sqlite.prepare('INSERT INTO app_releases VALUES(?,?,?)').run(release.id,appId,JSON.stringify(release)); return release
  }
  release(appId:string,id:string): AppRelease {
    const r=this.db.sqlite.prepare('SELECT body FROM app_releases WHERE id=? AND app_id=?').get(id,appId) as {body:string}|undefined
    if (!r) throw new PolicyError('RELEASE_NOT_FOUND','Release not found',404)
    const release=JSON.parse(r.body) as AppRelease
    if (hash(release.html)!==release.artifactDigest) throw new PolicyError('RELEASE_TAMPERED','Release artifact digest does not match')
    return release
  }
  grants(appId:string):AppConnectorGrant[] { return (this.db.sqlite.prepare('SELECT body FROM app_grants WHERE app_id=?').all(appId) as {body:string}[]).map(r=>JSON.parse(r.body) as AppConnectorGrant) }
  requestPublish(appId:string,releaseId:string,actor:string):string {
    const release=this.release(appId,releaseId)
    const row=this.db.sqlite.prepare('SELECT version FROM hosted_apps WHERE id=?').get(appId) as {version:number}
    return new PolicyStore(this.db).propose('app-publish',appId,row.version,{releaseId,digest:hash(release),sourceDigest:release.sourceDigest},actor)
  }
  requestGrant(appId:string,integrationId:string,operations:string[],actor:string):string {
    this.get(appId)
    if (!this.db.getIntegration(integrationId) || !Array.isArray(operations) || operations.length>64 || operations.some(s=>typeof s!=='string'||!s||s.length>120||s==='*')) throw new PolicyError('INVALID_APP_GRANT','Choose an integration and explicit operations',400)
    const old=this.grants(appId).find(g=>g.integrationId===integrationId)
    return new PolicyStore(this.db).propose('app-grant',appId,old?.version??0,{integrationId,operations:[...new Set(operations)].sort()},actor)
  }
  revoke(appId:string,integrationId:string,actor:string):void {
    const old=this.grants(appId).find(g=>g.integrationId===integrationId)
    if (old) { const next={...old,operations:[],version:old.version+1,approvedBy:actor}; this.db.sqlite.prepare('UPDATE app_grants SET body=?,version=? WHERE app_id=? AND integration_id=?').run(JSON.stringify(next),next.version,appId,integrationId) }
  }
  apply(kind:string,appId:string,expected:number,body:unknown,actor:string):void {
    const app=this.get(appId), data=body as Record<string,unknown>
    const policies=new PolicyStore(this.db)
    policies.assert({appId,linkId:appId,actorOid:actor,operation:kind},{approved:true})
    if (kind==='app-publish') {
      const release=this.release(appId,String(data.releaseId))
      if (hash(release)!==data.digest) throw new PolicyError('RELEASE_TAMPERED','Approved release digest does not match')
      const result=this.db.sqlite.prepare('UPDATE hosted_apps SET body=?,version=version+1 WHERE id=? AND version=?').run(JSON.stringify({...app,liveReleaseId:release.id}),appId,expected)
      if (!result.changes) throw new PolicyError('STALE_PUBLICATION','Publication approval is stale',409)
      this.db.sqlite.prepare('DELETE FROM app_runtime_sessions WHERE app_id=?').run(appId)
      const table=this.db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_links'").get()
      if(table){const now=new Date().toISOString();this.db.sqlite.prepare(`INSERT INTO agent_links(id,name,slug,type,state,blob_path,media_type,source_sha256,public_path,created_by_oid,created_at,updated_at) VALUES(?,?,?,'app','live',?,'text/html',?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET blob_path=excluded.blob_path,source_sha256=excluded.source_sha256,updated_at=excluded.updated_at,state='live'`).run(appId,app.name,`app-${appId}`,`app-release:${release.id}`,release.artifactDigest,`/a/${appId}`,actor,now,now)}

    } else if (kind==='app-grant') {
      const integrationId=String(data.integrationId), operations=data.operations as string[]
      const integration=this.db.getIntegration(integrationId)
      if (!integration || integration.state!=='active') throw new PolicyError('INTEGRATION_NOT_ACTIVE','Integration must be active')
      const old=this.grants(appId).find(g=>g.integrationId===integrationId)
      if ((old?.version??0)!==expected) throw new PolicyError('STALE_GRANT','Grant approval is stale',409)
      const next:AppConnectorGrant={appId,integrationId,operations,approvedBy:actor,version:expected+1}
      this.db.sqlite.prepare('INSERT INTO app_grants VALUES(?,?,?,?) ON CONFLICT(app_id,integration_id) DO UPDATE SET body=excluded.body,version=excluded.version').run(appId,integrationId,JSON.stringify(next),next.version)
    } else throw new PolicyError('INVALID_CHANGE','Unsupported app change',400)
  }
}
