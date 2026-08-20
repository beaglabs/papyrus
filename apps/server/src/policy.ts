import { checkParsePolicySet, getCedarVersion, isAuthorized, type CedarValueJson, type EntityJson } from '@cedar-policy/cedar-wasm/nodejs'
import type { Principal } from '@papyrus/contracts'
import { POLICY_VERSION } from './audit.js'
import { BROWSER_POLICY_ACTIONS } from './catalog.js'

export const ACTIONS = [
  'ManageUsers', 'ManageWorkspaces', 'ManageTools', 'AssignResources',
  'CreateSession', 'ReadSession', 'PromptSession', 'CancelSession', 'CloseSession', 'ResumeSession',
  'ReadAudit', 'ReadActivity',
  'ReadWorkspace', 'InvokeTool', 'ActivateLicense',
  ...BROWSER_POLICY_ACTIONS,
] as const
export type PolicyAction = (typeof ACTIONS)[number]

const adminActions = ACTIONS.filter((action) => !['ActivateLicense'].includes(action))
const auditActions: PolicyAction[] = ['ReadAudit', 'ReadActivity', 'ReadSession', 'ReadWorkspace']

function actionExpression(actions: readonly PolicyAction[]): string {
  return actions.map((action) => `action == Action::"${action}"`).join(' || ')
}

export const FIXED_POLICY = `
@id("owner")
permit(principal, action, resource)
when { principal.roles.contains("Owner") };

@id("admin")
permit(principal, action, resource)
when { principal.roles.contains("Admin") && (${actionExpression(adminActions)}) };

@id("auditor")
permit(principal, action, resource)
when { principal.roles.contains("Auditor") && (${actionExpression(auditActions)}) };

@id("assigned-resource")
permit(principal, action, resource)
when {
  principal.roles.contains("User") &&
  (${actionExpression(['ReadWorkspace', 'CreateSession', 'InvokeTool', ...BROWSER_POLICY_ACTIONS])}) &&
  resource has assignedUsers && resource.assignedUsers.contains(principal)
};

@id("session-owner")
permit(principal, action, resource)
when {
  principal.roles.contains("User") &&
  (action == Action::"ReadSession" || action == Action::"PromptSession" ||
   action == Action::"CancelSession" || action == Action::"CloseSession" ||
   action == Action::"ResumeSession") &&
  resource has owner && resource.owner == principal
};

@id("own-activity")
permit(principal, action == Action::"ReadActivity", resource)
when {
  principal.roles.contains("User") && resource has owner && resource.owner == principal
};
`

export interface AuthorizationResource {
  type: 'Deployment' | 'Workspace' | 'Session' | 'Tool' | 'Audit'
  id: string
  attrs?: Record<string, CedarValueJson>
}

export interface AuthorizationDecision {
  allowed: boolean
  reasons: string[]
  errors: string[]
  policyVersion: string
  cedarVersion: string
}

export class PolicyEngine {
  readonly policyVersion = POLICY_VERSION
  readonly cedarVersion = getCedarVersion()

  constructor() {
    const parsed = checkParsePolicySet({ staticPolicies: FIXED_POLICY })
    if (parsed.type === 'failure') throw new Error(`Invalid embedded Cedar policy: ${parsed.errors.map((error) => error.message).join('; ')}`)
  }

  authorize(principal: Principal, action: PolicyAction, resource: AuthorizationResource): AuthorizationDecision {
    const entities: EntityJson[] = [
      {
        uid: { type: 'User', id: principal.id },
        attrs: { roles: principal.roles },
        parents: [],
      },
      {
        uid: { type: resource.type, id: resource.id },
        attrs: resource.attrs ?? {},
        parents: [],
      },
    ]
    const answer = isAuthorized({
      principal: { type: 'User', id: principal.id },
      action: { type: 'Action', id: action },
      resource: { type: resource.type, id: resource.id },
      context: {},
      policies: { staticPolicies: FIXED_POLICY },
      entities,
    })
    if (answer.type === 'failure') {
      return { allowed: false, reasons: [], errors: answer.errors.map((error) => error.message), policyVersion: this.policyVersion, cedarVersion: this.cedarVersion }
    }
    return {
      allowed: answer.response.decision === 'allow',
      reasons: answer.response.diagnostics.reason,
      errors: answer.response.diagnostics.errors.map((error) => error.error.message),
      policyVersion: this.policyVersion,
      cedarVersion: this.cedarVersion,
    }
  }
}

export function cedarUsers(ids: string[]): CedarValueJson[] {
  return ids.map((id) => ({ __entity: { type: 'User', id } }))
}

export function cedarUser(id: string): CedarValueJson {
  return { __entity: { type: 'User', id } }
}
