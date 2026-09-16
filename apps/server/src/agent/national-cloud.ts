/**
 * National-cloud endpoints, in one place.
 *
 * Entra and Microsoft Graph disagree about the DoD host: the authority is the
 * same for both government clouds, but Graph answers on a different name for
 * DoD. Keeping those two mappings in separate modules is what let them drift
 * apart, so both live here and are covered by one test.
 */
export type EntraCloud = 'Public' | 'USGov' | 'USGovDoD'

export const ENTRA_CLOUDS: readonly EntraCloud[] = ['Public', 'USGov', 'USGovDoD']

const AUTHORITY_HOST: Record<EntraCloud, string> = {
  Public: 'https://login.microsoftonline.com',
  USGov: 'https://login.microsoftonline.us',
  USGovDoD: 'https://login.microsoftonline.us',
}

/**
 * Microsoft Graph national cloud deployments. GCC High and DoD do not share a
 * host, so collapsing them onto `graph.microsoft.us` addresses the right cloud
 * with the wrong endpoint.
 */
const GRAPH_ORIGIN: Record<EntraCloud, string> = {
  Public: 'https://graph.microsoft.com',
  USGov: 'https://graph.microsoft.us',
  USGovDoD: 'https://dod-graph.microsoft.us',
}

export function isEntraCloud(value: unknown): value is EntraCloud {
  return typeof value === 'string' && (ENTRA_CLOUDS as readonly string[]).includes(value)
}

export function authorityHost(cloud: EntraCloud): string {
  return AUTHORITY_HOST[cloud]
}

export function graphOrigin(cloud: EntraCloud): string {
  return GRAPH_ORIGIN[cloud]
}
