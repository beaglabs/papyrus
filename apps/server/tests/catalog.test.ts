import { describe, expect, it } from 'vitest'
import { BROWSER_POLICY_ACTIONS, BROWSER_RESEARCH_ACTIONS, CONNECTOR_PROFILES, RUNTIME_PROFILES, connectorPolicyAction } from '../src/catalog.js'

describe('adapter catalog', () => {
  it('uses fixed argv profiles without shell fragments', () => {
    for (const profile of Object.values(RUNTIME_PROFILES)) {
      expect(profile.command).toMatch(/^[a-z0-9-]+$/)
      expect(profile.args.every((arg) => !/[;&|`$<>]/.test(arg))).toBe(true)
    }
    expect(RUNTIME_PROFILES.opencode.args).toEqual(['acp'])
  })

  it('maps browser capabilities to separate Cedar actions', () => {
    const actions = Object.values(CONNECTOR_PROFILES['chrome-acp'].operations)
    expect(new Set(actions)).toEqual(new Set(BROWSER_POLICY_ACTIONS))
    expect(connectorPolicyAction('browser_upload')).toBe('BrowserUpload')
    expect(connectorPolicyAction('unrelated_tool')).toBeUndefined()
    expect(BROWSER_RESEARCH_ACTIONS).toEqual(['BrowserNavigate', 'BrowserRead'])
  })
})
