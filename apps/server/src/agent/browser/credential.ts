import type { IntegrationConfiguration } from '@papyrus/contracts'

/**
 * The device credential boundary.
 *
 * Mirrors the Microsoft Graph boundary in `../graph-client.ts`: Papyrus stores an
 * opaque `credentialRef` on the integration and a customer-supplied resolver turns
 * it into a usable secret at execution time. The secret never enters the database,
 * the portal, a proposal, a snapshot, or a model-visible string — it exists only
 * inside the transport call that needs it, and is dropped when that call returns.
 *
 * That is why this interface exists at all rather than the session taking a
 * password. A tool result that carried a lease would carry a secret into chat
 * history and into the model's context, where it can be quoted back.
 */
export interface CredentialLease {
  /** Login name, when the device needs one. Not secret on most appliances, still not published. */
  readonly username?: string
  /** The password, passphrase, or shared secret. Never serialized. */
  readonly secret: string
  /** Presentation name only, for the approval transcript: `vault://appliance/sx900`. */
  readonly reference: string
}

export interface DeviceCredentialResolver {
  resolve(integration: IntegrationConfiguration, signal?: AbortSignal): Promise<CredentialLease>
}

export class DeviceCredentialUnavailableError extends Error {
  constructor(message = 'No customer credential resolver is configured for this device integration') {
    super(message)
    this.name = 'DeviceCredentialUnavailableError'
  }
}

/**
 * Safe default until the customer wires its approved vault or secrets manager.
 *
 * Refusing here is the point: a console tool that silently fell back to an
 * environment variable would put an un-managed secret on disk and out of the
 * audit trail, and the operator would never see which device it belonged to.
 */
export class UnconfiguredDeviceCredentialResolver implements DeviceCredentialResolver {
  async resolve(integration: IntegrationConfiguration): Promise<CredentialLease> {
    throw new DeviceCredentialUnavailableError(
      `No device credential resolver is configured, so ${integration.name} cannot be authenticated. `
      + 'Wire a DeviceCredentialResolver against the approved vault before any console write can run; '
      + 'reads of a login page still work.',
    )
  }
}
