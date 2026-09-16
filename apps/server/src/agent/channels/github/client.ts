/**
 * GitHub boundary.
 *
 * Same shape as the Graph boundary: an interface, a refusing default, and an
 * implementation that a customer deployment supplies. The mock exists because
 * "kick off a repo edit and watch a long-running workflow" must be developable and
 * testable without a live GitHub organisation, and because a workflow that takes
 * minutes is exactly the thing a test suite cannot wait for.
 *
 * Time is injected. The mock derives run status from elapsed time rather than
 * sleeping, so a test can advance a twelve-minute workflow in a microsecond.
 */

export type GithubRunStatus = 'queued' | 'in_progress' | 'completed'
export type GithubRunConclusion = 'success' | 'failure' | 'cancelled'

export interface GithubWorkflowRun {
  runId: number
  workflow: string
  ref: string
  status: GithubRunStatus
  conclusion?: GithubRunConclusion
  startedAt: string
  completedAt?: string
  url?: string
}

export interface GithubRepositoryState {
  repository: string
  defaultBranch: string
  headSha?: string
  openPullRequests: Array<{ number: number; title: string; headBranch: string; draft: boolean }>
  latestWorkflowRuns: Array<{ runId: number; workflow: string; status: GithubRunStatus; conclusion?: GithubRunConclusion }>
  observedAt: string
}

export interface GithubFile {
  path: string
  content: string
  sha: string
}

export class GithubClientError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'GithubClientError'
  }
}

export interface GithubClient {
  getRepositoryState(repository: string): Promise<GithubRepositoryState>
  listFiles(input: { repository: string; ref?: string; prefix?: string }): Promise<string[]>
  getFile(input: { repository: string; path: string; ref?: string }): Promise<GithubFile | undefined>
  createBranch(input: { repository: string; branch: string; from: string }): Promise<{ repository: string; branch: string; sha: string }>
  commitFile(input: { repository: string; branch: string; path: string; content: string; message: string }): Promise<{ repository: string; branch: string; path: string; commitId: string }>
  openPullRequest(input: { repository: string; head: string; base: string; title: string; body?: string; draft?: boolean }): Promise<{ repository: string; number: number; url: string; draft: boolean }>
  dispatchWorkflow(input: { repository: string; workflow: string; ref: string; inputs?: Record<string, string> }): Promise<{ repository: string; runId: number; workflow: string; ref: string; status: GithubRunStatus }>
  getWorkflowRun(input: { repository: string; runId: number }): Promise<GithubWorkflowRun>
  listWorkflowRuns(input: { repository: string; limit?: number }): Promise<GithubWorkflowRun[]>
}

/** Refuses by default: an unconfigured connector reaches nothing, and says why. */
export class UnconfiguredGithubClient implements GithubClient {
  private refuse(): never {
    throw new GithubClientError(
      'GITHUB_NOT_CONFIGURED',
      'No GitHub client is configured for this deployment. Supply a client backed by the customer-approved credential (a GitHub App installation or fine-grained token resolved from the customer vault) before using GitHub commands.',
    )
  }
  async getRepositoryState(): Promise<GithubRepositoryState> { this.refuse() }
  async listFiles(): Promise<string[]> { this.refuse() }
  async getFile(): Promise<GithubFile | undefined> { this.refuse() }
  async createBranch(): Promise<{ repository: string; branch: string; sha: string }> { this.refuse() }
  async commitFile(): Promise<{ repository: string; branch: string; path: string; commitId: string }> { this.refuse() }
  async openPullRequest(): Promise<{ repository: string; number: number; url: string; draft: boolean }> { this.refuse() }
  async dispatchWorkflow(): Promise<{ repository: string; runId: number; workflow: string; ref: string; status: GithubRunStatus }> { this.refuse() }
  async getWorkflowRun(): Promise<GithubWorkflowRun> { this.refuse() }
  async listWorkflowRuns(): Promise<GithubWorkflowRun[]> { this.refuse() }
}

interface MockBranch { headSha: string; files: Map<string, string>; }
interface MockRepository {
  defaultBranch: string
  branches: Map<string, MockBranch>
  pullRequests: Array<{ number: number; title: string; headBranch: string; baseBranch: string; draft: boolean; url: string }>
  runs: Array<GithubWorkflowRun & { queuedAtMs: number; durationMs: number }>
  nextRunId: number
  nextPrNumber: number
  nextCommit: number
}

export interface MockGithubClientOptions {
  /** Injected clock. Tests advance this instead of sleeping. */
  now?: () => number
  /** How long a dispatched workflow waits before starting. */
  queueDurationMs?: number
  /** How long a dispatched workflow runs before completing. */
  runDurationMs?: number
  /** Workflows that end in `failure`, so failure handling is testable too. */
  failingWorkflows?: string[]
}

/**
 * In-memory GitHub. Repositories, branches, commits, pull requests, and workflow
 * runs behave like the real thing at the level this product depends on, including
 * a workflow that is still running when you ask about it.
 */
export class MockGithubClient implements GithubClient {
  private readonly repositories = new Map<string, MockRepository>()
  private readonly now: () => number
  private readonly queueDurationMs: number
  private readonly runDurationMs: number
  private readonly failingWorkflows: Set<string>

  constructor(options: MockGithubClientOptions = {}) {
    this.now = options.now ?? Date.now
    this.queueDurationMs = options.queueDurationMs ?? 1_000
    this.runDurationMs = options.runDurationMs ?? 60_000
    this.failingWorkflows = new Set(options.failingWorkflows ?? [])
  }

  /** Seed a repository. Convenience for tests and local development. */
  seed(input: { repository: string; defaultBranch?: string; files?: Record<string, string> }): void {
    const defaultBranch = input.defaultBranch ?? 'main'
    const files = new Map(Object.entries(input.files ?? {}))
    this.repositories.set(input.repository, {
      defaultBranch,
      branches: new Map([[defaultBranch, { headSha: this.sha(`${input.repository}:${defaultBranch}`), files }]]),
      pullRequests: [],
      runs: [],
      nextRunId: 1_000,
      nextPrNumber: 1,
      nextCommit: 1,
    })
  }

  async getRepositoryState(repository: string): Promise<GithubRepositoryState> {
    const repo = this.require(repository)
    const branch = repo.branches.get(repo.defaultBranch) as MockBranch
    return {
      repository,
      defaultBranch: repo.defaultBranch,
      headSha: branch.headSha,
      openPullRequests: repo.pullRequests.map((pr) => ({ number: pr.number, title: pr.title, headBranch: pr.headBranch, draft: pr.draft })),
      latestWorkflowRuns: [...repo.runs]
        .sort((left, right) => right.runId - left.runId)
        .slice(0, 20)
        .map((run) => ({ runId: run.runId, workflow: run.workflow, status: run.status, ...(run.conclusion ? { conclusion: run.conclusion } : {}) })),
      observedAt: new Date(this.now()).toISOString(),
    }
  }

  async listFiles(input: { repository: string; ref?: string; prefix?: string }): Promise<string[]> {
    const branch = this.branch(input.repository, input.ref)
    return [...branch.files.keys()].filter((path) => !input.prefix || path.startsWith(input.prefix)).sort()
  }

  async getFile(input: { repository: string; path: string; ref?: string }): Promise<GithubFile | undefined> {
    const branch = this.branch(input.repository, input.ref)
    const content = branch.files.get(input.path)
    if (content === undefined) return undefined
    return { path: input.path, content, sha: this.sha(`${input.repository}:${input.path}:${content}`) }
  }

  async createBranch(input: { repository: string; branch: string; from: string }): Promise<{ repository: string; branch: string; sha: string }> {
    const repo = this.require(input.repository)
    if (repo.branches.has(input.branch)) throw new GithubClientError('BRANCH_EXISTS', `Branch ${input.branch} already exists in ${input.repository}`)
    const from = this.branch(input.repository, input.from)
    // A branch is a copy: later commits must not mutate the branch it came from.
    repo.branches.set(input.branch, { headSha: from.headSha, files: new Map(from.files) })
    return { repository: input.repository, branch: input.branch, sha: from.headSha }
  }

  async commitFile(input: { repository: string; branch: string; path: string; content: string; message: string }): Promise<{ repository: string; branch: string; path: string; commitId: string }> {
    const repo = this.require(input.repository)
    const branch = this.branch(input.repository, input.branch)
    branch.files.set(input.path, input.content)
    const commitId = this.sha(`${input.repository}:${input.branch}:${input.path}:${repo.nextCommit++}:${input.message}`)
    branch.headSha = commitId
    return { repository: input.repository, branch: input.branch, path: input.path, commitId }
  }

  async openPullRequest(input: { repository: string; head: string; base: string; title: string; body?: string; draft?: boolean }): Promise<{ repository: string; number: number; url: string; draft: boolean }> {
    const repo = this.require(input.repository)
    if (!repo.branches.has(input.head)) throw new GithubClientError('BRANCH_NOT_FOUND', `Head branch ${input.head} does not exist in ${input.repository}`)
    if (!repo.branches.has(input.base)) throw new GithubClientError('BRANCH_NOT_FOUND', `Base branch ${input.base} does not exist in ${input.repository}`)
    const number = repo.nextPrNumber++
    const draft = input.draft ?? false
    const url = `https://github.com/${input.repository}/pull/${number}`
    repo.pullRequests.push({ number, title: input.title, headBranch: input.head, baseBranch: input.base, draft, url })
    return { repository: input.repository, number, url, draft }
  }

  async dispatchWorkflow(input: { repository: string; workflow: string; ref: string; inputs?: Record<string, string> }): Promise<{ repository: string; runId: number; workflow: string; ref: string; status: GithubRunStatus }> {
    this.branch(input.repository, input.ref)
    const repo = this.require(input.repository)
    const runId = repo.nextRunId++
    repo.runs.push({
      runId, workflow: input.workflow, ref: input.ref, status: 'queued',
      startedAt: new Date(this.now()).toISOString(), queuedAtMs: this.now(), durationMs: this.runDurationMs,
      url: `https://github.com/${input.repository}/actions/runs/${runId}`,
    })
    return { repository: input.repository, runId, workflow: input.workflow, ref: input.ref, status: 'queued' }
  }

  async getWorkflowRun(input: { repository: string; runId: number }): Promise<GithubWorkflowRun> {
    const repo = this.require(input.repository)
    const run = repo.runs.find((candidate) => candidate.runId === input.runId)
    if (!run) throw new GithubClientError('RUN_NOT_FOUND', `No workflow run ${input.runId} in ${input.repository}`)
    return this.advance(run)
  }

  async listWorkflowRuns(input: { repository: string; limit?: number }): Promise<GithubWorkflowRun[]> {
    const repo = this.require(input.repository)
    return [...repo.runs]
      .sort((left, right) => right.runId - left.runId)
      .slice(0, input.limit ?? 20)
      .map((run) => this.advance(run))
  }

  /**
   * Derive a run's status from elapsed time. This is what makes a long-running
   * workflow observable without waiting for it: the answer changes as the clock
   * moves, exactly as it would against the real API.
   */
  private advance(run: GithubWorkflowRun & { queuedAtMs: number; durationMs: number }): GithubWorkflowRun {
    const elapsed = this.now() - run.queuedAtMs
    if (elapsed < this.queueDurationMs) return { ...run, status: 'queued' }
    if (elapsed < this.queueDurationMs + run.durationMs) return { ...run, status: 'in_progress' }
    const conclusion: GithubRunConclusion = this.failingWorkflows.has(run.workflow) ? 'failure' : 'success'
    return {
      ...run,
      status: 'completed',
      conclusion,
      completedAt: new Date(run.queuedAtMs + this.queueDurationMs + run.durationMs).toISOString(),
    }
  }

  private require(repository: string): MockRepository {
    const repo = this.repositories.get(repository)
    if (!repo) throw new GithubClientError('REPOSITORY_NOT_FOUND', `Repository ${repository} is not known to this client`)
    return repo
  }

  private branch(repository: string, ref?: string): MockBranch {
    const repo = this.require(repository)
    const name = ref ?? repo.defaultBranch
    const branch = repo.branches.get(name)
    if (!branch) throw new GithubClientError('BRANCH_NOT_FOUND', `Branch ${name} does not exist in ${repository}`)
    return branch
  }

  private sha(seed: string): string {
    let hash = 0
    for (let index = 0; index < seed.length; index += 1) {
      hash = (hash * 31 + seed.charCodeAt(index)) | 0
    }
    return Math.abs(hash).toString(16).padStart(8, '0').repeat(5).slice(0, 40)
  }
}
