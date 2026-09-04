import type { ActionExecutor, ActionExecutorContext, ActionResult } from '../action-worker.js'
import type { LinkStore } from '../link-store.js'

export class LinkPublisherExecutor implements ActionExecutor {
  constructor(private readonly links: LinkStore) {}

  async test(): Promise<{ reachable: boolean; authenticated: boolean; message: string }> {
    return { reachable: true, authenticated: true, message: 'Papyrus Links publishes only approved AgentFS snapshots inside this daemon.' }
  }

  async execute(context: ActionExecutorContext): Promise<ActionResult> {
    if (context.proposal.action !== 'publish_link') throw new Error(`Papyrus Links does not support action ${context.proposal.action}`)
    const manifestPath = context.proposal.parameters?.['manifestPath']
    if (typeof manifestPath !== 'string' || !manifestPath) throw new Error('publish_link requires parameters.manifestPath')
    const link = await this.links.publishFromManifest(manifestPath, context.proposal.approvedByOid ?? 'system:papyrus')
    return {
      result: 'success',
      message: `Published ${link.type} Link ${link.publicPath} from approved AgentFS snapshot ${link.sourceSha256.slice(0, 12)}.`,
    }
  }
}
