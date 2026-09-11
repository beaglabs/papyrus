import type { AgentConfig } from '../config.js'
import type { IntegrationConfiguration } from '@papyrus/contracts'

/**
 * Where the browser binary comes from.
 *
 * There is exactly one rule in this file and everything else in the render path
 * depends on it: **Papyrus never obtains a browser.** `@mastra/browser-viewer` drives
 * `playwright-core`, whose dependency-free install deliberately contains no browser
 * binary, and the companion `agent-browser` package carries its launcher scripts
 * disabled. The moment a code path exists that resolves a default executable, the
 * next person to hit a missing browser runs a downloader, so no such path is
 * provided: an unset value is an error that names the setting, not a fallback.
 */

/** Integration setting holding an absolute path to an already-installed browser. */
export const BROWSER_EXECUTABLE_SETTING = 'browserExecutable'
/** Daemon-wide default, for a deployment that runs one browser for every console. */
export const BROWSER_EXECUTABLE_ENV = 'PAPYRUS_BROWSER_EXECUTABLE'

/**
 * Resolve the executable for one integration: per-integration setting first, then
 * the daemon environment, then nothing.
 *
 * `undefined` is a legitimate answer and callers must handle it by refusing. The
 * value is not validated to exist here, because the error that matters to an operator
 * distinguishes "not configured" from "configured with a path that is not there".
 */
export function resolveBrowserExecutable(
  integration: Pick<IntegrationConfiguration, 'settings'>,
  config?: Pick<AgentConfig, 'browser'>,
): string | undefined {
  const fromIntegration = integration.settings?.[BROWSER_EXECUTABLE_SETTING]
  if (typeof fromIntegration === 'string' && fromIntegration.trim()) return fromIntegration.trim()
  // The config field exists so a deployment can set one browser for every console.
  // Its value came from PAPYRUS_BROWSER_EXECUTABLE at the config edge.
  const fromConfig = config?.browser?.executablePath
  if (typeof fromConfig === 'string' && fromConfig.trim()) return fromConfig.trim()
  return undefined
}
