import { defineChannel, type ConnectorChannelDefinition } from '../types.js'
import { GITHUB_COMMANDS, GITHUB_EVENTS, GITHUB_STATE } from './schemas.js'

export const GITHUB_CATALOG_ID = 'github'

/**
 * The GitHub channel.
 *
 * Both directions are real here. Inbound, a push or a workflow run becomes live
 * context, so a run that is watching a repository does not have to ask what
 * changed. Outbound, the agent can propose a branch, a commit, a pull request, or
 * a workflow dispatch — each of which is a typed command that an operator releases
 * through the ledger, never a call the agent makes itself.
 */
export const githubChannel: ConnectorChannelDefinition = defineChannel({
  catalogId: GITHUB_CATALOG_ID,
  version: 1,
  events: [
    {
      id: 'github.push@1',
      label: 'Push',
      description: 'Commits landed on a branch. The primary trigger for reviewing what changed on a repository.',
      schema: GITHUB_EVENTS.push,
      example: {
        repository: { fullName: 'beaglabs/papyrus', defaultBranch: 'main' },
        ref: 'refs/heads/main',
        before: '0f1e2d3c4b5a69788796a5b4c3d2e1f0a1b2c3d4',
        after: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
        commits: [{ id: 'a1b2c3d4', message: 'feat(agent): act on the request instead of interrogating the operator', author: 'operator', modified: ['apps/server/src/agent/http.ts'] }],
        pusher: 'operator',
      },
    },
    {
      id: 'github.pull_request@1',
      label: 'Pull request',
      description: 'A pull request opened, synchronized, closed, or marked ready for review.',
      schema: GITHUB_EVENTS.pullRequest,
      example: {
        repository: { fullName: 'beaglabs/papyrus', defaultBranch: 'main' },
        action: 'opened', number: 42, title: 'Fix the DoD Graph host', author: 'operator',
        headBranch: 'fix/dod-graph-host', baseBranch: 'main', draft: false,
        url: 'https://github.com/beaglabs/papyrus/pull/42',
      },
    },
    {
      id: 'github.workflow_run@1',
      label: 'Workflow run',
      description: 'A GitHub Actions run changed state. This is how a long-running job reports progress back into the session that started it.',
      schema: GITHUB_EVENTS.workflowRun,
      example: {
        repository: { fullName: 'beaglabs/papyrus', defaultBranch: 'main' },
        runId: 1042, workflow: 'ci.yml', event: 'push', status: 'completed', conclusion: 'success',
        headBranch: 'fix/dod-graph-host', headSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
        url: 'https://github.com/beaglabs/papyrus/actions/runs/1042',
      },
    },
  ],
  state: {
    id: 'github.repository@1',
    label: 'Repository state',
    description: 'Default branch, head commit, open pull requests, and recent workflow runs for the repository this session is working on.',
    schema: GITHUB_STATE,
    // Repository state moves on every push, so five minutes is already generous
    // for anything the agent should treat as current.
    maxAgeSeconds: 300,
  },
  commands: [
    {
      id: 'github.create_branch@1',
      label: 'Create branch',
      description: 'Create a branch from an existing branch or commit.',
      schema: GITHUB_COMMANDS.createBranch,
      example: { repository: 'beaglabs/papyrus', branch: 'fix/dod-graph-host', from: 'main' },
      risk: 'moderate',
    },
    {
      id: 'github.commit_file@1',
      label: 'Commit file',
      description: 'Write one file on a branch. Content is the full new file body, not a patch.',
      schema: GITHUB_COMMANDS.commitFile,
      example: { repository: 'beaglabs/papyrus', branch: 'fix/dod-graph-host', path: 'docs/note.md', content: '# Note\n', message: 'docs: add note' },
      risk: 'high',
    },
    {
      id: 'github.open_pull_request@1',
      label: 'Open pull request',
      description: 'Open a pull request from one branch into another.',
      schema: GITHUB_COMMANDS.openPullRequest,
      example: { repository: 'beaglabs/papyrus', head: 'fix/dod-graph-host', base: 'main', title: 'Fix the DoD Graph host', draft: true },
      risk: 'high',
    },
    {
      id: 'github.dispatch_workflow@1',
      label: 'Dispatch workflow',
      description: 'Start a GitHub Actions workflow. This is how a long-running job is kicked off on a repository.',
      schema: GITHUB_COMMANDS.dispatchWorkflow,
      example: { repository: 'beaglabs/papyrus', workflow: 'ci.yml', ref: 'fix/dod-graph-host', inputs: { suite: 'full' } },
      risk: 'moderate',
    },
  ],
})
