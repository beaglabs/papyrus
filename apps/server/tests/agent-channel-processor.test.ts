import { describe, expect, it } from 'vitest'
import {
  ChannelStateLane,
  MockGithubClient,
  channelTools,
  connectorContextProcessor,
  createChannelRegistry,
} from '../src/agent/channels/index.js'

/**
 * Connector context has to reach the model, and reach it on every step.
 *
 * Before this existed the GitHub tools passed their own tests while the running
 * agent had no way to call them: nothing merged them into the tool set, and
 * nothing read the state lane during a run. These tests pin the two halves that
 * connect a channel to an actual turn.
 */

const REPOSITORY = 'beaglabs/papyrus'

function laneAt(clock: () => number) {
  const registry = createChannelRegistry()
  return { registry, lane: new ChannelStateLane(registry, clock) }
}

describe('connector context processor', () => {
  it('adds nothing when no connector has reported', async () => {
    let clock = Date.parse('2026-09-15T00:00:00.000Z')
    const { lane } = laneAt(() => clock)
    const processor = connectorContextProcessor(lane)

    const systemMessages: Array<Record<string, unknown>> = []
    await processor.processInputStep({ systemMessages })
    // An appliance with no connected channel must not pay tokens per step.
    expect(systemMessages).toEqual([])
  })

  it('injects the live lane as an untagged system message', async () => {
    let clock = Date.parse('2026-09-15T00:00:00.000Z')
    const { lane } = laneAt(() => clock)
    const client = new MockGithubClient({ now: () => clock })
    client.seed({ repository: REPOSITORY, files: { 'README.md': '# Papyrus\n' } })
    lane.record({
      catalogId: 'github',
      stateId: 'github.repository@1',
      value: await client.getRepositoryState(REPOSITORY),
    })

    const processor = connectorContextProcessor(lane)
    const systemMessages: Array<Record<string, unknown>> = []
    await processor.processInputStep({ systemMessages })

    expect(systemMessages).toHaveLength(1)
    expect(systemMessages[0]).toMatchObject({ role: 'system' })
    const content = String(systemMessages[0]?.['content'])
    expect(content).toMatch(/Live connector context/)
    expect(content).toMatch(/github\.repository@1/)
    expect(content).toMatch(new RegExp(REPOSITORY))
  })

  it('states staleness inline instead of serving an old snapshot as current', async () => {
    let clock = Date.parse('2026-09-15T00:00:00.000Z')
    const { lane } = laneAt(() => clock)
    const client = new MockGithubClient({ now: () => clock })
    client.seed({ repository: REPOSITORY })
    lane.record({ catalogId: 'github', stateId: 'github.repository@1', value: await client.getRepositoryState(REPOSITORY) })

    // Past the declared 300s maximum for github.repository@1.
    clock += 400_000
    const processor = connectorContextProcessor(lane)
    const systemMessages: Array<Record<string, unknown>> = []
    await processor.processInputStep({ systemMessages })

    expect(String(systemMessages[0]?.['content'])).toMatch(/STALE: 400s old/)
  })

  it('survives being handed no system message list', async () => {
    let clock = Date.parse('2026-09-15T00:00:00.000Z')
    const { lane } = laneAt(() => clock)
    const client = new MockGithubClient({ now: () => clock })
    client.seed({ repository: REPOSITORY })
    lane.record({ catalogId: 'github', stateId: 'github.repository@1', value: await client.getRepositoryState(REPOSITORY) })

    const processor = connectorContextProcessor(lane)
    await expect(processor.processInputStep({})).resolves.toBeUndefined()
  })
})

describe('channel tools reach the agent', () => {
  it('exposes the GitHub tools when a channel context is supplied', () => {
    const registry = createChannelRegistry()
    const tools = channelTools({
      github: {
        client: new MockGithubClient(),
        registry,
        integrationId: 'github-integration-1',
        allowedRepositories: [REPOSITORY],
      },
    })
    expect(Object.keys(tools).sort()).toEqual([
      'listGithubFiles', 'listGithubWorkflowRuns', 'readGithubFile',
      'readGithubRepository', 'readGithubWorkflowRun', 'suggestGithubChange',
    ])
    // Every tool must carry the shape the tool registry needs, or registration
    // silently produces an uncallable entry.
    for (const tool of Object.values(tools)) {
      expect(typeof tool.id).toBe('string')
      expect(typeof tool.description).toBe('string')
      expect(tool.inputSchema).toMatchObject({ type: 'object' })
      expect(typeof tool.execute).toBe('function')
    }
  })

  it('contributes nothing when no channel is configured', () => {
    expect(channelTools({})).toEqual({})
  })
})
