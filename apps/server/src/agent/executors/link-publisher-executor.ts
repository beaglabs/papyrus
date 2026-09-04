import type { ActionExecutor, ActionExecutorContext, ActionResult } from '../action-worker.js'
import type { LinkStore } from '../link-store.js'
import type { KitesurfLinkValidator } from '../link-preview.js'

export class LinkPublisherExecutor implements ActionExecutor {
  constructor(
    private readonly links: LinkStore,
    private readonly validator: KitesurfLinkValidator,
  ) {}

  async test(): Promise<{ reachable: boolean; authenticated: boolean; message: string }> {
    return {
      reachable: true,
      authenticated: true,
      message: `Papyrus Links publishes approved AgentFS snapshots; webpage validation provider: ${this.validator.provider}.`,
    }
  }

  async execute(context: ActionExecutorContext): Promise<ActionResult> {
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
}
