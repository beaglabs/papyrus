import { createStep, createWorkflow } from '@mastra/core/workflows'
import { z } from 'zod'

const signalSchema = z.object({
  source: z.string(),
  kind: z.string(),
  summary: z.string(),
  payload: z.record(z.string(), z.unknown()).default({}),
})

const normalizedSchema = z.object({
  source: z.string(),
  kind: z.string(),
  summary: z.string(),
  receivedAt: z.string(),
  payload: z.record(z.string(), z.unknown()),
})

const normalizeSignal = createStep({
  id: 'normalize-signal-envelope',
  description: 'Validate a generic signal envelope without interpreting source data.',
  inputSchema: signalSchema,
  outputSchema: normalizedSchema,
  execute: async ({ inputData }) => ({ ...inputData, receivedAt: new Date().toISOString() }),
})

export const signalIntakeWorkflow = createWorkflow({
  id: 'signal-intake',
  description: 'Durably validate and record an inbound plugin signal before agent delivery.',
  inputSchema: signalSchema,
  outputSchema: normalizedSchema,
}).then(normalizeSignal).commit()

export const WORKFLOW_CATALOG = [{
  id: 'signal-intake',
  name: 'Signal intake',
  description: 'Validate and durably stage inbound plugin events for an agent session.',
  trigger: 'Webhook or manual run',
}] as const
