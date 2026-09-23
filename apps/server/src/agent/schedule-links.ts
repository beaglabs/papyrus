import { MastraRuntimeError, type MastraRuntime } from './mastra/runtime.js'

export interface ScheduleLinkRecord {
  id: string
  name: string
  cron: string
  prompt: string
  timezone?: string
  threadId: string
  status?: string
  nextFireAt?: number | null
  lastFireAt?: number | null
  createdAt?: string
  updatedAt?: string
}

export interface ScheduleLinkPatch {
  name: string
  cron: string
  prompt: string
  timezone?: string
}

type ScheduleManager = {
  update: (id: string, patch: Record<string, unknown>) => Promise<unknown>
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function optionalNumber(value: unknown): number | null | undefined {
  if (value === null) return null
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asScheduleLink(value: unknown): ScheduleLinkRecord | undefined {
  const item = record(value)
  if (!item) return undefined
  const id = optionalString(item['id'])
  const cron = optionalString(item['cron'])
  const prompt = optionalString(item['prompt'])
  const threadId = optionalString(item['threadId'])
  if (!id || !cron || !prompt || !threadId) return undefined

  const name = optionalString(item['name']) ?? 'Scheduled agent work'
  const timezone = optionalString(item['timezone'])
  const status = optionalString(item['status'])
  const createdAt = optionalString(item['createdAt'])
  const updatedAt = optionalString(item['updatedAt'])
  const nextFireAt = optionalNumber(item['nextFireAt'])
  const lastFireAt = optionalNumber(item['lastFireAt'])
  return {
    id,
    name,
    cron,
    prompt,
    threadId,
    ...(timezone ? { timezone } : {}),
    ...(status ? { status } : {}),
    ...(nextFireAt !== undefined ? { nextFireAt } : {}),
    ...(lastFireAt !== undefined ? { lastFireAt } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  }
}

/**
 * Schedules are exposed through the authenticated Links surface rather than a standalone
 * scheduler page. MastraRuntime.listSchedules already scopes the query to this Papyrus agent
 * and deployment resource, so these records cannot cross a customer resource boundary.
 */
export async function listScheduleLinks(runtime: MastraRuntime): Promise<ScheduleLinkRecord[]> {
  return (await runtime.listSchedules()).flatMap((value) => {
    const schedule = asScheduleLink(value)
    return schedule ? [schedule] : []
  })
}

export async function getScheduleLink(runtime: MastraRuntime, id: string): Promise<ScheduleLinkRecord> {
  const schedule = (await listScheduleLinks(runtime)).find((candidate) => candidate.id === id)
  if (!schedule) throw new MastraRuntimeError(404, 'SCHEDULE_NOT_FOUND', 'Schedule not found in this Papyrus deployment')
  return schedule
}

/**
 * Mastra 1.50+ exposes update(id, patch) on mastra.schedules, but MastraRuntime intentionally
 * keeps the framework handle private. This adapter is the one narrow portal bridge to that API:
 * ownership is proved first through the runtime's resource-scoped listSchedules() method, then
 * only the editable schedule fields are forwarded. Thread and resource targets are never
 * patchable from the portal.
 */
export async function updateScheduleLink(runtime: MastraRuntime, id: string, patch: ScheduleLinkPatch): Promise<ScheduleLinkRecord> {
  await getScheduleLink(runtime, id)

  const internal = runtime as unknown as {
    mastra?: { instance?: { schedules?: Partial<ScheduleManager> } }
  }
  const manager = internal.mastra?.instance?.schedules
  if (!manager || typeof manager.update !== 'function') {
    throw new MastraRuntimeError(503, 'SCHEDULE_UPDATE_UNAVAILABLE', 'The installed Mastra runtime does not expose schedule updates')
  }

  const update: Record<string, unknown> = {
    name: patch.name,
    cron: patch.cron,
    prompt: patch.prompt,
  }
  if (patch.timezone) update['timezone'] = patch.timezone

  const result = await manager.update(id, update)
  const normalized = asScheduleLink(result)
  return normalized ?? getScheduleLink(runtime, id)
}
