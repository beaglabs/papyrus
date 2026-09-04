import type { AgentConfig } from './config.js'

export interface LinkPreviewValidation {
  provider: 'local-static' | 'kitesurf'
  renderedBytes?: number
}

/**
 * Validate approved HTML before it becomes publicly reachable.
 *
 * Kitesurf is intentionally a browser/validation adapter, not the hosting
 * authority. Papyrus continues serving the approved AgentFS snapshot itself.
 * Government/restricted profiles cannot configure this external validator.
 */
export class KitesurfLinkValidator {
  constructor(private readonly config: AgentConfig) {}

  get provider(): LinkPreviewValidation['provider'] {
    return this.config.kitesurf ? 'kitesurf' : 'local-static'
  }

  async validateHtml(html: string): Promise<LinkPreviewValidation> {
    validateStaticHtml(html)
    const settings = this.config.kitesurf
    if (!settings) return { provider: 'local-static' }

    const token = process.env[settings.apiTokenEnv]?.trim()
    if (!token) throw new Error(`Kitesurf API token environment variable ${settings.apiTokenEnv} is not set`)

    const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(settings.accountId)}/browser-rendering/content?browser=kitesurf`
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ html }),
      signal: AbortSignal.timeout(20_000),
    })
    if (!response.ok) throw new Error(`Kitesurf validation returned HTTP ${response.status}`)
    const rendered = await response.text()
    if (!rendered.trim()) throw new Error('Kitesurf returned an empty rendered document')
    return { provider: 'kitesurf', renderedBytes: Buffer.byteLength(rendered) }
  }
}

export function validateStaticHtml(html: string): void {
  if (!html.trim()) throw new Error('Webpage Link HTML may not be empty')
  if (Buffer.byteLength(html) > 2 * 1024 * 1024) throw new Error('Webpage Link HTML is limited to 2 MiB')
  if (/<script\b/i.test(html)) throw new Error('Webpage Links are static: <script> is not allowed')
  if (/\son[a-z]+\s*=/i.test(html)) throw new Error('Webpage Links are static: inline event handlers are not allowed')
  if (/<base\b/i.test(html)) throw new Error('Webpage Links may not redefine the document base URL')
  if (/<iframe\b/i.test(html)) throw new Error('Webpage Links may not embed nested frames')
}
