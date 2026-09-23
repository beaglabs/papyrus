import { describe, expect, it, vi } from 'vitest'
import { getScheduleLink, listScheduleLinks, updateScheduleLink } from '../src/agent/schedule-links.js'
import type { MastraRuntime } from '../src/agent/mastra/runtime.js'

function runtimeWith(schedules: Array<Record<string, unknown>>, update = vi.fn(async (_id: string, patch: Record<string, unknown>) => ({ ...schedules[0], ...patch }))) {
  return {
    listSchedules: vi.fn(async () => schedules),
    mastra: { instance: { schedules: { update } } },
  } as unknown as MastraRuntime
}

const schedule = {
  id: 'agent_morning-brief',
  name: 'Morning brief',
  cron: '0 8 * * 1-5',
  prompt: 'Review overnight mission signals.',
  timezone: 'America/New_York',
  threadId: 'thread-a',
  status: 'active',
  nextFireAt: 1_800_000_000_000,
}

describe('schedule Links adapter', () => {
  it('normalizes only resource-scoped threaded agent schedules returned by the runtime', async () => {
    const runtime = runtimeWith([schedule, { id: 'workflow-x', cron: '0 9 * * *' }])
    await expect(listScheduleLinks(runtime)).resolves.toEqual([schedule])
    await expect(getScheduleLink(runtime, schedule.id)).resolves.toEqual(schedule)
  })

  it('updates editable parameters without exposing the thread/resource target', async () => {
    const update = vi.fn(async (_id: string, patch: Record<string, unknown>) => ({ ...schedule, ...patch }))
    const runtime = runtimeWith([schedule], update)
    const changed = await updateScheduleLink(runtime, schedule.id, {
      name: 'Afternoon brief',
      cron: '0 15 * * 1-5',
      prompt: 'Review the afternoon queue.',
      timezone: 'UTC',
    })

    expect(update).toHaveBeenCalledWith(schedule.id, {
      name: 'Afternoon brief',
      cron: '0 15 * * 1-5',
      prompt: 'Review the afternoon queue.',
      timezone: 'UTC',
    })
    expect(changed).toMatchObject({ id: schedule.id, name: 'Afternoon brief', threadId: 'thread-a' })
  })

  it('refuses to update an id outside the runtime-owned schedule list', async () => {
    const update = vi.fn()
    const runtime = runtimeWith([schedule], update)
    await expect(updateScheduleLink(runtime, 'agent_other', {
      name: 'Other', cron: '0 1 * * *', prompt: 'Do something else.',
    })).rejects.toMatchObject({ status: 404, code: 'SCHEDULE_NOT_FOUND' })
    expect(update).not.toHaveBeenCalled()
  })
})
