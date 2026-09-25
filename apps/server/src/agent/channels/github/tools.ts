import type { ChannelRegistry } from '../registry.js'
import { requireCurrentSessionConnectorBinding } from '../../session-connector-access.js'
import { GithubClientError, type GithubClient } from './client.js'
import { GITHUB_CATALOG_ID } from './channel.js'

/**
 * GitHub tools.
 *
 * Reads are direct: an agent inspecting a repository it was pointed at is not an
 * external side effect. Writes are never direct — `suggestGithubChange` validates
 * the command against its declared schema and returns an action suggestion, which
 * is only a UI artifact until an operator releases it through the ledger. Applying
 * the same rules at proposal time that the executor applies at release time is
 * deliberate: an operator is never asked to approve something that would then be
 * refused.
 *
 * Every dispatch, including reads, requires the configured GitHub integration to
 * be bound to the current Agent session. The active deployment integration alone
 * is not sufficient authority.
 */

export interface ChannelTool {
  id: string
  description: string
  inputSchema: Record<string, unknown>
  execute: (input: Record<string, unknown>) => Promise<unknown>
}

export interface GithubToolContext {
  client: GithubClient
  registry: ChannelRegistry
  /** Configured GitHub integration that released actions will run against. */
  integrationId?: string
  /**
   * Repositories this session may touch. Empty refuses everything: an unconfigured
   * connector reaches nothing, and a silent empty allow-list is how a deployment
   * ends up writing to a repository nobody approved.
   */
  allowedRepositories: string[]
}

const REPOSITORY_SCHEMA = { type: 'string', description: 'Repository as owner/name' } as const

function stringField(input: Record<string, unknown>, field: string): string {
  const value = input[field]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`)
  return value.trim()
}

export function githubTools(context: GithubToolContext): Record<string, ChannelTool> {
  const requireBoundIntegration = (): string => {
    if (!context.integrationId) {
      throw new Error('No active GitHub integration is configured, so this session cannot dispatch GitHub tools.')
    }
    requireCurrentSessionConnectorBinding(context.integrationId)
    return context.integrationId
  }

  const permitted = (repository: string): string => {
    requireBoundIntegration()
    if (!context.allowedRepositories.length) {
      throw new Error('No repository is approved for this session. An operator must register the repository on the GitHub integration before any GitHub work can run.')
    }
    if (!context.allowedRepositories.includes(repository)) {
      throw new Error(`${repository} is not an approved repository for this session (approved: ${context.allowedRepositories.join(', ')})`)
    }
    return repository
  }

  const tools: ChannelTool[] = [
    {
      id: 'readGithubRepository',
      description: 'Read the current state of an approved repository: default branch, head commit, open pull requests, and recent workflow runs. Call this before proposing any change, so the change is based on what the repository actually contains now.',
      inputSchema: {
        type: 'object', required: ['repository'], additionalProperties: false,
        properties: { repository: REPOSITORY_SCHEMA },
      },
      execute: async (input) => {
        const repository = permitted(stringField(input, 'repository'))
        return { kind: 'github_repository_state', ...(await context.client.getRepositoryState(repository)) }
      },
    },
    {
      id: 'listGithubFiles',
      description: 'List file paths on a branch of an approved repository, optionally filtered by path prefix.',
      inputSchema: {
        type: 'object', required: ['repository'], additionalProperties: false,
        properties: {
          repository: REPOSITORY_SCHEMA,
          ref: { type: 'string', description: 'Branch or commit; the default branch when omitted' },
          prefix: { type: 'string', description: 'Only return paths starting with this prefix' },
        },
      },
      execute: async (input) => ({
        kind: 'github_files',
        files: await context.client.listFiles({
          repository: permitted(stringField(input, 'repository')),
          ...(typeof input['ref'] === 'string' ? { ref: input['ref'] } : {}),
          ...(typeof input['prefix'] === 'string' ? { prefix: input['prefix'] } : {}),
        }),
      }),
    },
    {
      id: 'readGithubFile',
      description: 'Read one file from an approved repository. Returns the full body, so read it before editing: a commit writes the whole file.',
      inputSchema: {
        type: 'object', required: ['repository', 'path'], additionalProperties: false,
        properties: { repository: REPOSITORY_SCHEMA, path: { type: 'string' }, ref: { type: 'string' } },
      },
      execute: async (input) => {
        const file = await context.client.getFile({
          repository: permitted(stringField(input, 'repository')),
          path: stringField(input, 'path'),
          ...(typeof input['ref'] === 'string' ? { ref: input['ref'] } : {}),
        })
        if (!file) return { kind: 'github_file', found: false }
        return { kind: 'github_file', found: true, ...file }
      },
    },
    {
      id: 'listGithubWorkflowRuns',
      description: 'List GitHub Actions runs for an approved repository and report whether each is still going. A run that is queued or in_progress has not finished: report it as running rather than reporting the outcome, and check again later instead of assuming a result.',
      inputSchema: {
        type: 'object', required: ['repository'], additionalProperties: false,
        properties: { repository: REPOSITORY_SCHEMA, limit: { type: 'number', description: 'Maximum runs to return, default 20' } },
      },
      execute: async (input) => {
        const runs = await context.client.listWorkflowRuns({
          repository: permitted(stringField(input, 'repository')),
          ...(typeof input['limit'] === 'number' ? { limit: input['limit'] } : {}),
        })
        return { kind: 'github_workflow_runs', runs: runs.map(withRunningFlag) }
      },
    },
    {
      id: 'readGithubWorkflowRun',
      description: 'Read one GitHub Actions run by id, including whether it is still running. Use this to follow up work this session started rather than declaring it finished because the dispatch succeeded.',
      inputSchema: {
        type: 'object', required: ['repository', 'runId'], additionalProperties: false,
        properties: { repository: REPOSITORY_SCHEMA, runId: { type: 'number' } },
      },
      execute: async (input) => {
        const runId = input['runId']
        if (typeof runId !== 'number' || !Number.isInteger(runId)) throw new Error('runId must be an integer')
        const run = await context.client.getWorkflowRun({ repository: permitted(stringField(input, 'repository')), runId })
        return { kind: 'github_workflow_run', ...withRunningFlag(run) }
      },
    },
    {
      id: 'suggestGithubChange',
      description: 'Propose one GitHub change — create a branch, commit a file, open a pull request, or dispatch a workflow. This only presents a suggestion: it approves nothing, queues nothing, and executes nothing, and a human operator must release it through the action ledger. The command and its parameters are validated against the connector\'s declared schema before the operator sees them, so a malformed change fails here instead of after approval. Dispatch a workflow to start long-running work on a repository, then follow it with readGithubWorkflowRun.',
      inputSchema: {
        type: 'object', required: ['repository', 'command', 'parameters', 'explanation'], additionalProperties: false,
        properties: {
          repository: REPOSITORY_SCHEMA,
          command: {
            type: 'string',
            enum: ['github.create_branch@1', 'github.commit_file@1', 'github.open_pull_request@1', 'github.dispatch_workflow@1'],
            description: 'Declared GitHub command to propose',
          },
          parameters: { type: 'object', additionalProperties: true, description: 'Command parameters, matching the declared schema for that command' },
          explanation: { type: 'string', description: 'Why this change is proposed, in the operator\'s terms' },
        },
      },
      execute: async (input) => {
        const repository = permitted(stringField(input, 'repository'))
        const command = stringField(input, 'command')
        const explanation = stringField(input, 'explanation')
        const parameters = input['parameters']
        if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) throw new Error('parameters must be an object')

        const validation = context.registry.validateCommand(GITHUB_CATALOG_ID, command, { ...(parameters as Record<string, unknown>), repository })
        if (!validation.ok) throw new Error(`${command} cannot be proposed: ${validation.reason}`)

        const integrationId = requireBoundIntegration()

        return {
          kind: 'action_suggestion',
          executorIntegrationId: integrationId,
          action: command,
          target: repository,
          rationale: explanation,
          rationaleClaimIds: Array.isArray(input['rationaleClaimIds'])
            ? (input['rationaleClaimIds'] as unknown[]).filter((value): value is string => typeof value === 'string')
            : [],
          parameters: validation.value,
        }
      },
    },
  ]

  return Object.fromEntries(tools.map((tool) => [tool.id, tool]))
}

function withRunningFlag(run: { status: string; conclusion?: string }): Record<string, unknown> {
  return { ...run, running: run.status === 'queued' || run.status === 'in_progress' }
}

/** Exported for the runtime to reuse when it reports a GitHub failure to the operator. */
export function githubErrorMessage(error: unknown): string {
  if (error instanceof GithubClientError) return `${error.code}: ${error.message}`
  return error instanceof Error ? error.message : 'GitHub request failed'
}
