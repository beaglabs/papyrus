import type { IntegrationConfiguration } from '@papyrus/contracts'
import type { CyberDatabase } from '../database.js'
import { exchangeMailbox, type MicrosoftGraphClient } from '../graph-client.js'
import type { ActionResult, ActionExecutor, ActionExecutorContext } from '../action-worker.js'

interface EmailActionParameters {
  to?: unknown
  subject?: unknown
  body?: unknown
  bodyContentType?: unknown
}

function recipients(target: string, parameters: Record<string, unknown> | undefined): string[] {
  const configured = (parameters as EmailActionParameters | undefined)?.to
  const values = Array.isArray(configured) ? configured : configured === undefined ? [target] : [configured]
  const addresses = values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0).map((value) => value.trim())
  if (!addresses.length || addresses.some((address) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address))) {
    throw new Error('Email action requires a valid recipient target or parameters.to array')
  }
  return addresses
}

function content(job: ActionExecutorContext['job']): { subject: string; body: string; bodyContentType: 'Text' | 'HTML' } {
  const parameters = (job.parameters ?? {}) as EmailActionParameters
  const subject = typeof parameters.subject === 'string' && parameters.subject.trim()
    ? parameters.subject.trim()
    : `Papyrus action: ${job.action}`
  const body = typeof parameters.body === 'string' && parameters.body.trim()
    ? parameters.body.trim()
    : `Approved Papyrus action ${job.action} was executed for ${job.target}.`
  const bodyContentType = parameters.bodyContentType === 'HTML' ? 'HTML' : 'Text'
  return { subject: subject.slice(0, 255), body: body.slice(0, 100_000), bodyContentType }
}

/**
 * Executes a specifically approved email through the same Exchange integration
 * that owns its mailbox. The executor makes no policy decision; validation,
 * authorization, queueing, and idempotency are handled by the action ledger.
 */
export class EmailExecutor implements ActionExecutor {
  constructor(private readonly db: CyberDatabase, private readonly graph: MicrosoftGraphClient) {}

  async test(context: ActionExecutorContext): Promise<{ reachable: boolean; authenticated: boolean; message: string }> {
    const integration = this.integration(context.proposal.executorIntegrationId)
    const mailbox = await this.graph.testMailbox(integration, context.signal)
    return { reachable: true, authenticated: true, message: `Microsoft Graph mail executor verified for ${mailbox.mailbox}` }
  }

  async execute(context: ActionExecutorContext): Promise<ActionResult> {
    const integration = this.integration(context.proposal.executorIntegrationId)
    const mail = content(context.job)
    const sent = await this.graph.sendMail(integration, {
      mailbox: exchangeMailbox(integration),
      to: recipients(context.job.target, context.job.parameters),
      subject: mail.subject,
      body: mail.body,
      bodyContentType: mail.bodyContentType,
      // Persisted action idempotency is supplied to Graph as a trace key.
      clientRequestId: context.job.idempotencyKey,
    }, context.signal)

    return {
      result: 'success',
      message: `Microsoft Graph accepted approved email action ${context.job.action} for ${context.job.target}${sent.requestId ? ` (request-id ${sent.requestId})` : ''}`,
    }
  }

  private integration(id: string): IntegrationConfiguration {
    const integration = this.db.getIntegration(id)
    if (!integration || integration.catalogId !== 'exchange-email' || integration.state !== 'active') {
      throw new Error('Approved email action requires an active Exchange Email integration')
    }
    return integration
  }
}
