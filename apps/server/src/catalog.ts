import type { RuntimeLaunchSpec } from '@papyrus/acp-runtime'

export const RUNTIME_PROFILE_IDS = ['goose', 'opencode'] as const
export type RuntimeProfileId = (typeof RUNTIME_PROFILE_IDS)[number]

export interface RuntimeProfile extends Omit<RuntimeLaunchSpec, 'environment'> {
  label: string
  source: string
}

export const RUNTIME_PROFILES: Readonly<Record<RuntimeProfileId, RuntimeProfile>> = {
  goose: {
    kind: 'goose',
    label: 'Goose',
    command: 'goose',
    args: ['acp'],
    source: 'https://github.com/block/goose',
  },
  opencode: {
    kind: 'opencode',
    label: 'OpenCode',
    command: 'opencode',
    args: ['acp'],
    source: 'https://opencode.ai/docs/acp',
  },
}

export const BROWSER_POLICY_ACTIONS = [
  'BrowserNavigate',
  'BrowserRead',
  'BrowserExecute',
  'BrowserDownload',
  'BrowserUpload',
  'BrowserCredential',
  'BrowserSubmit',
] as const
export type BrowserPolicyAction = (typeof BROWSER_POLICY_ACTIONS)[number]

/** Context-gathering operations available to assigned Users. Mutating browser operations remain privileged. */
export const BROWSER_RESEARCH_ACTIONS = ['BrowserNavigate', 'BrowserRead'] as const satisfies readonly BrowserPolicyAction[]

export interface ConnectorProfile {
  id: string
  label: string
  package: string
  operations: Readonly<Record<string, BrowserPolicyAction>>
  source: string
}

/** Metadata only: Papyrus never interpolates this profile into a shell command. */
export const CONNECTOR_PROFILES: Readonly<Record<string, ConnectorProfile>> = {
  'chrome-acp': {
    id: 'chrome-acp',
    label: 'Chrome ACP',
    package: '@chrome-acp/proxy-server',
    source: 'https://github.com/Areo-Joe/chrome-acp',
    operations: {
      navigate: 'BrowserNavigate',
      read: 'BrowserRead',
      execute: 'BrowserExecute',
      download: 'BrowserDownload',
      upload: 'BrowserUpload',
      credential: 'BrowserCredential',
      submit: 'BrowserSubmit',
    },
  },
}

const CHROME_TOOL_ACTIONS: Readonly<Record<string, BrowserPolicyAction>> = {
  browser_tabs: 'BrowserRead',
  browser_read: 'BrowserRead',
  browser_navigate: 'BrowserNavigate',
  browser_execute: 'BrowserExecute',
  browser_download: 'BrowserDownload',
  browser_upload: 'BrowserUpload',
  browser_credential: 'BrowserCredential',
  browser_submit: 'BrowserSubmit',
}

export function connectorPolicyAction(toolName: string): BrowserPolicyAction | undefined {
  return CHROME_TOOL_ACTIONS[toolName]
}

export function isRuntimeProfileId(value: string): value is RuntimeProfileId {
  return (RUNTIME_PROFILE_IDS as readonly string[]).includes(value)
}
