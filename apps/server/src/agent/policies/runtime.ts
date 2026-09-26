import type { AgentDatabase } from '../database.js'
import { currentSessionConnectorScope } from '../session-connector-access.js'
import { AppStore } from '../apps/store.js'
import { PolicyStore } from './store.js'
/** Context identities are derived from the server execution tree, never tool arguments. */
export function assertRuntimePolicy(db:AgentDatabase,context:Record<string,unknown>):void {
  const scope=currentSessionConnectorScope()
  const app=scope ? new AppStore(db).list().find(a=>a.sessionId===scope.sessionId) : undefined
  new PolicyStore(db).assert({...context,sessionId:scope?.sessionId,actorOid:scope?.actorOid,...(app?{appId:app.id,linkId:app.id}:{})})
}
export function modelPolicyProcessor(db:AgentDatabase,agentId:string,modelId:string) {
  return {id:`policy-${agentId}`,name:'Deterministic policy enforcement',async processInputStep(args:{messageList?:unknown}){assertRuntimePolicy(db,{operation:'model.invoke',agentId,modelId});return args.messageList}}
}
