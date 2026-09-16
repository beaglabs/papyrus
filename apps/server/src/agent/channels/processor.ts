import { renderChannelContext, type ChannelStateLane } from './state-lane.js'

/**
 * Live connector context for every model step.
 *
 * This is what makes a connector present *during* a run rather than only at the
 * moment a session started. The processor reads the channel state lane before each
 * model step and appends the current view as an **untagged system message**, which
 * Mastra exposes for exactly this: context the model needs now, without rewriting
 * the agent's instructions and without persisting a stale snapshot into stored
 * conversation history.
 *
 * Why a lane and not a fetch: this runs before every step, so pulling from a
 * remote system here would add a network round trip to each one. Refreshes happen
 * on the connector's own schedule; a lane entry that has aged past its declared
 * maximum renders as STALE, so the model is told the value may be out of date
 * instead of being handed yesterday's facts with today's confidence.
 *
 * Returning nothing when the lane is empty matters: an appliance with no connected
 * channels must not pay tokens for an empty header on every step.
 */
export interface ChannelContextProcessor {
  id: string
  name: string
  processInputStep: (args: { systemMessages?: Array<Record<string, unknown>>; messageList?: unknown }) => Promise<unknown>
}

export function connectorContextProcessor(lane: ChannelStateLane): ChannelContextProcessor {
  return {
    id: 'papyrus-connector-context',
    name: 'Papyrus connector live context',
    async processInputStep(args: { systemMessages?: Array<Record<string, unknown>>; messageList?: unknown }) {
      const rendered = renderChannelContext(lane.readAll())
      if (!rendered) return undefined
      if (!Array.isArray(args.systemMessages)) return undefined
      args.systemMessages.push({ role: 'system', content: rendered })
      // Mutating the provided list is the documented way to report the change;
      // messageList is returned when the caller supplied one so a chain of
      // processors keeps operating on the same instance.
      return args.messageList ?? undefined
    },
  }
}
