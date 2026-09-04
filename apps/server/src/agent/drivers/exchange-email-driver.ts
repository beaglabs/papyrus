import type { ObservationInput } from '@papyrus/contracts'
import type { ConnectorContext, ConnectorDriver, ConnectorTestResult, SyncBatch } from '../sync-worker.js'
import { exchangeMailbox, type MicrosoftGraphClient } from '../graph-client.js'

function emailAddress(value: { emailAddress?: { address?: string; name?: string } } | undefined): { address?: string; name?: string } | undefined {
  const address = value?.emailAddress?.address?.trim()
  const name = value?.emailAddress?.name?.trim()
  return address || name ? { ...(address ? { address } : {}), ...(name ? { name } : {}) } : undefined
}

function recipients(values: Array<{ emailAddress?: { address?: string; name?: string } }> | undefined): Array<{ address?: string; name?: string }> {
  return (values ?? []).map(emailAddress).filter((value): value is { address?: string; name?: string } => Boolean(value))
}

/**
 * Pulls Microsoft Graph mailbox delta pages and converts email into a compact,
 * auditable HumanContext observation. It intentionally stores preview metadata
 * rather than full message bodies: a connector must be explicitly extended
 * before it moves arbitrary mailbox content into the agent twin.
 */
export class ExchangeEmailDriver implements ConnectorDriver {
  constructor(private readonly graph: MicrosoftGraphClient) {}

  async test(context: ConnectorContext): Promise<ConnectorTestResult> {
    const verified = await this.graph.testMailbox(context.integration, context.signal)
    return {
      reachable: true,
      authenticated: true,
      message: `Microsoft Graph mailbox verified for ${verified.mailbox}`,
      details: { mailbox: verified.mailbox, ...(verified.displayName ? { displayName: verified.displayName } : {}) },
    }
  }

  async sync(context: ConnectorContext): Promise<SyncBatch> {
    const page = await this.graph.listMessages(context.integration, context.cursor, context.signal)
    const observations: ObservationInput[] = page.messages.map((message) => {
      const from = emailAddress(message.from)
      const to = recipients(message.toRecipients)
      const subject = message.subject?.trim() || '(no subject)'
      return {
        // Graph ids are stable for the mailbox and provide source-level
        // idempotency even after the worker is restarted.
        sourceRecordId: message.id,
        observedAt: message.receivedDateTime,
        evidenceType: 'HumanContext',
        subject: `email:${message.internetMessageId ?? message.id}`,
        payload: {
          mailbox: exchangeMailbox(context.integration),
          messageId: message.id,
          ...(message.internetMessageId ? { internetMessageId: message.internetMessageId } : {}),
          subject,
          ...(from ? { from } : {}),
          ...(to.length ? { to } : {}),
          ...(message.bodyPreview?.trim() ? { bodyPreview: message.bodyPreview.trim().slice(0, 4_096) } : {}),
          ...(message.importance ? { importance: message.importance } : {}),
          ...(message.webLink ? { webLink: message.webLink } : {}),
        },
        terrain: { entities: [], relationships: [] },
      }
    })
    return {
      observations,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      hasMore: page.hasMore,
    }
  }
}
