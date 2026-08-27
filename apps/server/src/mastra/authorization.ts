import { WORKSPACE_TOOLS } from '@mastra/core/workspace'
import type { PolicyAction } from '../policy.js'

// Deliberately an exact allowlist. New Mastra tools must acquire an explicit
// policy mapping before they can execute, including tools added by dependencies.
export const RUNTIME_TOOL_ACTIONS: Readonly<Record<string, PolicyAction>> = {
  [WORKSPACE_TOOLS.FILESYSTEM.READ_FILE]: 'WorkspaceRead',
  [WORKSPACE_TOOLS.FILESYSTEM.LIST_FILES]: 'WorkspaceRead',
  [WORKSPACE_TOOLS.FILESYSTEM.FILE_STAT]: 'WorkspaceRead',
  [WORKSPACE_TOOLS.FILESYSTEM.GREP]: 'WorkspaceRead',
  [WORKSPACE_TOOLS.SEARCH.SEARCH]: 'WorkspaceRead',
  [WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE]: 'WorkspaceWrite',
  [WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE]: 'WorkspaceWrite',
  [WORKSPACE_TOOLS.FILESYSTEM.AST_EDIT]: 'WorkspaceWrite',
  [WORKSPACE_TOOLS.FILESYSTEM.MKDIR]: 'WorkspaceWrite',
  [WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND]: 'WorkspaceExecute',
  [WORKSPACE_TOOLS.SANDBOX.GET_PROCESS_OUTPUT]: 'WorkspaceExecute',
  [WORKSPACE_TOOLS.SANDBOX.KILL_PROCESS]: 'WorkspaceExecute',
  skill: 'WorkspaceRead', skill_read: 'WorkspaceRead', skill_search: 'WorkspaceRead',
  updateWorkingMemory: 'WorkspaceWrite',
  papyrus_set_goal: 'WorkspaceWrite',
  papyrus_request_input: 'WorkspaceRead',
  papyrus_generate: 'GenerateImage',
  papyrus_browser_navigate: 'BrowserNavigate',
  papyrus_browser_read: 'BrowserRead',
}

export function runtimeToolAction(name: string): PolicyAction | undefined {
  return Object.hasOwn(RUNTIME_TOOL_ACTIONS, name) ? RUNTIME_TOOL_ACTIONS[name] : undefined
}
