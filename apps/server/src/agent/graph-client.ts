import type { IntegrationConfiguration } from '@papyrus/contracts'
import type { AgentConfig } from './config.js'

/**
 * Deliberately small Microsoft Graph boundary.
 *
 * Papyrus retains only an opaque credential reference. A customer deployment
 * supplies the resolver that turns that reference into a short-lived token at
 * execution time; Graph tokens and vault secrets never enter the database,
 * portal, or connector configuration.
 */
export interface GraphAccessToken {
  accessToken: string
  expiresAt?: string
}

export interface GraphCredentialResolver {
  resolve(integration: IntegrationConfiguration, signal?: AbortSignal): Promise<GraphAccessToken>
}

export class GraphCredentialUnavailableError extends Error {
  constructor(message = 'No customer credential resolver is configured for this Microsoft Graph integration') {
    super(message)
  }
}

/** Safe default until the customer wires its approved vault or workload identity. */
export class UnconfiguredGraphCredentialResolver implements GraphCredentialResolver {
  async resolve(): Promise<GraphAccessToken> {
    throw new GraphCredentialUnavailableError()
  }
}

export interface GraphMailboxTestResult {
  mailbox: string
  displayName?: string
}

export interface GraphMessage {
  id: string
  internetMessageId?: string
  receivedDateTime: string
  subject?: string
  from?: { emailAddress?: { address?: string; name?: string } }
  toRecipients?: Array<{ emailAddress?: { address?: string; name?: string } }>
  bodyPreview?: string
  body?: { contentType?: string; content?: string }
  importance?: string
  webLink?: string
}

export interface GraphMessagePage {
  messages: GraphMessage[]
  /** The Graph delta link to persist after this page has been committed. */
  nextCursor?: string
  hasMore: boolean
}

export interface SendGraphMailInput {
  mailbox: string
  to: string[]
  subject: string
  body: string
  bodyContentType?: 'Text' | 'HTML'
  /** Passed to Graph as a client request id for supportability and tracing. */
  clientRequestId: string
}

export interface SendGraphMailResult {
  requestId?: string
}

export interface MicrosoftGraphClient {
  testMailbox(integration: IntegrationConfiguration, signal?: AbortSignal): Promise<GraphMailboxTestResult>
  listMessages(integration: IntegrationConfiguration, cursor: string | undefined, signal: AbortSignal): Promise<GraphMessagePage>
  sendMail(integration: IntegrationConfiguration, input: SendGraphMailInput, signal: AbortSignal): Promise<SendGraphMailResult>
}

export function exchangeMailbox(integration: IntegrationConfiguration): string {
  const mailbox = integration.settings.mailbox
  if (typeof mailbox !== 'string' || !mailbox.trim()) {
    throw new Error('Exchange integration requires settings.mailbox')
  }
  return mailbox.trim()
}

function graphOrigin(cloud: AgentConfig['cloud']): string {
  return cloud === 'Public' ? 'https://graph.microsoft.com' : 'https://graph.microsoft.us'
}

function graphError(response: Response, body: string): Error {
  const requestId = response.headers.get('request-id') ?? response.headers.get('client-request-id')
  return new Error(`Microsoft Graph ${response.status} ${response.statusText}${requestId ? ` (request-id ${requestId})` : ''}${body ? `: ${body.slice(0, 512)}` : ''}`)
}

/**
 * HTTP implementation used in persistent deployments after a customer provides
 * a vault/workload-identity resolver. It uses Graph delta queries rather than
 * scanning a mailbox repeatedly.
 */
export class HttpMicrosoftGraphClient implements MicrosoftGraphClient {
  constructor(
    private readonly config: AgentConfig,
    private readonly credentials: GraphCredentialResolver = new UnconfiguredGraphCredentialResolver(),
    private readonly request: typeof fetch = fetch,
  ) {}

  async testMailbox(integration: IntegrationConfiguration, signal?: AbortSignal): Promise<GraphMailboxTestResult> {
    const mailbox = exchangeMailbox(integration)
    const result = await this.get(integration, `/v1.0/users/${encodeURIComponent(mailbox)}?$select=id,displayName,mail,userPrincipalName`, signal)
    const value = await result.json() as { displayName?: unknown; mail?: unknown; userPrincipalName?: unknown }
    return {
      mailbox: typeof value.mail === 'string' ? value.mail : typeof value.userPrincipalName === 'string' ? value.userPrincipalName : mailbox,
      ...(typeof value.displayName === 'string' ? { displayName: value.displayName } : {}),
    }
  }

  async listMessages(integration: IntegrationConfiguration, cursor: string | undefined, signal: AbortSignal): Promise<GraphMessagePage> {
    const mailbox = exchangeMailbox(integration)
    const url = cursor || `${graphOrigin(this.config.cloud)}/v1.0/users/${encodeURIComponent(mailbox)}/mailFolders/inbox/messages/delta?$select=id,internetMessageId,receivedDateTime,subject,from,toRecipients,bodyPreview,importance,webLink&$top=100`
    const result = await this.authorized(integration, url, { method: 'GET', headers: { Accept: 'application/json' }, signal })
    const value = await result.json() as { value?: unknown; '@odata.nextLink'?: unknown; '@odata.deltaLink'?: unknown }
    const messages = Array.isArray(value.value)
      ? value.value.filter((message): message is GraphMessage => Boolean(message && typeof message === 'object' && typeof (message as GraphMessage).id === 'string' && typeof (message as GraphMessage).receivedDateTime === 'string'))
      : []
    const nextLink = typeof value['@odata.nextLink'] === 'string' ? value['@odata.nextLink'] : undefined
    const deltaLink = typeof value['@odata.deltaLink'] === 'string' ? value['@odata.deltaLink'] : undefined
    const nextCursor = nextLink ?? deltaLink
    return { messages, ...(nextCursor ? { nextCursor } : {}), hasMore: Boolean(nextLink) }
  }

  async sendMail(integration: IntegrationConfiguration, input: SendGraphMailInput, signal: AbortSignal): Promise<SendGraphMailResult> {
    const path = `/v1.0/users/${encodeURIComponent(input.mailbox)}/sendMail`
    const response = await this.authorized(integration, new URL(path, graphOrigin(this.config.cloud)).toString(), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'client-request-id': input.clientRequestId,
        'return-client-request-id': 'true',
      },
      body: JSON.stringify({
        message: {
          subject: input.subject,
          body: { contentType: input.bodyContentType ?? 'Text', content: input.body },
          toRecipients: input.to.map((address) => ({ emailAddress: { address } })),
        },
        saveToSentItems: true,
      }),
      signal,
    })
    return { ...(response.headers.get('request-id') ? { requestId: response.headers.get('request-id') as string } : {}) }
  }

  private async get(integration: IntegrationConfiguration, path: string, signal?: AbortSignal): Promise<Response> {
    return this.authorized(integration, new URL(path, graphOrigin(this.config.cloud)).toString(), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      ...(signal ? { signal } : {}),
    })
  }

  private async authorized(integration: IntegrationConfiguration, url: string, init: RequestInit): Promise<Response> {
    const credential = await this.credentials.resolve(integration, init.signal ?? undefined)
    const response = await this.request(url, {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${credential.accessToken}` },
    })
    if (!response.ok) throw graphError(response, await response.text())
    return response
  }
}
