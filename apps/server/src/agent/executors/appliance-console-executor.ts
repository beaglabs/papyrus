import type { IntegrationConfiguration } from '@papyrus/contracts'
import type { AgentDatabase } from '../database.js'
import type { ActionResult, ActionExecutor, ActionExecutorContext } from '../action-worker.js'
import { extractDocument } from '../web/extract.js'
import { ConsolePolicy, ConsoleTransportError } from '../browser/policy.js'
import { ConsoleSession, openConsoleSession } from '../browser/session.js'
import { DeviceConsoleReader } from '../browser/read.js'
import type { RenderedDomSource } from '../browser/render.js'
import { ConsoleStore, type ConsoleStructureForm, type ConsoleSubmissionRecord } from '../browser/store.js'
import type { ConsoleResponse } from '../browser/session.js'
import type { CredentialLease } from '../browser/credential.js'
import { APPLIANCE_CONSOLE_CATALOG_ID } from '../catalog.js'
import type { DeviceCredentialResolver } from '../browser/credential.js'

/**
 * Runs a device console submission an operator approved.
 *
 * This is the only module in the browser boundary that puts bytes on the wire, and
 * it is reachable only from the action worker, after the ledger has released a
 * proposal. It makes no policy decision: validation, authorization, queueing, and
 * idempotency belong to the ledger. What belongs here is the one judgement the
 * ledger cannot make — whether the device still means what it meant when the
 * operator said yes.
 *
 * That judgement is made by re-reading the page the proposal was bound to and
 * comparing the form, field by field, against the snapshot that was approved.
 */
export class ApplianceConsoleExecutor implements ActionExecutor {
  constructor(
    private readonly db: AgentDatabase,
    private readonly store: ConsoleStore,
    private readonly credentials: DeviceCredentialResolver,
    /**
     * Same narrow contract the read tools get: strings in, strings out, no page
     * action reachable from it. It exists here for one reason — a submission that was
     * proposed from a rendered frame has to be re-checked against a fresh render,
     * because comparing a DOM-derived form to served bytes would void every legitimate
     * submission whose table was built by script.
     */
    private readonly renders: ((integration: IntegrationConfiguration, policy: ConsolePolicy) => RenderedDomSource | null) | null = null,
  ) {}

  async test(context: ActionExecutorContext): Promise<{ reachable: boolean; authenticated: boolean; message: string }> {
    const integration = this.integration(context)
    const policy = ConsolePolicy.forIntegration(integration, context.config)
    // A health check is a read. It reports reachability and TLS posture, and never
    // claims a device is authenticated, because nothing here has logged in.
    try {
      const reader = new DeviceConsoleReader(this.store, openConsoleSession(policy), integration)
      const page = await reader.read(policy.origin)
      return {
        reachable: true,
        authenticated: false,
        message: `${integration.name} responded HTTP ${page.status} (${page.mediaType}, ${page.bytes} bytes, snapshot ${page.pageId}); TLS verification ${policy.verifyTls ? 'on' : 'OFF'}. Login was not attempted.`,
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      return { reachable: false, authenticated: false, message: `${integration.name} console is not readable: ${message}` }
    }
  }

  /**
   * Run exactly the two actions the console tools can propose.
   *
   * The action name is checked against the recorded submission rather than trusted.
   * An approval that names one thing and carries a reference to another would
   * otherwise be executed as the thing the ledger never showed the operator.
   */
  async execute(context: ActionExecutorContext): Promise<ActionResult> {
    const integration = this.integration(context)
    const submissionId = stringValue(context.job.parameters?.submissionId)
    if (!submissionId) return { result: 'failure', message: 'The approved action carries no device submission reference, so nothing was sent.' }
    const submission = this.store.getSubmission(submissionId)
    if (!submission) return { result: 'failure', message: `Device submission ${submissionId} is not recorded, so nothing was sent.` }
    if (submission.integrationId !== integration.id) {
      return { result: 'failure', message: 'Device submission belongs to a different integration than the approved executor. Nothing was sent.' }
    }
    if (context.job.action !== 'submitDeviceConsoleForm' && context.job.action !== 'loginDeviceConsole') {
      // Unknown actions are refused before anything is read or claimed, so a
      // proposal aimed at another executor can never be run against a device row.
      return { result: 'failure', message: `Action ${context.job.action} is not a device console action, so nothing was sent.` }
    }
    const expectedKind = context.job.action === 'loginDeviceConsole' ? 'login' : 'form'
    if (submission.kind !== expectedKind) {
      // The action name and the recorded shape have to agree. An approval carrying
      // a reference to a different kind of submission is not a slightly odd
      // request, it is a mismatch between what was shown and what would run.
      return { result: 'failure', message: `The approved action is ${context.job.action} but submission ${submission.id} records a ${submission.kind} form, so nothing was sent.` }
    }
    const expectsLogin = submission.kind === 'login'
    if (!expectsLogin && submission.parameters.some((parameter) => parameter.value === null) && submission.method === 'GET') {
      // A secret cannot ride in a query string: it lands in device logs, in any
      // proxy log, and in the browser history of whoever reads them.
      return { result: 'failure', message: 'The recorded submission would put a secret in a query string, so nothing was sent.' }
    }
    if (submission.state !== 'proposed') {
      // The ledger should not hand this to us twice, but a duplicate device action
      // is worse than a stack trace, so the row's own state is the guard. A row
      // left `released` is the uncertain case: the request went out and the answer
      // is unknown, so it is reconciled by a person, never retried here.
      const explanation = submission.state === 'consumed'
        ? 'It was already sent.'
        : submission.state === 'void'
          ? 'It was voided after its page snapshot stopped matching the live form.'
          : 'Its request outcome is unknown and needs manual reconciliation.'
      return { result: 'failure', message: `Device submission ${submission.id} is ${submission.state}, so nothing was sent. ${explanation}` }
    }

    // Claim before touching the device. A run that dies mid-request leaves the row
    // `released`, which no retry can re-send: the outcome is unknown, and an
    // unknown outcome on a firewall is reconciled by a human, not retried.
    this.store.transitionSubmission(submission.id, ['proposed'], 'released')

    const policy = ConsolePolicy.forIntegration(integration, context.config)
    const session = openConsoleSession(policy)
    const renders = this.renders?.(integration, policy) ?? null
    const reader = new DeviceConsoleReader(this.store, session, integration, renders)

    const rebind = await this.rebindToLiveForm(reader, submission, renders !== null)
    if (!rebind.ok) {
      this.store.transitionSubmission(submission.id, ['released'], 'void')
      return { result: 'failure', message: `${rebind.message} The submission was voided and nothing was sent.` }
    }

    let response: ConsoleResponse
    try {
      if (expectsLogin) {
        const login = await this.loginRequest(submission, rebind.fields, integration, context.signal)
        response = await session.login(login.credential, { url: login.url, userField: login.userField, passwordField: login.passwordField, extraFields: login.extraFields })
      } else {
        const body = await this.encodeBody(submission, rebind.fields, integration, context.signal)
        response = submission.method === 'GET'
          ? await session.get(`${submission.url}${submission.url.includes('?') ? '&' : '?'}${body}`)
          : await session.post(submission.url, body, submission.enctype)
      }
    } catch (cause) {
      // Nothing reached the device in the assembly paths, so the approval can be
      // voided safely. A socket failure is different and handled below.
      const message = cause instanceof Error ? cause.message : String(cause)
      if (/did not complete|ECONNREFUSED|timed out|socket|origin/i.test(message)) {
        return {
          result: 'partial',
          message: `The request to ${submission.url} did not complete (${message}). The device may or may not have applied the change; submission ${submission.id} is held for manual reconciliation.`,
        }
      }
      this.store.transitionSubmission(submission.id, ['released'], 'void')
      return { result: 'failure', message: `The approved submission could not be sent: ${message} Nothing was sent.` }
    }

    const outcome = extractDocument({ body: response.body, mediaType: response.mediaType, url: response.url })
    const evidence = this.store.recordPage({
      integrationId: integration.id,
      url: submission.url,
      finalUrl: response.url,
      status: response.status,
      mediaType: response.mediaType,
      body: response.body,
      ...(outcome.kind === 'html' && outcome.title ? { title: outcome.title } : {}),
      structure: { forms: [], headings: [], machineContentRemoved: outcome.kind === 'html' || outcome.kind === 'xml' ? outcome.stripped.removedBytes : 0 },
    })
    this.store.transitionSubmission(submission.id, ['released'], 'consumed')

    const status = response.status >= 200 && response.status < 400 ? 'success' as const : 'failure' as const
    const excerpt = firstTextOf(outcome, 400)
    if (expectsLogin) {
      return {
        result: status,
        message: [
          `Login to ${new URL(submission.url).host} responded HTTP ${response.status}${session.authenticated ? ' and set a session cookie' : ' without setting a session cookie'}.`,
          excerpt ? `Device said: ${JSON.stringify(excerpt)}` : '',
          `Response recorded as page snapshot ${evidence.id} (sha256 ${evidence.sha256.slice(0, 16)}…).`,
          status === 'success' && !session.authenticated
            ? 'The device accepted the request but granted no session cookie, so this is reported as not authenticated.'
            : '',
          'No device password was recorded in the proposal, this message, or the snapshot.',
        ].filter(Boolean).join(' '),
      }
    }
    return {
      result: status,
      message: [
        `${submission.method} ${submission.url} responded HTTP ${response.status}.`,
        excerpt ? `Device said: ${JSON.stringify(excerpt)}` : 'The response carried no extractable text.',
        `Full response recorded as page snapshot ${evidence.id} (sha256 ${evidence.sha256.slice(0, 16)}…), ${evidence.bytes} bytes.`,
        status === 'success'
          ? 'A successful HTTP status is not proof the setting took effect; re-read the device page to confirm.'
          : 'The device rejected the submission. Nothing was retried.',
      ].join(' '),
    }
  }

  /**
   * Which field is which on an approved login.
   *
   * The proposal recorded the secret as a null value and nothing else, so the
   * executor identifies it by that null rather than by a name an operator typed. The
   * username comes from the credential lease when the form served an empty default,
   * because the operator approved "log in with this credential", not "log in as
   * blank". Hidden fields the page carried are sent as the live page serves them.
   */
  private async loginRequest(
    submission: ConsoleSubmissionRecord,
    liveFields: ConsoleStructureForm['fields'],
    integration: IntegrationConfiguration,
    signal?: AbortSignal,
  ): Promise<{ credential: CredentialLease; url: string; userField: string; passwordField: string; extraFields: Record<string, string> }> {
    const passwordField = submission.parameters.find((parameter) => parameter.role === 'secret')?.name
    if (!passwordField) {
      // Refuse rather than guess. Submitting a password into whatever field happens
      // to hold a null would put a device secret somewhere nobody approved.
      throw new ConsoleTransportError('NO_SECRET_FIELD', 'The approved login records no field marked as the secret')
    }
    const userField = submission.parameters.find((parameter) => parameter.role === 'user')?.name
    if (!userField) throw new ConsoleTransportError('NO_USER_FIELD', 'The approved login records no field marked as the account name')
    const lease = await this.credentials.resolve(integration, signal)
    if (!lease.secret) throw new ConsoleTransportError('EMPTY_CREDENTIAL', `The credential for ${integration.name} resolved to an empty secret`)
    const recorded = submission.parameters.find((parameter) => parameter.name === userField)
    const user = lease.username ?? recorded?.value ?? ''
    if (!user) throw new ConsoleTransportError('NO_USERNAME', `The credential for ${integration.name} supplied no username for field ${userField}`)
    return {
      credential: lease,
      url: submission.url,
      userField,
      passwordField,
      extraFields: Object.fromEntries(submission.parameters
        .filter((parameter) => parameter.role === undefined)
        .map((parameter) => {
          const live = liveFields.find((field) => field.name === parameter.name)
          return [parameter.name, live?.value ?? parameter.value ?? '']
        })),
    }
  }

  /**
   * Re-read the page and re-derive the exact fields to send.
   *
   * The approved parameter list is the contract: every name in it must still exist
   * on the live form, in the same position, or the submission is voided. Carried
   * hidden values are then taken from the live page rather than the snapshot,
   * because a CSRF token or page stage that rotated between approval and release is
   * still the same form — a token is not a policy decision, and refusing to send
   * because it rotated would make every approval expire on the device's schedule.
   */
  private async rebindToLiveForm(
    reader: DeviceConsoleReader,
    submission: ConsoleSubmissionRecord,
    /** Whether a browser is available to re-render a rendered submission. */
    canRender: boolean,
  ): Promise<{ ok: true; fields: ConsoleStructureForm['fields'] } | { ok: false; message: string }> {
    let live: ConsoleStructureForm | undefined
    try {
      // Re-read the page that served the form, not the action URL: a firmware
      // endpoint that accepts a POST usually answers with a result page, and the
      // question being asked here is whether the form still exists as approved.
      const sourcePage = this.store.getPage(submission.pageId)
      if (sourcePage?.source === 'rendered' && !canRender) {
        // Fail closed. The served page for a script-built form usually contains no
        // such form at all, so re-reading it as served bytes would report a change
        // that did not happen — and reporting a false change is how a real one gets
        // waved through later.
        return { ok: false, message: 'This submission was proposed from a rendered frame and no browser is configured to re-render it. Nothing was sent; re-propose against the served page or configure PAPYRUS_BROWSER_EXECUTABLE.' }
      }
      const target = sourcePage?.finalUrl ?? submission.url
      const page = sourcePage?.source === 'rendered' ? await reader.readRendered(target) : await reader.read(target)
      live = page.structure.forms.find((form) => form.id === submission.formId)
        ?? page.structure.forms.find((form) => form.method.toLowerCase() === submission.method.toLowerCase() && samePath(form.action, submission.url))
      if (!live) {
        return { ok: false, message: `The page no longer serves form ${submission.formId}; it now has ${page.structure.forms.length} form(s)` }
      }
      if (live.fields.length === 0) return { ok: false, message: `Form ${submission.formId} now serves no fields` }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      return { ok: false, message: `The target page could not be re-read (${message})` }
    }

    // Compare the live form to the approved one as an ordered name sequence, not as
    // a set. Firmware that reads a body positionally will apply an approved value to
    // whichever field happens to sit in slot three, so a re-ordered form is a
    // different submission even when every name survived.
    const liveNames = live.fields.filter((field) => !isTrigger(field)).map((field) => field.name)
    const expected = submission.parameters.map((parameter) => parameter.name)
    if (liveNames.length !== expected.length || liveNames.some((name, index) => name !== expected[index])) {
      const missing = expected.filter((name) => !liveNames.includes(name))
      const added = liveNames.filter((name) => !expected.includes(name))
      const detail = missing.length && added.length
        ? `field(s) ${missing.join(', ')} went missing and ${added.join(', ')} appeared`
        : missing.length
          ? `field(s) ${missing.join(', ')} went missing`
          : added.length
            ? `field(s) ${added.join(', ')} appeared`
            : 'fields were re-ordered'
      return { ok: false, message: `Form ${submission.formId} changed since approval: ${detail}` }
    }
    return { ok: true, fields: live.fields }
  }

  /**
   * Assemble the wire body for a policy submission, resolving a secret here only.
   *
   * The credential is fetched here — inside the one function that can reach the
   * device — encoded into the body, and never returned to a caller, a log, or the
   * ledger. If resolution fails, that failure is the blocker reported to the
   * operator, and the submission is voided rather than sent half-populated.
   */
  private async encodeBody(
    submission: ConsoleSubmissionRecord,
    liveFields: ConsoleStructureForm['fields'],
    integration: IntegrationConfiguration,
    signal?: AbortSignal,
  ): Promise<string> {
    const pairs: Array<[string, string]> = []
    for (const parameter of submission.parameters) {
      if (parameter.value !== null) {
        const carried = liveFields.find((field) => field.name === parameter.name)
        const value = carried && isCarried(carried) ? (carried.value ?? parameter.value) : parameter.value
        pairs.push([parameter.name, value])
        continue
      }
      const lease = await this.credentials.resolve(integration, signal)
      if (!lease.secret) throw new ConsoleTransportError('EMPTY_CREDENTIAL', `The credential for ${integration.name} resolved to an empty secret`)
      pairs.push([parameter.name, lease.secret])
    }
    const encoded = new URLSearchParams(pairs).toString()
    // Guard against a device field name that would let one value become two, which
    // on a firmware parser that splits on '=' first is how a name becomes a value.
    if (encoded.split('&').length !== pairs.length) {
      throw new ConsoleTransportError('UNENCODABLE_FIELD', 'A form field name or value could not be encoded as a single parameter')
    }
    return encoded
  }

  private integration(context: ActionExecutorContext): IntegrationConfiguration {
    const integration = this.db.getIntegration(context.proposal.executorIntegrationId)
    if (!integration) throw new Error('Device console executor integration not found')
    if (integration.catalogId !== APPLIANCE_CONSOLE_CATALOG_ID) {
      throw new Error(`Device console executor is registered for ${APPLIANCE_CONSOLE_CATALOG_ID}, not ${integration.catalogId}`)
    }
    if (integration.state !== 'active') throw new Error('Device console executor integration must be active')
    return integration
  }
}

function isCarried(field: ConsoleStructureForm['fields'][number]): boolean {
  return field.type === 'hidden'
}

/** A submit/image control is not a value the operator approved, so it is not "new". */
function isTrigger(field: ConsoleStructureForm['fields'][number]): boolean {
  return field.type === 'submit' || field.type === 'button' || field.type === 'image'
}

function samePath(action: string, url: string): boolean {
  try {
    return new URL(action || url, url).pathname === new URL(url).pathname
  } catch {
    return false
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** The device's own words from a response, first non-empty text, length-capped. */
function firstTextOf(outcome: ReturnType<typeof extractDocument>, limit: number): string {
  const collected: string[] = []
  if (outcome.kind === 'html') {
    for (const node of outcome.nodes) {
      if (node.kind === 'paragraph' || node.kind === 'heading' || node.kind === 'text') collected.push(node.text)
      else if (node.kind === 'pre' || node.kind === 'field') collected.push(node.kind === 'pre' ? node.text : '')
      else if (node.kind === 'list') collected.push(...node.items.map((item) => item.text))
      if (collected.join(' ').length > limit) break
    }
  } else if (outcome.kind === 'text') {
    collected.push(...outcome.blocks.map((block) => block.text))
  } else if (outcome.kind === 'delimited') {
    collected.push(...outcome.table.rows.map((row) => row.values.join(' ')))
  } else {
    collected.push(outcome.root.children.map((child) => child.kind === 'xmlText' ? child.text : '').join(' '))
  }
  const text = collected.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}
