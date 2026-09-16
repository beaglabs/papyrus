import type { ChannelRegistry } from './registry.js'
import type { ChannelStateDefinition } from './types.js'

/**
 * The channel state lane.
 *
 * This is how a connector stays present during a run rather than only at session
 * start: each connector keeps its current view of the world here, and the agent's
 * input step reads the lane. The lane is deliberately a cache with an age, not a
 * live fetch — a per-step network call would wreck latency and token cost, so
 * refreshes happen on the connector's own schedule and a stale entry says so
 * instead of being served as current.
 */

export interface ChannelSnapshot {
  catalogId: string
  stateId: string
  value: Record<string, unknown>
  capturedAt: number
}

export interface ChannelStateView extends ChannelSnapshot {
  label: string
  description: string
  maxAgeSeconds: number
  ageSeconds: number
  stale: boolean
}

/** Per-entry ceiling on rendered context. A state lane is context, not an export. */
const MAX_RENDERED_BYTES = 4_096

export class ChannelStateLane {
  private readonly snapshots = new Map<string, ChannelSnapshot>()

  constructor(
    private readonly registry: ChannelRegistry,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Record a connector's current view.
   *
   * The state id must be the one the channel declares: a lane entry nobody reads
   * is worse than no entry, because it looks like coverage.
   */
  record(input: { catalogId: string; stateId: string; value: Record<string, unknown>; capturedAt?: number }): ChannelStateView {
    const definition = this.registry.get(input.catalogId)
    const declared: ChannelStateDefinition | undefined = definition?.state
    if (!declared) throw new Error(`${input.catalogId} declares no state lane`)
    if (declared.id !== input.stateId) throw new Error(`${input.catalogId} declares state ${declared.id}, not ${input.stateId}`)
    const parsed = declared.schema.safeParse(input.value)
    if (!parsed.success) {
      const reason = parsed.error.issues.map((issue) => `${issue.path.join('.') || '<root>'} ${issue.message}`).join('; ')
      throw new Error(`${input.stateId} snapshot rejected: ${reason}`)
    }
    const snapshot: ChannelSnapshot = {
      catalogId: input.catalogId,
      stateId: input.stateId,
      value: parsed.data as Record<string, unknown>,
      capturedAt: input.capturedAt ?? this.now(),
    }
    this.snapshots.set(input.catalogId, snapshot)
    return this.view(snapshot, declared)
  }

  read(catalogId: string): ChannelStateView | undefined {
    const snapshot = this.snapshots.get(catalogId)
    if (!snapshot) return undefined
    const declared = this.registry.get(catalogId)?.state
    if (!declared) return undefined
    return this.view(snapshot, declared)
  }

  readAll(): ChannelStateView[] {
    return [...this.snapshots.keys()].sort().flatMap((catalogId) => {
      const view = this.read(catalogId)
      return view ? [view] : []
    })
  }

  clear(catalogId: string): void {
    this.snapshots.delete(catalogId)
  }

  private view(snapshot: ChannelSnapshot, declared: ChannelStateDefinition): ChannelStateView {
    const ageSeconds = Math.max(0, Math.round((this.now() - snapshot.capturedAt) / 1_000))
    return {
      ...snapshot,
      label: declared.label,
      description: declared.description,
      maxAgeSeconds: declared.maxAgeSeconds,
      ageSeconds,
      stale: ageSeconds > declared.maxAgeSeconds,
    }
  }
}

/**
 * Render the lane as the context block a model step receives.
 *
 * Staleness is stated inline rather than hidden, because a model that cannot tell
 * fresh state from yesterday's will state yesterday's facts with today's
 * confidence.
 */
export function renderChannelContext(views: ChannelStateView[]): string {
  if (!views.length) return ''
  const lines = views.map((view) => {
    const age = view.stale
      ? `STALE: ${view.ageSeconds}s old, declared maximum ${view.maxAgeSeconds}s — refresh before relying on any value below`
      : `${view.ageSeconds}s old`
    return `[${view.catalogId}] ${view.stateId} (${age})\n${clip(JSON.stringify(view.value))}`
  })
  return ['Live connector context. This is the current state reported by connected systems for this step:', ...lines].join('\n')
}

function clip(value: string): string {
  if (Buffer.byteLength(value) <= MAX_RENDERED_BYTES) return value
  return `${value.slice(0, MAX_RENDERED_BYTES)}… (truncated)`
}
