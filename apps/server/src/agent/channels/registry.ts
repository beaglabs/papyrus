import type { ChannelValidation, ConnectorChannel } from '@papyrus/contracts'
import { ChannelDefinitionError, describeChannel, type ConnectorChannelDefinition } from './types.js'

/**
 * The channel registry.
 *
 * Validation returns a result rather than throwing, because the callers differ:
 * an inbound webhook turns a refusal into a 400 with a precise reason, and the
 * agent's suggestion path turns it into an error the operator never has to read,
 * since a malformed command is refused before it becomes a proposal.
 */
export class ChannelRegistry {
  private readonly channels = new Map<string, ConnectorChannelDefinition>()

  register(definition: ConnectorChannelDefinition): this {
    if (this.channels.has(definition.catalogId)) {
      throw new ChannelDefinitionError(`a channel is already registered for ${definition.catalogId}`)
    }
    this.channels.set(definition.catalogId, definition)
    return this
  }

  get(catalogId: string): ConnectorChannelDefinition | undefined {
    return this.channels.get(catalogId)
  }

  catalogIds(): string[] {
    return [...this.channels.keys()].sort()
  }

  describe(catalogId: string): ConnectorChannel | undefined {
    const definition = this.channels.get(catalogId)
    return definition ? describeChannel(definition) : undefined
  }

  describeAll(): ConnectorChannel[] {
    return this.catalogIds().map((catalogId) => this.describe(catalogId) as ConnectorChannel)
  }

  /** Validate a producer payload against a declared inbound event. */
  validateEvent(catalogId: string, eventId: string, payload: unknown): ChannelValidation {
    return this.validate(catalogId, eventId, payload, 'event')
  }

  /** Validate a proposed payload against a declared outbound command. */
  validateCommand(catalogId: string, commandId: string, payload: unknown): ChannelValidation {
    return this.validate(catalogId, commandId, payload, 'command')
  }

  private validate(catalogId: string, id: string, payload: unknown, kind: 'event' | 'command'): ChannelValidation {
    const definition = this.channels.get(catalogId)
    if (!definition) return { ok: false, id, reason: `${catalogId} declares no channel` }
    const declared = kind === 'event'
      ? definition.events.find((candidate) => candidate.id === id)
      : definition.commands.find((candidate) => candidate.id === id)
    if (!declared) {
      const known = (kind === 'event' ? definition.events : definition.commands).map((candidate) => candidate.id)
      return { ok: false, id, reason: known.length ? `${catalogId} declares no ${kind} ${id}; known: ${known.join(', ')}` : `${catalogId} declares no ${kind} ${id}` }
    }
    const parsed = declared.schema.safeParse(payload)
    if (!parsed.success) {
      // Name the offending fields. "Invalid payload" costs an integrator an hour.
      const reason = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'} ${issue.message}`)
        .join('; ')
      return { ok: false, id, reason }
    }
    return { ok: true, id, value: parsed.data as Record<string, unknown> }
  }
}
