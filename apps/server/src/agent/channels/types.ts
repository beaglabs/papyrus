import { z } from 'zod'
import type {
  ChannelCommandDeclaration,
  ChannelEventDeclaration,
  ChannelStateDeclaration,
  ConnectorChannel,
  IntegrationRisk,
} from '@papyrus/contracts'

/**
 * Channel declarations.
 *
 * A declaration is the single source of truth for one connector's shapes: the
 * daemon validates producer payloads with it, the agent's tools take their input
 * schema from it, and a non-TypeScript producer can fetch it as JSON Schema. There
 * is no second place where a payload shape is written down.
 *
 * The declaration is data, not authority. Nothing here grants the ability to write
 * to an external system; every command still crosses propose -> approve -> ledger.
 */

/**
 * `<name>@<version>`, where the version is part of the identity rather than
 * decoration. Separators are dots, hyphens, or underscores so a declaration can
 * keep a provider's own event name (`github.pull_request@1`) instead of inventing
 * a synonym for it.
 */
const CHANNEL_ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*@[1-9][0-9]*$/

export class ChannelDefinitionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChannelDefinitionError'
  }
}

export interface ChannelEventDefinition {
  id: string
  label: string
  description: string
  schema: z.ZodType
  example: Record<string, unknown>
  evidenceType?: string
}

export interface ChannelStateDefinition {
  id: string
  label: string
  description: string
  schema: z.ZodType
  maxAgeSeconds: number
}

export interface ChannelCommandDefinition {
  id: string
  label: string
  description: string
  schema: z.ZodType
  example: Record<string, unknown>
  risk: IntegrationRisk
}

export interface ConnectorChannelDefinition {
  catalogId: string
  version: number
  events: ChannelEventDefinition[]
  state?: ChannelStateDefinition
  commands: ChannelCommandDefinition[]
}

/**
 * Project a zod schema to JSON Schema.
 *
 * `$schema` is dropped: the tool layer and the producers both expect a bare
 * schema, and a draft URL in a tool definition invites a validator argument that
 * nothing here needs.
 */
export function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const projected = z.toJSONSchema(schema) as Record<string, unknown>
  delete projected['$schema']
  return projected
}

function assertVersionedId(id: string, kind: string): void {
  if (!CHANNEL_ID.test(id)) {
    throw new ChannelDefinitionError(`${kind} id ${JSON.stringify(id)} must be versioned as <name>@<integer>, for example github.push@1`)
  }
}

function assertExample(id: string, schema: z.ZodType, example: Record<string, unknown>): void {
  const parsed = schema.safeParse(example)
  if (!parsed.success) {
    // A documented example that does not validate is a lie in the docs, and the
    // first person to copy it into a producer pays for it.
    throw new ChannelDefinitionError(`${id} example does not satisfy its own schema: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || '<root>'} ${issue.message}`).join('; ')}`)
  }
}

/**
 * Declare a connector channel, refusing a declaration that cannot be trusted:
 * unversioned or duplicate identifiers, and examples that contradict their schema.
 */
export function defineChannel(definition: ConnectorChannelDefinition): ConnectorChannelDefinition {
  if (!/^[a-z][a-z0-9-]*$/.test(definition.catalogId)) {
    throw new ChannelDefinitionError(`catalogId ${JSON.stringify(definition.catalogId)} must be lowercase letters, digits, and hyphens`)
  }
  if (!Number.isInteger(definition.version) || definition.version < 1) {
    throw new ChannelDefinitionError(`${definition.catalogId} channel version must be a positive integer`)
  }

  const seen = new Set<string>()
  const claim = (id: string, kind: string): void => {
    assertVersionedId(id, kind)
    if (seen.has(id)) throw new ChannelDefinitionError(`${definition.catalogId} declares ${id} twice`)
    seen.add(id)
  }

  for (const event of definition.events) {
    claim(event.id, 'event')
    assertExample(event.id, event.schema, event.example)
  }
  for (const command of definition.commands) {
    claim(command.id, 'command')
    assertExample(command.id, command.schema, command.example)
    if (command.risk === 'critical' && !command.description.trim()) {
      throw new ChannelDefinitionError(`${command.id} is critical risk and must describe what it changes`)
    }
  }
  if (definition.state) {
    claim(definition.state.id, 'state')
    if (!Number.isFinite(definition.state.maxAgeSeconds) || definition.state.maxAgeSeconds <= 0) {
      throw new ChannelDefinitionError(`${definition.state.id} maxAgeSeconds must be positive`)
    }
  }

  return definition
}

/** Project a declaration into the wire-safe descriptor that producers and the portal read. */
export function describeChannel(definition: ConnectorChannelDefinition): ConnectorChannel {
  const events: ChannelEventDeclaration[] = definition.events.map((event) => ({
    id: event.id,
    label: event.label,
    description: event.description,
    jsonSchema: jsonSchemaOf(event.schema),
    example: event.example,
    ...(event.evidenceType ? { evidenceType: event.evidenceType } : {}),
  }))
  const state: ChannelStateDeclaration | undefined = definition.state
    ? {
        id: definition.state.id,
        label: definition.state.label,
        description: definition.state.description,
        jsonSchema: jsonSchemaOf(definition.state.schema),
        maxAgeSeconds: definition.state.maxAgeSeconds,
      }
    : undefined
  const commands: ChannelCommandDeclaration[] = definition.commands.map((command) => ({
    id: command.id,
    label: command.label,
    description: command.description,
    jsonSchema: jsonSchemaOf(command.schema),
    example: command.example,
    approval: 'ledger',
    risk: command.risk,
  }))
  return {
    catalogId: definition.catalogId,
    version: definition.version,
    events,
    ...(state ? { state } : {}),
    commands,
  }
}
