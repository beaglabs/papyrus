import { publicConfig } from './api.js'

type EntraBrandedPublicConfig = Awaited<ReturnType<typeof publicConfig>> & {
  /** Microsoft Entra App Registration application.info.logoUrl / legacy logoUrl. */
  microsoftAppLogoUrl?: string
}

/**
 * Hydrate only the Entra application mark used by the sidebar identity card.
 *
 * The upstream value is the exact logo URL configured on the App Registration.
 * It is rendered through Papyrus's existing authenticated image proxy so the
 * portal CSP remains `img-src 'self' data:` and no Microsoft Graph permission is
 * added merely to retrieve branding.
 */
export async function hydrateEntraAppBranding(): Promise<void> {
  try {
    const config = await publicConfig() as EntraBrandedPublicConfig
    const upstream = config.microsoftAppLogoUrl?.trim()
    if (!upstream) {
      document.documentElement.style.removeProperty('--entra-app-logo-image')
      return
    }
    const proxied = `/api/url-preview/image?url=${encodeURIComponent(upstream)}`
    document.documentElement.style.setProperty('--entra-app-logo-image', `url(${JSON.stringify(proxied)})`)
  } catch {
    // Branding is non-authoritative. Identity/auth failures are handled by App.
    document.documentElement.style.removeProperty('--entra-app-logo-image')
  }
}
