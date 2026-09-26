import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PolicyAttachment } from '@papyrus/contracts'
import type { EntraAuthService } from '../entra-auth.js'
import type { AgentService } from '../service.js'
import type { EnhancedMastraRuntime } from '../mastra/enhanced-runtime.js'
import { runWithSessionConnectorScope, requireSessionConnectorBinding } from '../session-connector-access.js'
import { PolicyError, PolicyStore, hash, requireGovernance } from '../policies/store.js'
import { AppStore, appFilePath, requireAppConnector, runWithAppScope } from './store.js'
import { buildApp, readProject, seedProject } from './project.js'

const builds = new Map<string,Promise<string>>()
const edits = new Map<string,Promise<void>>()
function json(response:ServerResponse,status:number,value:unknown):true { response.setHeader('cache-control','no-store');response.setHeader('content-type','application/json');response.writeHead(status);response.end(JSON.stringify(value));return true }
async function body(request:IncomingMessage):Promise<Record<string,unknown>> {
  let size=0;const chunks:Buffer[]=[]
  for await(const c of request){const b=Buffer.from(c);size+=b.length;if(size>2*1024*1024)throw new PolicyError('BODY_TOO_LARGE','Request exceeds 2 MiB',413);chunks.push(b)}
  try {const parsed:unknown=JSON.parse(Buffer.concat(chunks).toString());if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error();return parsed as Record<string,unknown>}catch{throw new PolicyError('INVALID_JSON','Expected JSON object',400)}
}
const text=(v:unknown)=>typeof v==='string'?v:''
const scriptJson=(v:unknown)=>JSON.stringify(v).replace(/</g,'\\u003c')
function html(response:ServerResponse,value:string,csp:string):true {response.setHeader('cache-control','no-store');response.setHeader('content-type','text/html; charset=utf-8');response.setHeader('x-content-type-options','nosniff');response.setHeader('referrer-policy','no-referrer');response.setHeader('content-security-policy',csp);response.writeHead(200);response.end(value);return true}
export function appOrigin(portal:string):string {
  const value=process.env.PAPYRUS_APP_ORIGIN?.trim()
  if(!value)return new URL(portal).origin
  let url:URL
  try{url=new URL(value)}catch{throw new PolicyError('UNSAFE_APP_ORIGIN','PAPYRUS_APP_ORIGIN must be an absolute HTTP(S) origin',503)}
  if((url.protocol!=='https:'&&url.protocol!=='http:')||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new PolicyError('UNSAFE_APP_ORIGIN','PAPYRUS_APP_ORIGIN must be an HTTP(S) origin without a path, query, credentials, or fragment',503)
  return url.origin
}
interface Frame {app_id:string;release_id:string;actor_oid:string;preview:number;expires_at:number;used:number;nonce_hash:string}
export async function handleAppPlane(request:IncomingMessage,response:ServerResponse,url:URL,service:AgentService,auth:EntraAuthService,runtime:EnhancedMastraRuntime):Promise<boolean> {
  const portal=runtime.config.publicOrigin
  let contentOrigin:string|undefined
  try{contentOrigin=appOrigin(portal)}catch{/* Invalid optional configuration is surfaced when an App Link issues a frame. */}
  const isContent=url.pathname==='/app-content'&&url.origin===contentOrigin
  if(url.pathname==='/app-content'&&!isContent)return json(response,403,{error:'App content entry denied'})
  if(!isContent&&!url.pathname.startsWith('/api/apps')&&!url.pathname.startsWith('/api/policies')&&!url.pathname.startsWith('/api/governed-changes')&&!url.pathname.startsWith('/a/'))return false
  const db=service.db,store=new AppStore(db),policies=new PolicyStore(db)
  db.sqlite.exec('CREATE TABLE IF NOT EXISTS app_frames(ticket_hash TEXT PRIMARY KEY,nonce_hash TEXT NOT NULL,app_id TEXT NOT NULL,release_id TEXT NOT NULL,actor_oid TEXT NOT NULL,preview INTEGER NOT NULL,expires_at INTEGER NOT NULL,used INTEGER NOT NULL DEFAULT 0)')
  db.sqlite.prepare('DELETE FROM app_frames WHERE expires_at<?').run(Date.now())
  if(isContent){
    // App HTML may share the portal transport origin, but the iframe remains an opaque
    // sandboxed origin with no direct portal API, cookie, storage, network, or form access.
    if(request.method!=='POST'||request.headers.origin!==portal)return json(response,403,{error:'App content entry denied'})
    let raw='';for await(const c of request){raw+=Buffer.from(c).toString();if(raw.length>4096)throw new PolicyError('BODY_TOO_LARGE','Frame exchange too large',413)}
    const fields=new URLSearchParams(raw),ticket=fields.get('ticket')??'',nonce=fields.get('nonce')??''
    const frame=db.sqlite.prepare('SELECT * FROM app_frames WHERE ticket_hash=?').get(hash(ticket)) as Frame|undefined
    if(!frame||frame.used||frame.expires_at<Date.now()||frame.nonce_hash!==hash(nonce))throw new PolicyError('FRAME_EXPIRED','App frame expired')
    if(!frame.preview&&store.get(frame.app_id).liveReleaseId!==frame.release_id)throw new PolicyError('APP_RELEASE_REVOKED','Release is no longer live')
    policies.assert({appId:frame.app_id,linkId:frame.app_id,actorOid:frame.actor_oid,operation:'app.serve'})
    const consumed=db.sqlite.prepare('UPDATE app_frames SET used=1 WHERE ticket_hash=? AND used=0').run(hash(ticket));if(!consumed.changes)throw new PolicyError('FRAME_EXPIRED','Frame exchange already used')
    const release=store.release(frame.app_id,frame.release_id)
    const bridge=`<script>(()=>{const nonce=${scriptJson(nonce)},origin=${scriptJson(portal)},pending=new Map();window.papyrus={request:(integrationId,operation,input={})=>new Promise((resolve,reject)=>{const id=crypto.randomUUID();const timer=setTimeout(()=>{pending.delete(id);reject(new Error('App request timed out'))},30000);pending.set(id,{resolve,reject,timer});parent.postMessage({papyrusApp:true,nonce,id,integrationId,operation,input},origin)})};window.papyrus.action=(integrationId,action,target,parameters={})=>window.papyrus.request(integrationId,'proposeAction',{action,target,parameters});addEventListener('message',e=>{if(e.source!==parent||e.origin!==origin||e.data?.nonce!==nonce)return;const p=pending.get(e.data.id);if(!p)return;clearTimeout(p.timer);pending.delete(e.data.id);e.data.error?p.reject(new Error(e.data.error)):p.resolve(e.data.result)})})()</script>`
    return html(response,release.html.replace('<body>','<body>'+bridge),`sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors ${portal}`)
  }
  const actor=await auth.authenticate(request)
  if(!actor){if(url.pathname.startsWith('/a/')&&request.method==='GET'){response.writeHead(302,{location:`/api/auth/entra/login?returnTo=${encodeURIComponent(url.pathname)}`});response.end();return true}throw new PolicyError('ENTRA_AUTHENTICATION_REQUIRED','Microsoft Entra authentication required',401)}
  service.requirePortalAccess(actor)
  if(!['GET','HEAD'].includes(request.method??'') && request.headers.origin!==portal)throw new PolicyError('INVALID_ORIGIN','Same-origin request required')
  const issueFrame=(id:string,releaseId:string,preview:boolean)=>{
    const origin=appOrigin(portal),ticket=randomBytes(32).toString('base64url'),nonce=randomBytes(32).toString('base64url')
    store.release(id,releaseId)
    db.sqlite.prepare('INSERT INTO app_frames(ticket_hash,nonce_hash,app_id,release_id,actor_oid,preview,expires_at) VALUES(?,?,?,?,?,?,?)').run(hash(ticket),hash(nonce),id,releaseId,actor.oid,preview?1:0,Date.now()+15*60_000)
    return {url:`${origin}/app-content`,ticket,nonce}
  }
  if(url.pathname.startsWith('/a/')&&request.method==='GET'){
    const app=store.get(url.pathname.slice(3));if(!app.liveReleaseId)throw new PolicyError('APP_NOT_LIVE','App is not published',404)
    policies.assert({appId:app.id,linkId:app.id,actorOid:actor.oid,operation:'app.serve'})
    const frame=issueFrame(app.id,app.liveReleaseId,false)
    return html(response,`<!doctype html><meta charset="utf-8"><title>Hosted app</title><style>body{margin:0}iframe{width:100%;height:100vh;border:0}</style><iframe title="Hosted app" name="app" sandbox="allow-scripts"></iframe><script>const frame=${scriptJson(frame)},appId=${scriptJson(app.id)},iframe=document.querySelector('iframe');const form=document.createElement('form');form.method='POST';form.action=frame.url;form.target='app';for(const key of ['ticket','nonce']){const input=document.createElement('input');input.type='hidden';input.name=key;input.value=frame[key];form.append(input)}document.body.append(form);form.submit();form.remove();addEventListener('message',async e=>{const d=e.data;if(e.source!==iframe.contentWindow||e.origin!=='null'||!d?.papyrusApp||d.nonce!==frame.nonce)return;try{const r=await fetch('/api/apps/'+appId+(d.operation==='proposeAction'?'/actions':'/invoke'),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(d.operation==='proposeAction'?{...d.input,integrationId:d.integrationId,nonce:frame.nonce}:{...d,nonce:frame.nonce})});const v=await r.json();iframe.contentWindow.postMessage({nonce:frame.nonce,id:d.id,...(r.ok?{result:v}:{error:v.error})},'*')}catch{iframe.contentWindow.postMessage({nonce:frame.nonce,id:d.id,error:'App request failed'},'*')}})</script>`,`default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src ${appOrigin(portal)}; form-action ${appOrigin(portal)}; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`)
  }
  if(url.pathname==='/api/policies'&&request.method==='GET')return json(response,200,{policies:policies.list()})
  if(url.pathname==='/api/governed-changes'&&request.method==='GET'){requireGovernance(actor);return json(response,200,{changes:policies.changes().map(c=>({...c,body:JSON.parse(String(c.body))}))})}
  const approve=url.pathname.match(/^\/api\/governed-changes\/([^/]+)\/approve$/)
  if(approve&&request.method==='POST'){policies.approve(approve[1]!,actor,(kind,id,version,data)=>store.apply(kind,id,version,data,actor.oid));return json(response,200,{approved:true})}
  if(url.pathname==='/api/policies'&&request.method==='POST'){requireGovernance(actor);const input=await body(request);return json(response,201,{policy:policies.create(text(input.name),input.rules,input.attachments as PolicyAttachment[],actor.oid)})}
  const policy=url.pathname.match(/^\/api\/policies\/([^/]+)$/)
  if(policy&&request.method==='PUT'){requireGovernance(actor);const input=await body(request);return json(response,200,policies.update(policy[1]!,Number(input.version),input.rules,input.attachments as PolicyAttachment[],actor.oid))}
  if(url.pathname==='/api/apps'&&request.method==='GET')return json(response,200,{apps:store.list(actor.oid)})
  if(url.pathname==='/api/apps'&&request.method==='POST'){
    const input=await body(request)
    if(!actor.roles.includes('Papyrus.System.Owner')&&!actor.roles.includes('Papyrus.Integration.Manage'))throw new PolicyError('APP_AUTHOR_REQUIRED','Integration management is required')
    return runtime.runAs(actor,async()=>{const session=await runtime.createSession(text(input.name));const app=store.create(text(input.name),actor.oid,String(session.id));await seedProject(runtime.workspaceFilesystem,app);return json(response,201,{app})})
  }
  const match=url.pathname.match(/^\/api\/apps\/([^/]+)(?:\/(files|build|frame|publish|grants|invoke|actions))?$/)
  if(!match)return json(response,404,{error:'Not found'})
  const app=store.get(match[1]!),operation=match[2]
  if(operation==='actions'&&request.method==='POST'){
    const input=await body(request),integrationId=text(input.integrationId),action=text(input.action),target=text(input.target)
    if(!integrationId||!action||action.length>256||!target||target.length>1024)throw new PolicyError('INVALID_ACTION','Integration, action, and target required',400)
    const parameters=input.parameters??{}
    if(!parameters||typeof parameters!=='object'||Array.isArray(parameters))throw new PolicyError('INVALID_ACTION','Action parameters must be an object',400)
    const frame=db.sqlite.prepare('SELECT * FROM app_frames WHERE nonce_hash=? AND actor_oid=? AND app_id=? AND used=1').get(hash(text(input.nonce)),actor.oid,app.id) as Frame|undefined
    if(!frame||frame.expires_at<Date.now()||frame.preview||app.liveReleaseId!==frame.release_id)throw new PolicyError('APP_RELEASE_REVOKED','Production app frame required')
    requireAppConnector(db,app.id,integrationId,action,actor.oid,frame.release_id)
    policies.assert({appId:app.id,linkId:app.id,actorOid:actor.oid,executorId:integrationId,connectorId:integrationId,operation:action,target},{proposing:true})
    const integration=db.getIntegration(integrationId)
    if(!integration||!service.executorRegistry?.has(integration.catalogId))throw new PolicyError('EXECUTOR_UNAVAILABLE','Action executor is unavailable')
    if(!service.actions)throw new PolicyError('ACTION_STORE_UNAVAILABLE','Action proposals are unavailable',503)
    const proposal=db.sqlite.transaction(()=>{
      const investigation=service.actions!.createInvestigation({title:`App ${app.name}: ${action}`,trigger:'manual'})
      const created=service.actions!.createProposal({investigationId:investigation.id,proposedByOperatorId:actor.oid,executorIntegrationId:integrationId,action,target,parameters:parameters as Record<string,unknown>,rationaleClaimIds:[],expiresAt:new Date(Date.now()+15*60_000).toISOString()})
      db.sqlite.prepare('INSERT INTO app_action_scopes(proposal_id,app_id,release_id,actor_oid,operation) VALUES(?,?,?,?,?)').run(created.id,app.id,frame.release_id,actor.oid,action)
      return created
    })()
    return json(response,202,{proposal})
  }
  if(operation==='invoke'&&request.method==='POST'){
    const input=await body(request),frame=db.sqlite.prepare('SELECT * FROM app_frames WHERE nonce_hash=? AND actor_oid=? AND app_id=? AND used=1').get(hash(text(input.nonce)),actor.oid,app.id) as Frame|undefined
    if(!frame||frame.expires_at<Date.now())throw new PolicyError('FRAME_EXPIRED','App frame expired')
    const integrationId=text(input.integrationId),toolName=text(input.operation),tool=runtime.appConnectorTools.get(toolName)
    if(!tool)throw new PolicyError('APP_OPERATION_UNAVAILABLE','App operation is unavailable')
    const args=input.input;if(!args||typeof args!=='object'||Array.isArray(args))throw new PolicyError('INVALID_INPUT','Connector input must be an object',400)
    policies.assert({appId:app.id,linkId:app.id,actorOid:actor.oid,connectorId:integrationId,operation:toolName,tool:toolName})
    if(frame.preview){if(app.ownerOid!==actor.oid)throw new PolicyError('APP_OWNER_REQUIRED','App owner required');await runtime.assertActorSession(app.sessionId,actor);requireSessionConnectorBinding(db,integrationId,{sessionId:app.sessionId,actorOid:actor.oid});return json(response,200,await runWithSessionConnectorScope(db,{sessionId:app.sessionId,actorOid:actor.oid},()=>tool(args as Record<string,unknown>)))}
    requireAppConnector(db,app.id,integrationId,toolName,actor.oid,frame.release_id)
    return json(response,200,await runWithAppScope({db,appId:app.id,releaseId:frame.release_id,actorOid:actor.oid,operation:toolName,integrationId},()=>tool(args as Record<string,unknown>)))
  }
  if(app.ownerOid!==actor.oid)throw new PolicyError('APP_OWNER_REQUIRED','Only the author can edit this app')
  await runtime.assertActorSession(app.sessionId,actor)
  policies.assert({appId:app.id,linkId:app.id,sessionId:app.sessionId,actorOid:actor.oid,operation:`app.${operation??'read'}`})
  if(!operation&&request.method==='GET')return json(response,200,{app,grants:store.grants(app.id),policies:policies.list().filter(p=>p.attachments.some(a=>a.scope==='workspace'||a.resourceId===app.id||a.resourceId===app.sessionId))})
  if(operation==='files'&&request.method==='GET')return json(response,200,await readProject(runtime.workspaceFilesystem,app))
  if(operation==='files'&&request.method==='PUT'){
    const input=await body(request)
    const previous=edits.get(app.id)??Promise.resolve()
    const pending=previous.catch(()=>{}).then(async()=>{const snapshot=await readProject(runtime.workspaceFilesystem,app);if(snapshot.revision!==input.revision)throw new PolicyError('REVISION_CONFLICT','Project changed; reload before saving',409);const path=appFilePath(text(input.path));if(typeof input.content!=='string'||Buffer.byteLength(input.content)>512*1024)throw new PolicyError('FILE_TOO_LARGE','File exceeds 512 KiB',413);await runtime.workspaceFilesystem.writeFile(`${app.projectRoot}/${path}`,input.content,{recursive:true})})
    edits.set(app.id,pending);try{await pending}finally{if(edits.get(app.id)===pending)edits.delete(app.id)}
    return json(response,200,await readProject(runtime.workspaceFilesystem,app))
  }
  if(operation==='build'&&request.method==='POST'){
    const snapshot=await readProject(runtime.workspaceFilesystem,app),key=`${app.id}:${snapshot.revision}`
    let task=builds.get(key)
    if(!task){task=buildApp(snapshot.files,runtime.config.dataDir).then(output=>store.candidate(app.id,snapshot.revision,output).id);builds.set(key,task)}
    try{const releaseId=await task;return json(response,200,{releaseId,revision:snapshot.revision})}finally{if(builds.get(key)===task)builds.delete(key)}
  }
  if(operation==='frame'&&request.method==='POST'){const input=await body(request);return json(response,200,issueFrame(app.id,text(input.releaseId),true))}
  if(operation==='publish'&&request.method==='POST'){const input=await body(request);return json(response,202,{changeId:store.requestPublish(app.id,text(input.releaseId),actor.oid)})}
  if(operation==='grants'&&request.method==='POST'){const input=await body(request);return json(response,202,{changeId:store.requestGrant(app.id,text(input.integrationId),input.operations as string[],actor.oid)})}
  if(operation==='grants'&&request.method==='DELETE'){const input=await body(request);store.revoke(app.id,text(input.integrationId),actor.oid);return json(response,200,{revoked:true})}
  return json(response,405,{error:'Method not allowed'})
}