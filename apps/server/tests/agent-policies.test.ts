import { describe, expect, it } from 'vitest'
import { evaluatePolicies, isStrengthening, validateRules } from '../src/agent/policies/evaluator.js'

describe('deterministic restrictive policies', () => {
  it('intersects allow lists and makes deny win', () => {
    const rules = [{ kind: 'allow', field: 'operation', values: ['read', 'write'] }, { kind: 'deny', field: 'operation', values: ['write'] }] as const
    expect(evaluatePolicies(rules, { operation: 'write' }).allowed).toBe(false)
    expect(evaluatePolicies(rules, { operation: 'read' }).allowed).toBe(true)
    expect(evaluatePolicies(rules, { operation: 'delete' }).allowed).toBe(false)
  })
  it('fails closed for missing context and invalid rules', () => {
    expect(evaluatePolicies([{ kind: 'limit', field: 'amount', maximum: 10 }], {}).allowed).toBe(false)
    expect(() => validateRules([{ kind: 'script', code: 'return true' }])).toThrow()
    expect(() => validateRules([{ kind: 'limit', field: 'amount', maximum: NaN }])).toThrow()
  })
  it('requires approval without granting authority', () => {
    expect(evaluatePolicies([{ kind: 'approval' }], {}).approvalRequired).toBe(true)
  })
  it('proves only monotonic changes', () => {
    const old = [{ kind: 'allow', field: 'operation', values: ['read', 'write'] }] as const
    expect(isStrengthening(old, [{ kind: 'allow', field: 'operation', values: ['read'] }])).toBe(true)
    expect(isStrengthening(old, [])).toBe(false)
    expect(isStrengthening([{ kind: 'approval' }], [])).toBe(false)
    expect(isStrengthening([{ kind: 'limit', field: 'amount', maximum: 5 }], [{ kind: 'limit', field: 'amount', maximum: 6 }])).toBe(false)
  })
})
