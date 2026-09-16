import { z } from 'zod'

/**
 * GitHub channel shapes.
 *
 * Event schemas describe the *normalized* event, not raw provider JSON. Raw
 * webhook payloads are mapped onto these by `normalizeGithubEvent`, which keeps a
 * versioned contract the agent can rely on while the provider stays free to add
 * fields. The same split the Observation API already uses: provider payload in,
 * pinned normalized shape out.
 */

const repository = z.object({
  fullName: z.string().min(1).max(256).describe('owner/name'),
  defaultBranch: z.string().min(1).max(256),
})

const commitSummary = z.object({
  id: z.string().min(7).max(64),
  message: z.string().max(2_000),
  author: z.string().max(256).optional(),
  added: z.array(z.string().max(512)).max(200).optional(),
  modified: z.array(z.string().max(512)).max(200).optional(),
  removed: z.array(z.string().max(512)).max(200).optional(),
})

export const GITHUB_EVENTS = {
  push: z.object({
    repository,
    ref: z.string().min(1).max(256).describe('Fully qualified ref, for example refs/heads/main'),
    before: z.string().max(64).optional(),
    after: z.string().max(64),
    commits: z.array(commitSummary).max(100),
    pusher: z.string().max(256).optional(),
  }),
  pullRequest: z.object({
    repository,
    action: z.enum(['opened', 'reopened', 'closed', 'synchronize', 'ready_for_review', 'converted_to_draft', 'edited']),
    number: z.number().int().positive(),
    title: z.string().max(512),
    author: z.string().max(256).optional(),
    headBranch: z.string().max(256),
    baseBranch: z.string().max(256),
    draft: z.boolean(),
    merged: z.boolean().optional(),
    url: z.string().max(2_048).optional(),
  }),
  workflowRun: z.object({
    repository,
    runId: z.number().int().positive(),
    workflow: z.string().min(1).max(256),
    event: z.string().max(64).optional(),
    status: z.enum(['queued', 'in_progress', 'completed', 'waiting', 'requested', 'pending']),
    conclusion: z.enum(['success', 'failure', 'cancelled', 'skipped', 'timed_out', 'action_required', 'neutral']).optional(),
    headBranch: z.string().max(256).optional(),
    headSha: z.string().max(64).optional(),
    url: z.string().max(2_048).optional(),
  }),
} as const

/**
 * The connector's current view of one repository. Deliberately small: branches and
 * commits are readable on demand through tools, but the run needs to know what it
 * is working on without a round trip.
 */
export const GITHUB_STATE = z.object({
  repository: z.string().min(1).max(256),
  defaultBranch: z.string().min(1).max(256),
  headSha: z.string().max(64).optional(),
  openPullRequests: z.array(z.object({
    number: z.number().int().positive(),
    title: z.string().max(512),
    headBranch: z.string().max(256),
    draft: z.boolean(),
  })).max(100),
  latestWorkflowRuns: z.array(z.object({
    runId: z.number().int().positive(),
    workflow: z.string().max(256),
    status: z.enum(['queued', 'in_progress', 'completed', 'waiting', 'requested', 'pending']),
    conclusion: z.enum(['success', 'failure', 'cancelled', 'skipped', 'timed_out', 'action_required', 'neutral']).optional(),
  })).max(20),
  observedAt: z.string().max(64),
})

export const GITHUB_COMMANDS = {
  createBranch: z.object({
    repository: z.string().min(1).max(256).describe('owner/name'),
    branch: z.string().min(1).max(256),
    from: z.string().min(1).max(256).describe('Existing branch or commit to branch from'),
  }),
  commitFile: z.object({
    repository: z.string().min(1).max(256),
    branch: z.string().min(1).max(256),
    path: z.string().min(1).max(512),
    content: z.string().max(512_000),
    message: z.string().min(1).max(2_000),
  }),
  openPullRequest: z.object({
    repository: z.string().min(1).max(256),
    head: z.string().min(1).max(256),
    base: z.string().min(1).max(256),
    title: z.string().min(1).max(512),
    body: z.string().max(64_000).optional(),
    draft: z.boolean().optional(),
  }),
  dispatchWorkflow: z.object({
    repository: z.string().min(1).max(256),
    workflow: z.string().min(1).max(256).describe('Workflow file name or id'),
    ref: z.string().min(1).max(256),
    inputs: z.record(z.string(), z.string().max(4_000)).optional(),
  }),
} as const
