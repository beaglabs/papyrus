import type { IntegrationConfiguration } from '@papyrus/contracts'
import { extractDocument, toApiShape, type ApiOperation, type ContentSource, type ExtractedDocument, type ExtractOffset, type FormNode, type XmlElementNode } from '../web/extract.js'
import { attributedPageContent, type PageAttribution } from './attribution.js'
import { ConsoleStore, type ConsoleStructure } from './store.js'
import type { ConsoleReadTransport, ConsoleResponse } from './session.js'
import { BrowserExecutableMissingError, type RenderCookie, type RenderedDomSource, type RenderedFrame } from './render.js'

/**
 * The read half of device operation.
 *
 * Navigate, extract, and project are read-only and run immediately: they change
 * nothing on the appliance, and the operator cannot decide anything until they can
 * see what the device said. Every value here comes out of `extractDocument`, so
 * the bytes the model reads are the bytes stored in the snapshot that a later
 * proposal is checked against.
 */

/**
 * One set of bytes to extract, plus what kind of evidence they are.
 *
 * Both the served and the rendered path reduce to this so that structure, snapshot,
 * and attribution are produced by exactly one code path. Two parallel pipelines is
 * how a rendered frame ends up recorded as if it had come off the wire.
 */
export interface PageFrame {
  body: string
  /** Where these bytes came from, resolved to an absolute URL. */
  url: string
  status: number
  mediaType: string
  source: ContentSource
  truncated: boolean
  /** Rendered only: the page did not finish loading before the frame was taken. */
  incomplete?: boolean
  /** Rendered only: the URL the frame settled on, after any script navigation. */
  frameUrl?: string
}

export interface ReadPage {
  pageId: string
  /** `rendered` means the offsets index a DOM serialization, not the response. */
  source: ContentSource
  url: string
  finalUrl: string
  status: number
  mediaType: string
  sha256: string
  bytes: number
  title?: string
  kind: ExtractedDocument['kind']
  /** The attributed, model-visible rendering of the page. */
  content: string
  /** Machine-only content dropped before extraction, in bytes. */
  removedMachineContent: number
  /** Callable shape of every form on the page. Descriptions only, never a send. */
  operations: ApiOperation[]
  headings: Array<{ text: string; level: number; offset: ExtractOffset }>
  forms: Array<{ id: string; name?: string; method: string; action: string; fieldCount: number }>
  structure: ConsoleStructure
}

export class ConsoleUnreachableError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'ConsoleUnreachableError'
  }
}

export class DeviceConsoleReader {
  constructor(
    private readonly store: ConsoleStore,
    private readonly session: ConsoleReadTransport,
    private readonly integration: IntegrationConfiguration,
    /**
     * Rendering is optional in the type, not just in the configuration: the reader is
     * handed a `RenderedDomSource`, which returns strings and has no click, no type,
     * and no submit on it. Adding browser capability to the read path therefore
     * cannot silently add page *action* capability to it.
     */
    private readonly renders: RenderedDomSource | null = null,
  ) {}

  async read(url: string): Promise<ReadPage> {
    let response: ConsoleResponse
    try {
      response = await this.session.get(url)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      // A refused origin is a policy decision, not a dead device; the operator
      // needs those two answers to read differently.
      const code = /origin|endpoint|scheme/i.test(message) ? 'CONSOLE_REFUSED' : 'CONSOLE_UNREACHABLE'
      throw new ConsoleUnreachableError(code, message)
    }
    return this.ingest({
      body: response.body,
      url: response.url,
      status: response.status,
      mediaType: response.mediaType,
      source: 'served',
      truncated: response.truncated,
    }, url)
  }

  /**
   * Read a page through a browser, then extract from what the browser rendered.
   *
   * This is the only way to see a console whose tables are built by script, and it is
   * strictly a read: it navigates and serializes. The cookies passed along are the
   * session's own, for the pinned origin only, because an authenticated console
   * renders a login page otherwise and a login page has no structure worth citing.
   */
  async readRendered(url: string): Promise<ReadPage> {
    // Local copy so the null check and the call cannot disagree about what is held.
    const source = this.renders
    if (!source) throw new BrowserExecutableMissingError()
    const target = new URL(url, this.integration.endpoint ?? url).toString()
    const cookies = this.session.cookiesFor(target)
    let frame: RenderedFrame
    try {
      frame = await source.render({ url: target, cookies })
    } catch (cause) {
      if (cause instanceof BrowserExecutableMissingError) throw cause
      throw new ConsoleUnreachableError('CONSOLE_RENDER_FAILED', cause instanceof Error ? cause.message : String(cause))
    }
    return this.ingest({
      body: frame.html,
      url: frame.frameUrl,
      status: frame.status ?? 0,
      mediaType: 'text/html',
      source: 'rendered',
      truncated: false,
      incomplete: frame.settle.incomplete,
      frameUrl: frame.frameUrl,
    }, url)
  }

  /**
   * Turn a response into structure plus a durable snapshot.
   *
   * The snapshot is written before the result is returned. If the read that
   * informed an approval is not recoverable later, neither is the approval.
   */
  private ingest(frame: PageFrame, requestedUrl: string): ReadPage {
    const extracted = extractDocument({
      body: frame.body,
      mediaType: frame.mediaType,
      url: frame.url,
      source: frame.source,
    })
    const operations = toApiShape(extracted)
    const html = extracted.kind === 'html' ? extracted.nodes : []
    const forms = html.filter((node): node is FormNode => node.kind === 'form')
    const headings = html.flatMap((node) => node.kind === 'heading' ? [{ text: node.text, level: node.level, offset: node.offset }] : [])
    const structure: ConsoleStructure = {
      forms: forms.map((form) => ({
        id: form.id,
        action: form.action,
        method: form.method,
        enctype: form.enctype,
        fields: form.fields.map((field) => ({
          name: field.name,
          type: field.type,
          // A password value is never projected into the snapshot. The field is
          // still listed, because the form needs it, but a row an operator can
          // read must not be somewhere a secret lands.
          value: field.type === 'password' ? null : field.value,
          offset: field.offset,
          formId: form.id,
        })),
        offset: form.offset,
      })),
      headings: headings.map((heading) => ({ text: heading.text, offset: heading.offset })),
      machineContentRemoved: extracted.kind === 'html' || extracted.kind === 'xml' ? extracted.stripped.removedBytes : 0,
    }

    const title = extracted.kind === 'html' ? extracted.title : undefined
    const record = this.store.recordPage({
      integrationId: this.integration.id,
      // Store the absolute address, not the string that was passed in: a snapshot
      // that records `/policy.cgi` cannot be re-read by anything later.
      url: new URL(requestedUrl, frame.url).toString(),
      finalUrl: frame.url,
      status: frame.status,
      mediaType: frame.mediaType,
      body: frame.body,
      source: frame.source,
      ...(title ? { title } : {}),
      structure,
    })

    const attribution: PageAttribution = {
      source: `${this.integration.name} device console`,
      integrationId: this.integration.id,
      integrationName: this.integration.name,
      url: requestedUrl,
      finalUrl: frame.url,
      status: frame.status,
      mediaType: frame.mediaType,
      pageId: record.id,
      sha256: record.sha256,
      tlsVerified: this.session.policy.verifyTls,
      contentSource: frame.source,
      ...(frame.frameUrl ? { frameUrl: frame.frameUrl } : {}),
    }

    return {
      pageId: record.id,
      source: frame.source,
      url: requestedUrl,
      finalUrl: frame.url,
      status: frame.status,
      mediaType: frame.mediaType,
      sha256: record.sha256,
      bytes: record.bytes,
      ...(title ? { title } : {}),
      kind: extracted.kind,
      content: attributedPageContent(attribution, renderDocument(extracted, frame, structure)),
      removedMachineContent: structure.machineContentRemoved,
      operations,
      headings,
      forms: forms.map((form) => ({
        id: form.id,
        ...(form.name ? { name: form.name } : {}),
        method: form.method,
        action: form.action,
        fieldCount: form.fields.length,
      })),
      structure,
    }
  }
}

/**
 * Model-visible projection of an extracted document.
 *
 * Node ids and offsets are printed beside the text, so a quote can be checked
 * against the snapshot without the model guessing which cell it came from.
 */
export function renderDocument(extracted: ExtractedDocument, frame: PageFrame, structure: ConsoleStructure): string {
  const lines: string[] = [
    // The header is where a reader learns which bytes the offsets below index, so it
    // never claims an HTTP status for a frame that came from a DOM.
    frame.source === 'rendered'
      ? `rendered frame ${frame.mediaType} (DOM after scripts ran; not the HTTP response)${frame.incomplete ? ' — load did not finish' : ''}`
      : `HTTP ${frame.status} ${frame.mediaType}`,
  ]
  if (frame.truncated) lines.push('(the response was truncated at the byte ceiling; offsets stop there)')
  if (frame.source === 'rendered' && frame.frameUrl && frame.frameUrl !== frame.url) lines.push(`frame url ${frame.frameUrl}`)
  if (structure.machineContentRemoved > 0) {
    lines.push(`(${structure.machineContentRemoved} bytes of script, style, and comment content were removed before this projection)`)
  }
  switch (extracted.kind) {
    case 'html': {
      for (const node of extracted.nodes) {
        const at = `[${node.id}@${node.offset.byteStart}..${node.offset.byteEnd}]`
        switch (node.kind) {
          case 'heading': lines.push(`${'#'.repeat(Math.min(6, node.level))} ${node.text} ${at}`); break
          case 'paragraph': lines.push(`${node.text} ${at}`); break
          case 'text': lines.push(`${node.text} ${at}`); break
          case 'pre': lines.push('```', node.text, '```', at); break
          case 'list': lines.push(...node.items.map((item) => `- ${item.text}`), at); break
          case 'link': lines.push(`link ${JSON.stringify(node.text)} -> ${node.href} ${at}`); break
          case 'form': lines.push(`form ${node.id}: ${node.method.toUpperCase()} ${node.action || '(same page)'} — ${node.fields.length} fields ${at}`); break
          case 'field': lines.push(`  field ${node.name} type=${node.type} value=${JSON.stringify(node.value ?? '')} ${at}`); break
          case 'table': {
            lines.push(`table ${node.id} ${at}`)
            if (node.caption) lines.push(`  caption: ${node.caption}`)
            lines.push(`  ${node.columns.map((column) => column.name).join(' | ')}`)
            for (const row of node.rows) lines.push(`  ${row.cells.map((cell) => cell.text ?? (cell.missing ? '(absent)' : '(continued)')).join(' | ')}`)
            break
          }
        }
      }
      break
    }
    case 'xml':
      lines.push(...renderXml(extracted.root, 0))
      break
    case 'delimited': {
      lines.push(`delimited ${extracted.table.delimiter === '\t' ? 'tab' : JSON.stringify(extracted.table.delimiter)} separated, ${extracted.table.header ? 'first row is the header' : 'no header row'}`)
      lines.push(`  ${extracted.table.columns.map((column) => `${column.name}:${column.type}`).join(' | ')}`)
      for (const row of extracted.table.rows) {
        lines.push(`  ${row.values.map((value) => value ?? '').join(' | ')} [${row.offset.byteStart}..${row.offset.byteEnd}]`)
      }
      if (extracted.table.truncated) lines.push(`  (more rows than ${extracted.table.rows.length} were not projected)`)
      break
    }
    case 'text':
      lines.push(...extracted.blocks.map((block) => block.text))
      break
  }
  return lines.join('\n')
}

function renderXml(node: XmlElementNode, depth: number): string[] {
  const indent = '  '.repeat(depth)
  const attributes = Object.entries(node.attributes).map(([name, value]) => ` ${name}=${JSON.stringify(value)}`).join('')
  const text = node.children.find((child) => child.kind === 'xmlText')
  const onlyText = node.children.length === 1 && text?.kind === 'xmlText'
  const span = `${indent}<${node.name}${attributes}> [${node.offset.byteStart}..${node.offset.byteEnd}]`
  if (onlyText && text?.kind === 'xmlText') {
    return [`${indent}<${node.name}${attributes}> [${node.offset.byteStart}..${node.offset.byteEnd}]${text.cdata ? ' (CDATA)' : ''}: ${JSON.stringify(text.text)}`]
  }
  const lines = [node.name === '#document' ? `[root ${span.trim()}]` : span]
  for (const child of node.children) {
    if (child.kind === 'xmlText') lines.push(`${indent}  text${child.cdata ? ' (CDATA)' : ''}: ${JSON.stringify(child.text)}`)
    else lines.push(...renderXml(child, depth + 1))
  }
  return lines
}
