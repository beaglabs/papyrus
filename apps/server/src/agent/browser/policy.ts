import { readFileSync } from 'node:fs'
import type { IntegrationConfiguration } from '@papyrus/contracts'
import type { AgentConfig } from '../config.js'

/**
 * Where a device session is allowed to go, and how much it is allowed to trust.
 *
 * The public-URL SSRF guard used by `fetchUrlPreview` deliberately refuses private
 * addresses, which is right for a link a user pasted and wrong here: the whole
 * point of an appliance console is that it lives at 10.x.x.x on the management
 * network. So the guard for a console is not an address range, it is the
 * integration. A session may only ever talk to the origin an operator registered,
 * and every request that leaves the origin — including a redirect — is refused.
 */

export const TLS_VERIFY_SETTING = 'tlsVerify'
export const CA_FILE_SETTING = 'tlsCaFile'

export class ConsoleTransportError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'ConsoleTransportError'
  }
}

export class ConsolePolicy {
  private constructor(
    readonly integrationId: string,
    readonly integrationName: string,
    readonly endpoint: string,
    readonly origin: string,
    readonly verifyTls: boolean,
    readonly ca: string | undefined,
    readonly profile: AgentConfig['profile'],
  ) {}

  /**
   * Build the policy for one integration.
   *
   * TLS verification defaults to ON. Turning it off is a per-integration,
   * operator-owned setting because a self-signed appliance certificate is normal
   * and an unreachable console is useless — but the risk is real and asymmetric:
   * with verification disabled, anything on the path between the daemon and the
   * device can present a console-shaped page, and the agent will read it, quote
   * it, and build a proposal from it. On a management network that is not a
   * theoretical attacker: it is whoever already has a foot in the network the
   * firewall was supposed to protect. The correct fix is to import the appliance
   * CA (PAPYRUS_TLS_CA or the `tlsCaFile` integration setting); `tlsVerify=false`
   * trades the confidentiality and integrity of every action for convenience, so
   * it is refused outright on government and disconnected profiles, where the
   * network is part of the control boundary.
   */
  static forIntegration(integration: IntegrationConfiguration, config: AgentConfig): ConsolePolicy {
    const endpoint = integration.endpoint?.trim()
    if (!endpoint) throw new ConsoleTransportError('NO_ENDPOINT', `Integration ${integration.name} has no endpoint to open a console session against`)
    let url: URL
    try {
      url = new URL(endpoint)
    } catch {
      throw new ConsoleTransportError('BAD_ENDPOINT', `Integration ${integration.name} has an endpoint that is not an absolute URL`)
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new ConsoleTransportError('UNSUPPORTED_SCHEME', `A device console endpoint must be http or https, not ${url.protocol}`)
    }
    if (url.protocol === 'http:' && (config.profile === 'government' || config.profile === 'disconnected')) {
      throw new ConsoleTransportError('PLAINTEXT_REFUSED', `Plain http device endpoints are not permitted on the ${config.profile} profile`)
    }
    if (url.username || url.password) {
      throw new ConsoleTransportError('CREDENTIAL_IN_URL', 'A device console endpoint must not carry credentials in its URL')
    }

    const declared = integration.settings[TLS_VERIFY_SETTING]
    const verifyTls = typeof declared === 'boolean' ? declared : declared !== 'false'
    if (!verifyTls && (config.profile === 'government' || config.profile === 'disconnected')) {
      throw new ConsoleTransportError('TLS_VERIFY_REQUIRED', `tlsVerify=false is not permitted on the ${config.profile} profile; import the appliance CA instead`)
    }

    const caFile = typeof integration.settings[CA_FILE_SETTING] === 'string' ? String(integration.settings[CA_FILE_SETTING]) : undefined
    let ca: string | undefined
    if (caFile) {
      try {
        ca = readFileSync(caFile, 'utf8')
      } catch {
        throw new ConsoleTransportError('CA_UNREADABLE', `The appliance CA file ${caFile} configured for ${integration.name} could not be read`)
      }
    } else if (config.tls?.caPath) {
      try {
        ca = readFileSync(config.tls.caPath, 'utf8')
      } catch {
        throw new ConsoleTransportError('CA_UNREADABLE', `PAPYRUS_TLS_CA points at a file that could not be read: ${config.tls.caPath}`)
      }
    }

    return new ConsolePolicy(integration.id, integration.name, url.origin, url.origin, verifyTls, ca, config.profile)
  }

  originOf(url: string): string {
    try {
      return new URL(url).origin
    } catch {
      return ''
    }
  }

  /** Resolve a path against the integration origin, refusing anything else. */
  assertAllowed(url: string): URL {
    let target: URL
    try {
      target = new URL(url, this.origin)
    } catch {
      throw new ConsoleTransportError('BAD_URL', `${url} is not a usable device URL`)
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      throw new ConsoleTransportError('UNSUPPORTED_SCHEME', `${target.protocol} is not a device console protocol`)
    }
    if (target.origin !== this.origin) {
      throw new ConsoleTransportError('OFF_ORIGIN', `${target.origin} is outside the registered origin ${this.origin} for ${this.integrationName}`)
    }
    return target
  }

  /** Hostname used for SNI. Kept explicit so a future proxy cannot drop it. */
  serverName(hostname: string): string | undefined {
    return this.origin.startsWith('https:') ? hostname : undefined
  }

  get description(): string {
    return `${this.integrationName} (${this.origin}, TLS verification ${this.verifyTls ? 'on' : 'OFF'}, appliance CA ${this.ca ? 'configured' : 'system trust'})`
  }
}
