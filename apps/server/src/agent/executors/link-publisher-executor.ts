import type { ActionExecutor, ActionExecutorContext, ActionResult } from '../action-worker.js'
import { LinkExecutorAttachmentStore, type WebhookExecutorCondition, type WebhookExecutorInvocationMode } from '../link-executor-attachments.js'
import type { LinkStore } from '../link-store.js'
import type { KitesurfLinkValidator } from '../link-preview.js'

export class LinkPublisherExecutor implements ActionExecutor {
  private readonly executorAttachments: LinkExecutorAttachmentStore

  constructor(
    private readonly links: LinkStore,
    private readonly validator: KitesurfLinkValidator,
  ) {
    this.executorAttachments = new LinkExecutorAttachmentStore(links.db)
  }

  async test(): Promise<{ reachable: boolean; authenticated: boolean; message: string }> {
    return {
      reachable: true,
      authenticated: true,
      message: `Papyrus Links publishes approved AgentFS snapshots and governs Webhook Action Executor attachments; webpage validation provider: ${this.validator.provider}.`,
    }
  }

  async execute(context: ActionExecutorContext): Promise<ActionResult> {
    if (context.proposal.action === 'attach_webhook_executor') return this.attachWebhookExecutor(context)
    if (context.proposal.action === 'detach_webhook_executor') return this.detachWebhookExecutor(context)
    if (context.proposal.action !== 'publish_link') throw new Error(`Papyrus Links does not support action ${context.proposal.action}`)

    const manifestPath = context.proposal.parameters?.['manifestPath']
    if (typeof manifestPath !== 'string' || !manifestPath) throw new Error('publish_link requires parameters.manifestPath')

    const manifest = await this.links.readManifest(manifestPath)
    let validationProvider: 'local-static' | 'kitesurf' = 'local-static'
    if (manifest.type === 'webpage') {
      const html = String(await this.links.filesystem.readFile(manifest.sourcePath, { encoding: 'utf8' }))
      validationProvider = (await this.validator.validateHtml(html)).provider
    } else if (manifest.type === 'api') {
      const source = String(await this.links.filesystem.readFile(manifest.sourcePath, { encoding: 'utf8' }))
      try { JSON.parse(source) } catch { throw new Error('API Link source must contain valid JSON') }
    }

    const link = await this.links.publishFromManifest(manifestPath, context.proposal.approvedByOid ?? 'system:papyrus')
    const validated = this.links.recordValidation(link.id, validationProvider)
    return {
      result: 'success',
      message: `Published ${validated.type} Link ${validated.publicPath} from approved AgentFS snapshot ${validated.sourceSha256.slice(0, 12)}; validation=${validationProvider}.`,
    }
  }

  private async attachWebhookExecutor(context: ActionExecutorContext): Promise<ActionResult> {
    const parameters = context.proposal.parameters ?? {}
    const linkId = context.proposal.target
    const executorIntegrationId = requiredString(parameters['executorIntegrationId'], 'executorIntegrationId')
    const executorAction = requiredString(parameters['executorAction'], 'executorAction')
    const executorTarget = typeof parameters['executorTarget'] === 'string' ? parameters['executorTarget'] : undefined
    const invocationMode = typeof parameters['invocationMode'] === 'string'
      ? parameters['invocationMode'] as WebhookExecutorInvocationMode
      : undefined
    const condition = objectValue(parameters['condition']) as WebhookExecutorCondition | undefined
    const inputMapping = stringMap(parameters['inputMapping'])
    const approvalPolicy = parameters['approvalPolicy'] === 'required' ? 'required' as const : 'inherit' as const
    const timeoutMs = optionalInteger(parameters['timeoutMs'])
    const maxRetries = optionalInteger(parameters['maxRetries'])

    const attachment = this.executorAttachments.attach({
      linkId,
      executorIntegrationId,
      action: executorAction,
      ...(executorTarget ? { target: executorTarget } : {}),
      ...(invocationMode ? { invocationMode } : {}),
      ...(condition ? { condition } : {}),
      ...(inputMapping ? { inputMapping } : {}),
      approvalPolicy,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(maxRetries === undefined ? {} : { maxRetries }),
    }, context.proposal.approvedByOid ?? 'system:papyrus')

    return {
      result: 'success',
      message: `Attached Action Executor ${attachment.executorName} to Webhook Link ${linkId} as ${attachment.invocationMode}; effective approval policy=${attachment.approvalPolicy}.`,
    }
  }

  private async detachWebhookExecutor(context: ActionExecutorContext): Promise<ActionResult> {
    const attachmentId = requiredString(context.proposal.parameters?.['attachmentId'], 'attachmentId')
    this.executorAttachments.detach(context.proposal.target, attachmentId)
    return {
      result: 'success',
      message: `Detached Action Executor attachment ${attachmentId} from Webhook Link ${context.proposal.target}.`,
    }
  }
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`)
  return value.trim()
}

function optionalInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function stringMap(value: unknown): Record<string, string> | undefined {
  const object = objectValue(value)
  if (!object) return undefined
  return Object.fromEntries(Object.entries(object).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}
