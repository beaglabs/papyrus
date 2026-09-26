import type { PolicyDecision, PolicyRule } from '@papyrus/contracts'
const fields = new Set(['operation', 'tool', 'actorOid', 'appId', 'sessionId', 'connectorId', 'executorId', 'skillId', 'agentId', 'modelId', 'linkId', 'target', 'amount'])
export function validateRules(value: unknown): PolicyRule[] {
  if (!Array.isArray(value) || value.length > 128) throw new Error('Policies require at most 128 rules')
  return value.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid policy rule')
    const r = raw as Record<string, unknown>
    const keys = r.kind === 'approval' ? ['kind'] : r.kind === 'limit' ? ['kind', 'field', 'maximum'] : ['kind', 'field', 'values']
    if (Object.keys(r).some(k => !keys.includes(k))) throw new Error('Unknown policy rule field')
    if (r.kind === 'approval') return { kind: 'approval' }
    if (typeof r.field !== 'string' || !fields.has(r.field)) throw new Error('Unknown policy context field')
    if (r.kind === 'limit' && typeof r.maximum === 'number' && Number.isFinite(r.maximum) && r.maximum >= 0) return { kind: 'limit', field: r.field, maximum: r.maximum }
    if ((r.kind === 'allow' || r.kind === 'deny') && Array.isArray(r.values) && r.values.length <= 256 && r.values.every(v => typeof v === 'string' && v.length <= 1024)) return { kind: r.kind, field: r.field, values: [...new Set(r.values as string[])].sort() }
    throw new Error('Invalid policy rule')
  })
}
export function evaluatePolicies(rules: readonly PolicyRule[], context: Record<string, unknown>): PolicyDecision {
  const reasons: string[] = []
  let approvalRequired = false
  for (const rule of validateRules(rules)) {
    if (rule.kind === 'approval') { approvalRequired = true; continue }
    const value = context[rule.field]
    if (value === undefined || value === null) { reasons.push(`MISSING_CONTEXT:${rule.field}`); continue }
    if (rule.kind === 'limit') {
      if (typeof value !== 'number' || !Number.isFinite(value) || value > rule.maximum) reasons.push(`LIMIT:${rule.field}`)
    } else if (typeof value !== 'string' || (rule.kind === 'allow' ? !rule.values.includes(value) : rule.values.includes(value))) reasons.push(`${rule.kind.toUpperCase()}:${rule.field}`)
  }
  return { allowed: reasons.length === 0, approvalRequired, reasons: [...new Set(reasons)].sort() }
}
export function isStrengthening(before: readonly PolicyRule[], after: readonly PolicyRule[]): boolean {
  const old = validateRules(before), next = validateRules(after)
  return old.every(a => next.some(b => {
    if (a.kind === 'approval') return b.kind === 'approval'
    if (b.kind === 'approval' || a.kind !== b.kind || a.field !== b.field) return false
    if (a.kind === 'limit' && b.kind === 'limit') return b.maximum <= a.maximum
    if (a.kind === 'allow' && b.kind === 'allow') return b.values.every(v => a.values.includes(v))
    if (a.kind === 'deny' && b.kind === 'deny') return a.values.every(v => b.values.includes(v))
    return false
  }))
}
