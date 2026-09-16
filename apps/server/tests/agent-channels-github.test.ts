import { describe, expect, it } from 'vitest'
import {
  ChannelDefinitionError,
  ChannelRegistry,
  ChannelStateLane,
  MockGithubClient,
  createChannelRegistry,
  defineChannel,
  githubTools,
  renderChannelContext,
  type ChannelTool,
} from '../src/agent/channels/index.js'
import { z } from 'zod'

const REPOSITORY = 'beaglabs/papyrus'

function harness(options: { now?: () => number; allowed?: string[]; integrationId?: string } = {}) {
  const client = new MockGithubClient({ now: options.now, queueDurationMs: 1_000, runDurationMs: 600_000 })
  client.seed({
    repository: REPOSITORY,
    files: { 'README.md': '# Papyrus\n', 'apps/server/src/agent/http.ts': 'export {}\n' },
  })
  const registry = createChannelRegistry()
  return {
    client,
    registry,
    tools: githubTools({
      client,
      registry,
      integrationId: options.integrationId ?? 'github-integration-1',
      allowedRepositories: options.allowed ?? [REPOSITORY],
    }),
  }
}

async function call(tools: Record<string, ChannelTool>, id: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const tool = tools[id]
  if (!tool) throw new Error(`no tool ${id}`)
  return (await tool.execute(input)) as Record<string, unknown>
}

describe('channel declarations', () => {
  it('refuses an unversioned or duplicate identifier', () => {
    const schema = z.object({ value: z.string() })
    expect(() => defineChannel({
      catalogId: 'demo', version: 1,
      events: [{ id: 'demo.event', label: 'x', description: 'x', schema, example: { value: 'a' } }],
      commands: [],
    })).toThrow(ChannelDefinitionError)

    expect(() => defineChannel({
      catalogId: 'demo', version: 1,
      events: [
        { id: 'demo.event@1', label: 'x', description: 'x', schema, example: { value: 'a' } },
        { id: 'demo.event@1', label: 'y', description: 'y', schema, example: { value: 'b' } },
      ],
      commands: [],
    })).toThrow(/declares demo\.event@1 twice/)
  })

  it('refuses an example that contradicts its own schema', () => {
    // A documented example nobody validated is the first thing an integrator copies.
    expect(() => defineChannel({
      catalogId: 'demo', version: 1,
      events: [{ id: 'demo.event@1', label: 'x', description: 'x', schema: z.object({ value: z.string() }), example: { value: 42 } }],
      commands: [],
    })).toThrow(/does not satisfy its own schema/)
  })

  it('publishes the GitHub channel with both directions and a state lane', () => {
    const registry = createChannelRegistry()
    const channel = registry.describe('github')
    expect(channel?.events.map((event) => event.id)).toEqual(['github.push@1', 'github.pull_request@1', 'github.workflow_run@1'])
    expect(channel?.state?.id).toBe('github.repository@1')
    expect(channel?.commands.map((command) => command.id)).toEqual([
      'github.create_branch@1', 'github.commit_file@1', 'github.open_pull_request@1', 'github.dispatch_workflow@1',
    ])
    // Every command is a ledger write by construction, not by convention.
    expect(channel?.commands.every((command) => command.approval === 'ledger')).toBe(true)
    // Producers get real JSON Schema, derived from the same declaration.
    expect(channel?.commands[1]?.jsonSchema).toMatchObject({ type: 'object', required: expect.arrayContaining(['repository', 'path', 'content']) })
  })
})

describe('channel validation', () => {
  it('accepts a well-formed push and names the offending field when it is not', () => {
    const registry = createChannelRegistry()
    const good = registry.validateEvent('github', 'github.push@1', {
      repository: { fullName: REPOSITORY, defaultBranch: 'main' },
      ref: 'refs/heads/main', after: 'a1b2c3d4', commits: [],
    })
    expect(good.ok).toBe(true)

    const bad = registry.validateEvent('github', 'github.push@1', { repository: { fullName: REPOSITORY }, ref: '', after: 'x', commits: 'no' })
    expect(bad.ok).toBe(false)
    if (!bad.ok) {
      expect(bad.reason).toMatch(/defaultBranch|ref|commits/)
    }
  })

  it('refuses an unknown event or command and lists what exists', () => {
    const registry = createChannelRegistry()
    const unknown = registry.validateEvent('github', 'github.issue@1', {})
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.reason).toMatch(/declares no event github\.issue@1/)
  })

  it('rejects a channel for a connector that declares none', () => {
    const registry = new ChannelRegistry()
    expect(registry.validateCommand('zeek', 'zeek.anything@1', {}).ok).toBe(false)
  })
})

describe('GitHub read tools', () => {
  it('reads repository state', async () => {
    const { tools } = harness()
    const state = await call(tools, 'readGithubRepository', { repository: REPOSITORY })
    expect(state).toMatchObject({ kind: 'github_repository_state', repository: REPOSITORY, defaultBranch: 'main' })
  })

  it('reads a file, and says plainly when it is absent', async () => {
    const { tools } = harness()
    expect(await call(tools, 'readGithubFile', { repository: REPOSITORY, path: 'README.md' })).toMatchObject({ found: true, content: '# Papyrus\n' })
    expect(await call(tools, 'readGithubFile', { repository: REPOSITORY, path: 'nope.md' })).toMatchObject({ found: false })
  })

  it('lists files by prefix', async () => {
    const { tools } = harness()
    expect(await call(tools, 'listGithubFiles', { repository: REPOSITORY, prefix: 'apps/' })).toMatchObject({ files: ['apps/server/src/agent/http.ts'] })
  })

  it('refuses every GitHub tool when no repository is approved', async () => {
    const { tools } = harness({ allowed: [] })
    await expect(call(tools, 'readGithubRepository', { repository: REPOSITORY })).rejects.toThrow(/No repository is approved for this session/)
  })

  it('refuses a repository outside the approved list', async () => {
    const { tools } = harness()
    await expect(call(tools, 'readGithubRepository', { repository: 'attacker/other' })).rejects.toThrow(/not an approved repository/)
  })
})

describe('GitHub long-running workflows', () => {
  it('reports a dispatched workflow as running, then completed, as time advances', async () => {
    // A twelve-minute workflow, advanced instantly: the point of the injected clock.
    let clock = Date.parse('2026-09-15T00:00:00.000Z')
    const { tools, client } = harness({ now: () => clock })

    const dispatched = await client.dispatchWorkflow({ repository: REPOSITORY, workflow: 'ci.yml', ref: 'main' })
    expect(dispatched.status).toBe('queued')

    const queued = await call(tools, 'readGithubWorkflowRun', { repository: REPOSITORY, runId: dispatched.runId })
    expect(queued).toMatchObject({ status: 'queued', running: true })

    clock += 30_000
    const running = await call(tools, 'readGithubWorkflowRun', { repository: REPOSITORY, runId: dispatched.runId })
    expect(running).toMatchObject({ status: 'in_progress', running: true })

    clock += 600_000
    const done = await call(tools, 'readGithubWorkflowRun', { repository: REPOSITORY, runId: dispatched.runId })
    expect(done).toMatchObject({ status: 'completed', conclusion: 'success', running: false })

    const listed = await call(tools, 'listGithubWorkflowRuns', { repository: REPOSITORY })
    expect(listed['runs']).toEqual([expect.objectContaining({ runId: dispatched.runId, running: false })])
  })

  it('reports a failing workflow as a failure rather than a success', async () => {
    let clock = Date.parse('2026-09-15T00:00:00.000Z')
    const client = new MockGithubClient({ now: () => clock, queueDurationMs: 0, runDurationMs: 1_000, failingWorkflows: ['ci.yml'] })
    client.seed({ repository: REPOSITORY })
    const dispatched = await client.dispatchWorkflow({ repository: REPOSITORY, workflow: 'ci.yml', ref: 'main' })
    clock += 5_000
    expect(await client.getWorkflowRun({ repository: REPOSITORY, runId: dispatched.runId })).toMatchObject({ status: 'completed', conclusion: 'failure' })
  })
})

describe('GitHub outbound suggestions', () => {
  it('turns a valid command into a ledger suggestion with validated parameters', async () => {
    const { tools } = harness()
    const suggestion = await call(tools, 'suggestGithubChange', {
      repository: REPOSITORY,
      command: 'github.create_branch@1',
      parameters: { branch: 'fix/dod-graph-host', from: 'main' },
      explanation: 'Fix the DoD Graph host on a branch before opening a pull request.',
    })
    expect(suggestion).toMatchObject({
      kind: 'action_suggestion',
      executorIntegrationId: 'github-integration-1',
      action: 'github.create_branch@1',
      target: REPOSITORY,
    })
    // The repository the tool resolved is part of the validated parameters, so the
    // released action cannot target anything the operator did not see.
    expect(suggestion['parameters']).toMatchObject({ repository: REPOSITORY, branch: 'fix/dod-graph-host', from: 'main' })
  })

  it('refuses a malformed command before an operator ever sees it', async () => {
    const { tools } = harness()
    await expect(call(tools, 'suggestGithubChange', {
      repository: REPOSITORY,
      command: 'github.commit_file@1',
      parameters: { branch: 'fix/x', path: 'docs/note.md' },
      explanation: 'missing content and message',
    })).rejects.toThrow(/cannot be proposed/)
  })

  it('refuses an undeclared command', async () => {
    const { tools } = harness()
    await expect(call(tools, 'suggestGithubChange', {
      repository: REPOSITORY, command: 'github.delete_repository@1', parameters: {}, explanation: 'nope',
    })).rejects.toThrow(/declares no command/)
  })

  it('refuses to suggest when no integration could release the action', async () => {
    const client = new MockGithubClient()
    client.seed({ repository: REPOSITORY })
    const registry = createChannelRegistry()
    const tools = githubTools({ client, registry, allowedRepositories: [REPOSITORY] })
    await expect(call(tools, 'suggestGithubChange', {
      repository: REPOSITORY, command: 'github.create_branch@1', parameters: { branch: 'x', from: 'main' }, explanation: 'x',
    })).rejects.toThrow(/No active GitHub integration/)
  })

  it('does not write anything: the suggestion leaves the repository untouched', async () => {
    const { tools, client } = harness()
    await call(tools, 'suggestGithubChange', {
      repository: REPOSITORY, command: 'github.create_branch@1', parameters: { branch: 'never-created', from: 'main' }, explanation: 'x',
    })
    await expect(client.createBranch({ repository: REPOSITORY, branch: 'never-created', from: 'main' })).resolves.toMatchObject({ branch: 'never-created' })
    expect(await client.listFiles({ repository: REPOSITORY, ref: 'main' })).toEqual(['README.md', 'apps/server/src/agent/http.ts'])
  })
})

describe('channel state lane', () => {
  it('serves a current snapshot and marks an old one stale instead of pretending', async () => {
    let clock = Date.parse('2026-09-15T00:00:00.000Z')
    const registry = createChannelRegistry()
    const lane = new ChannelStateLane(registry, () => clock)
    const { client } = harness({ now: () => clock })
    const state = await client.getRepositoryState(REPOSITORY)

    lane.record({ catalogId: 'github', stateId: 'github.repository@1', value: state })
    expect(lane.read('github')).toMatchObject({ stale: false, ageSeconds: 0 })

    clock += 301_000
    const view = lane.read('github')
    expect(view).toMatchObject({ stale: true, ageSeconds: 301, maxAgeSeconds: 300 })
    expect(renderChannelContext([view!])).toMatch(/STALE: 301s old/)
  })

  it('refuses a snapshot that does not match the declared state', () => {
    const registry = createChannelRegistry()
    const lane = new ChannelStateLane(registry)
    expect(() => lane.record({ catalogId: 'github', stateId: 'github.repository@1', value: { repository: REPOSITORY } })).toThrow(/snapshot rejected/)
    expect(() => lane.record({ catalogId: 'github', stateId: 'github.other@1', value: {} })).toThrow(/declares state/)
    expect(() => lane.record({ catalogId: 'zeek', stateId: 'zeek.state@1', value: {} })).toThrow(/declares no state lane/)
  })

  it('renders nothing when no connector has reported', () => {
    expect(renderChannelContext([])).toBe('')
  })
})
