import { describe,expect,it,afterEach } from 'vitest'
import { Readable } from 'node:stream'
import type { IncomingMessage,ServerResponse } from 'node:http'
import { AgentDatabase } from '../src/agent/database.js'
import { AppStore } from '../src/agent/apps/store.js'
import { PolicyStore } from '../src/agent/policies/store.js'
import { handleAppPlane } from '../src/agent/apps/http.js'
import type { EntraAuthService } from '../src/agent/entra-auth.js'
import type { AgentService } from '../src/agent/service.js'
import type { EnhancedMastraRuntime } from '../src/agent/mastra/enhanced-runtime.js'
const actor={oid:'owner',tenantId:'tenant',displayName:'Owner',roles:['Papyrus.System.Owner' as const],groups:[],source:'entra' as const}
const portal='https://portal.example.test', appOrigin='https://apps.example.test'
function request(method:string,origin:string,path:string,payload='',headers:Record<string,string>={}){const req=Readable.from(payload?[Buffer.from(payload)]:[]) as IncomingMessage;req.method=method;req.url=path;req.headers={origin,...headers};return req}
function response(){let status=0,body='';const headers:Record<string,string>={};const res={setHeader:(k:string,v:string)=>{headers[k.toLowerCase()]=v},writeHead:(code:number)=>{status=code},end:(v?:string)=>{body=v??''}} as ServerResponse;return{res,get status(){return status},get body(){return body},headers}}
afterEach(()=>{delete process.env.PAPYRUS_APP_ORIGIN})
describe('hosted app authentication boundary',()=>{
 it('requires a one-use portal-issued ticket on the separate content origin',async()=>{
  process.env.PAPYRUS_APP_ORIGIN=appOrigin
  const db=new AgentDatabase(':memory:'),apps=new AppStore(db),policies=new PolicyStore(db)
  try{
   const app=apps.create('Intake','owner','thread'),release=apps.candidate(app.id,'source','<!doctype html><html><body><main>Visible</main></body></html>')
   policies.approve(apps.requestPublish(app.id,release.id,'owner'),actor,(k,r,v,b)=>apps.apply(k,r,v,b,'owner'))
   const service={db,requirePortalAccess:()=>{}} as unknown as AgentService
   const auth={authenticate:async()=>actor} as unknown as EntraAuthService
   const runtime={config:{publicOrigin:portal}} as unknown as EnhancedMastraRuntime
   const shell=response();await handleAppPlane(request('GET',portal,`/a/${app.id}`),shell.res,new URL(`${portal}/a/${app.id}`),service,auth,runtime)
   expect(shell.status).toBe(200)
   const frame=JSON.parse(shell.body.match(/const frame=(\{.*?\}),appId=/)?.[1]??'{}') as {ticket:string;nonce:string}
   expect(frame.ticket).toBeTruthy()
   const content=response(),payload=new URLSearchParams({ticket:frame.ticket,nonce:frame.nonce}).toString()
   await handleAppPlane(request('POST',portal,'/app-content',payload),content.res,new URL(`${appOrigin}/app-content`),service,auth,runtime)
   expect(content.status).toBe(200);expect(content.body).toContain('Visible');expect(content.headers['content-security-policy']).toContain('sandbox allow-scripts')
   await expect(handleAppPlane(request('POST',portal,'/app-content',payload),response().res,new URL(`${appOrigin}/app-content`),service,auth,runtime)).rejects.toThrow(/expired/)
   const direct=response();await handleAppPlane(request('GET',appOrigin,'/app-content'),direct.res,new URL(`${appOrigin}/app-content`),service,auth,runtime)
   expect(direct.status).toBe(403)
  }finally{db.close()}
 })
 it('redirects anonymous users to inherited Entra sign in',async()=>{
  const db=new AgentDatabase(':memory:')
  try{const service={db,requirePortalAccess:()=>{}} as unknown as AgentService,auth={authenticate:async()=>undefined} as unknown as EntraAuthService,runtime={config:{publicOrigin:portal}} as unknown as EnhancedMastraRuntime,res=response();await handleAppPlane(request('GET',portal,'/a/00000000-0000-0000-0000-000000000000'),res.res,new URL(`${portal}/a/00000000-0000-0000-0000-000000000000`),service,auth,runtime);expect(res.status).toBe(302)}finally{db.close()}
 })
})
