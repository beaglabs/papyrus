import type { PortalPrincipal } from '@papyrus/contracts'
import type { AgentDatabase } from '../database.js'
import type { PapyrusAgentFSFilesystem } from '../mastra/workspace-agentfs.js'
import { ensureSessionConnectorSchema } from '../session-connector-access.js'
import { PolicyError, PolicyStore } from '../policies/store.js'
import { AppStore, appFilePath } from './store.js'
import { buildApp, readProject, seedProject } from './project.js'

const MAX_FILE_BYTES = 512 * 1024
const MAX_BATCH_FILES = 64
const PROTECTED_APP_FILES = new Set(['papyrus.app.json', 'package.json', 'papyrus.lock.json'])

export interface AppFactoryScope {
  threadId: string
  actor: PortalPrincipal
}

export interface AppFactoryDependencies {
  db: AgentDatabase
  filesystem: PapyrusAgentFSFilesystem
  dataDir: string
  connectorToolNames: () => string[]
  currentScope: (context?: Record<string, unknown>) => AppFactoryScope
}

export interface AppFactoryRegistration {
  tools: Record<string, unknown>
  toolNames: string[]
  instructions: string
}

/**
 * Agent-owned authoring surface for Hosted App Links.
 *
 * These tools deliberately stop at the same governance boundaries as the HTTP
 * surface. Code Mode may compose connector reads, project edits and preview
 * builds, but it cannot approve publication or grant production connector
 * authority to itself.
 */
export function buildAppFactoryTools(
  createTool: (options: unknown) => unknown,
  dependencies: AppFactoryDependencies,
): AppFactoryRegistration {
  const store = new AppStore(dependencies.db)
  const policies = new PolicyStore(dependencies.db)

  const scope = (context?: Record<string, unknown>) => dependencies.currentScope(context)
  const requireAuthor = (context?: Record<string, unknown>) => {
    const current = scope(context)
    if (!current.actor.roles.includes('Papyrus.System.Owner') && !current.actor.roles.includes('Papyrus.Integration.Manage')) {
      throw new PolicyError('APP_AUTHOR_REQUIRED', 'Integration management is required to author App Links', 403)
    }
    return current
  }
  const ownedApp = (appId: string, context?: Record<string, unknown>) => {
    const current = requireAuthor(context)
    const app = store.get(appId)
    if (app.ownerOid !== current.actor.oid || app.sessionId !== current.threadId) {
      throw new PolicyError('APP_SESSION_REQUIRED', 'This App Link belongs to another authoring session', 403)
    }
    return { ...current, app }
  }
  const assertAppPolicy = (appId: string, operation: string, context?: Record<string, unknown>) => {
    const current = ownedApp(appId, context)
    policies.assert({
      appId: current.app.id,
      linkId: current.app.id,
      sessionId: current.threadId,
      actorOid: current.actor.oid,
      operation,
    })
    return current
  }

  const tools: Record<string, unknown> = {
    createAppLink: createTool({
      id: 'createAppLink',
      description: 'Create a draft App Link inside the current Agent session and seed its governed React project. Use this instead of asking the operator to create an app in a separate page.',
      inputSchema: {
        type: 'object', required: ['name'], additionalProperties: false,
        properties: { name: { type: 'string', minLength: 1, maxLength: 160 } },
      },
      execute: async (input: Record<string, unknown>, context?: Record<string, unknown>) => {
        const { threadId, actor } = requireAuthor(context)
        const name = String(input['name'] ?? '').trim()
        if (!name) throw new PolicyError('INVALID_APP', 'App name is required', 400)
        const app = store.create(name, actor.oid, threadId)
        await seedProject(dependencies.filesystem, app)
        const project = await readProject(dependencies.filesystem, app)
        return {
          kind: 'app_factory', phase: 'created', app,
          revision: project.revision,
          next: 'Read session connectors as needed, then author source files and build a preview.',
        }
      },
    }),

    listAppLinks: createTool({
      id: 'listAppLinks',
      description: 'List App Links owned by the authenticated operator in this authoring session, including drafts that are not published yet.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      execute: async (_input: unknown, context?: Record<string, unknown>) => {
        const { threadId, actor } = requireAuthor(context)
        return {
          kind: 'app_factory', phase: 'listed',
          apps: store.list(actor.oid).filter((app) => app.sessionId === threadId),
        }
      },
    }),

    readAppProject: createTool({
      id: 'readAppProject',
      description: 'Read the complete bounded source snapshot for an App Link in the current authoring session. Returns a revision token required for edits.',
      inputSchema: {
        type: 'object', required: ['appId'], additionalProperties: false,
        properties: { appId: { type: 'string' } },
      },
      execute: async (input: Record<string, unknown>, context?: Record<string, unknown>) => {
        const current = assertAppPolicy(String(input['appId'] ?? ''), 'app.files.read', context)
        const project = await readProject(dependencies.filesystem, current.app)
        return { kind: 'app_factory', phase: 'source', appId: current.app.id, ...project }
      },
    }),

    writeAppFiles: createTool({
      id: 'writeAppFiles',
      description: 'Apply a revision-guarded batch of source edits to an App Link. The manifest and pinned dependency files are platform-owned; author application source under src/ instead.',
      inputSchema: {
        type: 'object', required: ['appId', 'revision', 'files'], additionalProperties: false,
        properties: {
          appId: { type: 'string' }, revision: { type: 'string' },
          files: {
            type: 'array', minItems: 1, maxItems: MAX_BATCH_FILES,
            items: {
              type: 'object', required: ['path', 'content'], additionalProperties: false,
              properties: { path: { type: 'string', maxLength: 240 }, content: { type: 'string' } },
            },
          },
        },
      },
      execute: async (input: Record<string, unknown>, context?: Record<string, unknown>) => {
        const current = assertAppPolicy(String(input['appId'] ?? ''), 'app.files.write', context)
        const before = await readProject(dependencies.filesystem, current.app)
        if (before.revision !== String(input['revision'] ?? '')) {
          throw new PolicyError('REVISION_CONFLICT', 'App project changed; read it again before editing', 409)
        }
        const rawFiles = Array.isArray(input['files']) ? input['files'] : []
        if (!rawFiles.length || rawFiles.length > MAX_BATCH_FILES) throw new PolicyError('INVALID_APP_EDIT', 'Choose between 1 and 64 files', 400)
        const edits = rawFiles.map((value) => {
          const record = value && typeof value === 'object' ? value as Record<string, unknown> : {}
          const path = appFilePath(String(record['path'] ?? ''))
          const content = record['content']
          if (PROTECTED_APP_FILES.has(path)) throw new PolicyError('PLATFORM_FILE_PROTECTED', `${path} is managed by Papyrus`, 400)
          if (!path.startsWith('src/')) throw new PolicyError('APP_SOURCE_PATH_REQUIRED', 'Agent-authored App Link files must stay under src/', 400)
          if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_FILE_BYTES) throw new PolicyError('FILE_TOO_LARGE', `${path} exceeds 512 KiB`, 413)
          return { path, content }
        })
        for (const edit of edits) {
          await dependencies.filesystem.writeFile(`${current.app.projectRoot}/${edit.path}`, edit.content, { recursive: true })
        }
        const after = await readProject(dependencies.filesystem, current.app)
        return {
          kind: 'app_factory', phase: 'authored', appId: current.app.id,
          revision: after.revision, filesChanged: edits.map((edit) => edit.path),
        }
      },
    }),

    listAppAuthoringConnectors: createTool({
      id: 'listAppAuthoringConnectors',
      description: 'List connectors explicitly attached to the current Agent session plus the safe connector operations available while authoring. Presence here grants preview-time reads only; it is not a production App Link grant.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      execute: async (_input: unknown, context?: Record<string, unknown>) => {
        const { threadId, actor } = requireAuthor(context)
        ensureSessionConnectorSchema(dependencies.db)
        const rows = dependencies.db.sqlite.prepare(`SELECT catalog_id,integration_id,setup_message,updated_at
          FROM agent_session_connectors WHERE session_id=? AND actor_oid=? ORDER BY updated_at DESC`).all(threadId, actor.oid) as Array<{ catalog_id: string; integration_id?: string; setup_message?: string; updated_at: string }>
        const connectors = rows.map((row) => {
          const integration = row.integration_id ? dependencies.db.getIntegration(row.integration_id) : undefined
          return {
            catalogId: row.catalog_id,
            integrationId: row.integration_id ?? null,
            name: integration?.name ?? row.catalog_id,
            state: integration?.state ?? (row.integration_id ? 'missing' : 'setup-required'),
            setupMessage: row.setup_message ?? null,
            updatedAt: row.updated_at,
          }
        })
        return {
          kind: 'app_factory', phase: 'connectors', connectors,
          availableReadOperations: dependencies.connectorToolNames().sort(),
          productionAuthority: 'none',
        }
      },
    }),

    buildAppPreview: createTool({
      id: 'buildAppPreview',
      description: 'Compile the current App Link source in the isolated build sandbox and create an immutable preview release candidate. This does not publish it.',
      inputSchema: {
        type: 'object', required: ['appId'], additionalProperties: false,
        properties: { appId: { type: 'string' } },
      },
      execute: async (input: Record<string, unknown>, context?: Record<string, unknown>) => {
        const current = assertAppPolicy(String(input['appId'] ?? ''), 'app.build', context)
        const snapshot = await readProject(dependencies.filesystem, current.app)
        const html = await buildApp(snapshot.files, dependencies.dataDir)
        const release = store.candidate(current.app.id, snapshot.revision, html)
        return {
          kind: 'app_factory', phase: 'preview-ready', appId: current.app.id,
          releaseId: release.id, revision: snapshot.revision,
          sourceDigest: release.sourceDigest, artifactDigest: release.artifactDigest,
        }
      },
    }),

    requestAppPublication: createTool({
      id: 'requestAppPublication',
      description: 'Create a Governance proposal to publish one immutable App Link preview release. This tool cannot approve or publish the release itself.',
      inputSchema: {
        type: 'object', required: ['appId', 'releaseId'], additionalProperties: false,
        properties: { appId: { type: 'string' }, releaseId: { type: 'string' } },
      },
      execute: async (input: Record<string, unknown>, context?: Record<string, unknown>) => {
        const current = assertAppPolicy(String(input['appId'] ?? ''), 'app.publish.propose', context)
        const releaseId = String(input['releaseId'] ?? '')
        store.release(current.app.id, releaseId)
        const changeId = store.requestPublish(current.app.id, releaseId, current.actor.oid)
        return {
          kind: 'app_factory', phase: 'publication-requested', appId: current.app.id,
          releaseId, changeId, approval: 'Governance',
        }
      },
    }),

    requestAppConnectorGrant: createTool({
      id: 'requestAppConnectorGrant',
      description: 'Create a Governance proposal for explicit production connector operations used by a published App Link. Never infer wildcard authority from the authoring session.',
      inputSchema: {
        type: 'object', required: ['appId', 'integrationId', 'operations'], additionalProperties: false,
        properties: {
          appId: { type: 'string' }, integrationId: { type: 'string' },
          operations: { type: 'array', minItems: 1, maxItems: 64, items: { type: 'string', maxLength: 120 } },
        },
      },
      execute: async (input: Record<string, unknown>, context?: Record<string, unknown>) => {
        const current = assertAppPolicy(String(input['appId'] ?? ''), 'app.grant.propose', context)
        const operations = Array.isArray(input['operations']) ? input['operations'].map(String).filter(Boolean) : []
        const integrationId = String(input['integrationId'] ?? '')
        const changeId = store.requestGrant(current.app.id, integrationId, operations, current.actor.oid)
        return {
          kind: 'app_factory', phase: 'connector-grant-requested', appId: current.app.id,
          integrationId, operations, changeId, approval: 'Governance',
        }
      },
    }),
  }

  return {
    tools,
    toolNames: Object.keys(tools),
    instructions: [
      'App Links are built conversationally. Never send the operator to a separate Apps or Policies page.',
      'When the operator asks for an app, create it in the current session with createAppLink, inspect the session connectors needed for evidence/data, read the seeded project, author source under src/, and build a preview.',
      'Use app_factory_code when multiple connector reads and app-factory operations need to be composed. Connector tools execute through Papyrus on the host and retain the current session capability boundary; the generated orchestration code receives no ambient credentials.',
      'Treat the App Link project as a transitional software-factory workspace: keep iterating in the same durable session until the preview satisfies the request.',
      'Never claim publication or production connector authority after a preview build. Publication and production connector grants are Governance proposals and remain pending until approved.',
      'After creating or updating an app, identify it as an App Link and tell the operator it is available from Links for preview, management, and continued prompting.',
    ].join(' '),
  }
}
