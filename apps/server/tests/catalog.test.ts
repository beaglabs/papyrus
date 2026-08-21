import { describe, expect, it } from 'vitest'
import { BROWSER_POLICY_ACTIONS, BROWSER_RESEARCH_ACTIONS, CONNECTOR_PROFILES, connectorPolicyAction } from '../src/catalog.js'

describe('connector catalog', () => {
  it('maps browser capabilities to separate Cedar actions', () => {
    const actions = Object.values(CONNECTOR_PROFILES['chrome-acp'].operations)
    expect(new Set(actions)).toEqual(new Set(BROWSER_POLICY_ACTIONS))
    expect(connectorPolicyAction('browser_upload')).toBe('BrowserUpload')
    expect(connectorPolicyAction('unrelated_tool')).toBeUndefined()
    expect(BROWSER_RESEARCH_ACTIONS).toEqual(['BrowserNavigate', 'BrowserRead'])
  })
})
