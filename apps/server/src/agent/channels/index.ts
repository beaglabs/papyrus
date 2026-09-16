import type { ConnectorChannel } from '@papyrus/contracts'
import { ChannelRegistry } from './registry.js'
import { githubChannel, GITHUB_CATALOG_ID } from './github/channel.js'
import { githubTools, type ChannelTool, type GithubToolContext } from './github/tools.js'

export { ChannelRegistry } from './registry.js'
export { ChannelStateLane, renderChannelContext, type ChannelStateView, type ChannelSnapshot } from './state-lane.js'
export { connectorContextProcessor, type ChannelContextProcessor } from './processor.js'
export {
  ChannelDefinitionError,
  defineChannel,
  describeChannel,
  jsonSchemaOf,
  type ChannelCommandDefinition,
  type ChannelEventDefinition,
  type ChannelStateDefinition,
  type ConnectorChannelDefinition,
} from './types.js'
export { GITHUB_CATALOG_ID } from './github/channel.js'
export { githubChannel } from './github/channel.js'
export {
  GithubClientError,
  MockGithubClient,
  UnconfiguredGithubClient,
  type GithubClient,
  type GithubFile,
  type GithubRepositoryState,
  type GithubWorkflowRun,
} from './github/client.js'
export { githubTools, githubErrorMessage, type ChannelTool, type GithubToolContext } from './github/tools.js'

/**
 * Every channel the daemon knows about.
 *
 * Adding a connector is adding a declaration here plus its client and tools; the
 * registry, the live state lane, and the JSON Schema producers read all consume
 * this one list.
 */
export const CHANNEL_DEFINITIONS = [githubChannel] as const

export function createChannelRegistry(): ChannelRegistry {
  const registry = new ChannelRegistry()
  for (const definition of CHANNEL_DEFINITIONS) registry.register(definition)
  return registry
}

/**
 * Agent tools contributed by connected channels.
 *
 * `github` is the first channel with tools; the other three connectors add theirs
 * to this function as they land, so the runtime keeps one call site.
 */
export function channelTools(context: { github?: GithubToolContext }): Record<string, ChannelTool> {
  return {
    ...(context.github ? githubTools(context.github) : {}),
  }
}

export function describeChannels(registry: ChannelRegistry): ConnectorChannel[] {
  return registry.describeAll()
}

export const GITHUB_CHANNEL_CATALOG_ID = GITHUB_CATALOG_ID
