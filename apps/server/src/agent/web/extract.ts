import { decodeEntities } from './entities.js'

/**
 * Deterministic page-to-structure extraction.
 *
 * Legacy network appliances frequently have no API at all: the only interface is
 * an authenticated web UI built out of tables and forms, usually with an XML
 * status endpoint and a CSV export bolted on. This module turns any of those
 * bodies into structure the model can quote precisely. It is the single read path
 * shared by the browser console tools and plain `fetch`, and it stands alone — no
 * network, no browser engine, no third-party parser.
 *
 * Three properties are load bearing.
 *
 * 1. Offsets. Every emitted node carries a character span into the ORIGINAL body
 *    plus the matching UTF-8 byte span. Machine-only content is blanked in place
 *    rather than spliced out, so every offset still addresses the real response
 *    and a claim about a page can be checked against the page.
 * 2. Determinism. No clock, no randomness, no ordering that depends on input
 *    timing. Byte-identical input yields byte-identical output, which is what
 *    lets an approved proposal be re-verified before it is executed.
 * 3. One stripping point. See `blankMachineContent`.
 */

// ─── Public shapes ──────────────────────────────────────────────────

/** A span into the original body: UTF-16 code-unit offsets and UTF-8 byte offsets. */
export interface ExtractOffset {
  start: number
  end: number
  byteStart: number
  byteEnd: number
}

export interface HeadingNode {
  kind: 'heading'
  id: string
  level: number
  text: string
  offset: ExtractOffset
  textOffset: ExtractOffset
}

export interface ParagraphNode {
  kind: 'paragraph'
  id: string
  text: string
  offset: ExtractOffset
  textOffset: ExtractOffset
}

/** A `<pre>` block, verbatim. Whitespace is preserved because it is the content. */
export interface PreNode {
  kind: 'pre'
  id: string
  text: string
  offset: ExtractOffset
}

export interface ListNodeItem {
  text: string
  offset: ExtractOffset
}

export interface ListNode {
  kind: 'list'
  id: string
  ordered: boolean
  items: ListNodeItem[]
  offset: ExtractOffset
}

export interface LinkNode {
  kind: 'link'
  id: string
  text: string
  href: string
  /** Resolved against the document URL when the href is relative and http(s). */
  absoluteHref?: string
  offset: ExtractOffset
  textOffset: ExtractOffset
}

export interface TableColumn {
  name: string
  index: number
  offset: ExtractOffset
}

export interface TableCell {
  /** Column name this cell sits under, or null when the table has no header. */
  column: string | null
  columnIndex: number
  /** Null for a colspan/rowspan continuation, whose value lives upstream. */
  text: string | null
  offset: ExtractOffset
  header: boolean
  spanned?: boolean
  /**
   * A short row against a wider header: the device sent nothing for this column.
   * The offset cites the row the cell is absent from, because a missing cell has
   * no bytes of its own and inventing one would break the citation contract.
   */
  missing?: boolean
}

export interface TableRow {
  index: number
  cells: TableCell[]
  offset: ExtractOffset
}

export interface TableNode {
  kind: 'table'
  id: string
  caption?: string
  columns: TableColumn[]
  rows: TableRow[]
  offset: ExtractOffset
}

export interface FieldOption {
  label: string
  value: string
  selected: boolean
}

/** One named control on a page: the unit a form submission is built from. */
export interface FieldNode {
  kind: 'field'
  id: string
  /** Owner form id when the control sits inside a `<form>`. */
  formId?: string
  name: string
  /** Normalized control type. Hidden and submit are preserved, not dropped. */
  type: string
  /** Current value as the page holds it. Null means unset, e.g. a bare checkbox. */
  value: string | null
  /** Selected values for a multi-select. */
  values?: string[]
  options?: FieldOption[]
  required: boolean
  disabled: boolean
  label?: string
  offset: ExtractOffset
}

export interface FormNode {
  kind: 'form'
  id: string
  name?: string
  method: string
  action: string
  enctype: string
  fields: FieldNode[]
  offset: ExtractOffset
}

/** Human text that no heading, cell, list item, or paragraph claimed. */
export interface TextNode {
  kind: 'text'
  id: string
  text: string
  offset: ExtractOffset
}

export type HtmlNode =
  | HeadingNode
  | ParagraphNode
  | PreNode
  | ListNode
  | LinkNode
  | TableNode
  | FormNode
  | FieldNode
  | TextNode

export interface XmlTextNode {
  kind: 'xmlText'
  text: string
  /** True when the text arrived inside `<![CDATA[ … ]]>`. */
  cdata: boolean
  offset: ExtractOffset
}

export interface XmlElementNode {
  kind: 'xmlElement'
  /** Qualified name exactly as written, for example `ifm:interface`. */
  name: string
  prefix: string | null
  local: string
  /** Namespace URI resolved from in-scope xmlns declarations, when declared. */
  namespace?: string
  /** Attributes keyed by qualified name, values already entity-decoded. */
  attributes: Record<string, string>
  /** Elements and text in document order, so mixed content survives. */
  children: Array<XmlElementNode | XmlTextNode>
  offset: ExtractOffset
}

export interface DelimitedColumn {
  name: string
  index: number
  /** Best-effort type inferred from the values actually present. */
  type: 'integer' | 'number' | 'boolean' | 'date' | 'string' | 'empty'
  emptyCount: number
  sample: string | null
}

export interface DelimitedRow {
  index: number
  values: Array<string | null>
  offset: ExtractOffset
}

export interface DelimitedTable {
  delimiter: string
  /** False when the first row looked like data, so column names were synthesized. */
  header: boolean
  columns: DelimitedColumn[]
  rows: DelimitedRow[]
  truncated: boolean
}

export interface StrippedSummary {
  scripts: number
  styles: number
  comments: number
  processingInstructions: number
  noscript: number
  templates: number
  cdata: number
  eventHandlers: number
  /** Bytes blanked out of the model-visible projection. Content is not retained. */
  removedBytes: number
}

/**
 * Which bytes an extraction was measured against.
 *
 * `served` means the exact bytes the device put on the wire, so an offset cited from
 * the structure can be checked against the recorded response body. `rendered` means
 * the bytes are a browser's serialization of a live DOM after scripts ran: the
 * offsets are still exact and stable, but they index `document.documentElement.outerHTML`,
 * not the HTTP response. A reviewer who resolves a rendered offset against the raw
 * response will find nothing there, which is why every citation carries this field
 * rather than relying on the reader to remember how the page was fetched.
 */
export type ContentSource = 'served' | 'rendered'

export interface ExtractedHtmlDocument {
  kind: 'html'
  source: ContentSource
  url?: string
  mediaType: string
  title?: string
  nodes: HtmlNode[]
  stripped: StrippedSummary
}

export interface ExtractedXmlDocument {
  kind: 'xml'
  source: ContentSource
  url?: string
  mediaType: string
  /** The document element, or a synthetic `#document` root when there is not one. */
  root: XmlElementNode
  /** True when the body did not have exactly one top-level element. */
  malformed: boolean
  stripped: StrippedSummary
}

export interface ExtractedDelimitedDocument {
  kind: 'delimited'
  source: ContentSource
  url?: string
  mediaType: string
  table: DelimitedTable
}

export interface ExtractedTextDocument {
  kind: 'text'
  source: ContentSource
  url?: string
  mediaType: string
  blocks: Array<{ text: string; offset: ExtractOffset }>
}

export type ExtractedDocument =
  | ExtractedHtmlDocument
  | ExtractedXmlDocument
  | ExtractedDelimitedDocument
  | ExtractedTextDocument

export interface ExtractDocumentInput {
  body: string
  mediaType: string
  url?: string
  /** Defaults to `served`. See `ContentSource` for what the difference means. */
  source?: ContentSource
}

type MediaKind = 'html' | 'xml' | 'csv' | 'tsv' | 'json' | 'text'

/** One default in one place: bytes are served unless the caller says otherwise. */
const sourceOf = (input: ExtractDocumentInput): ContentSource => input.source ?? 'served'

/** Output ceilings. Truncation is always reported in the output, never silent. */
const MAX_NODES = 4000
const MAX_TABLE_ROWS = 500
const MAX_TEXT_CHARS = 20_000

/**
 * Turn a device response, or a rendered DOM serialization, into structure.
 *
 * Deterministic by construction: no clocks, no randomness, no iteration over
 * object-key order that depends on insertion surprises, and no network. The same
 * input — including the same `source` — produces byte-identical output.
 */
export function extractDocument(input: ExtractDocumentInput): ExtractedDocument {
  const kind = detectKind(input.mediaType, input.body)
  const source = sourceOf(input)
  const document = { source, ...(input.url ? { url: input.url } : {}) }
  // Byte offsets measure the untouched body: blanking preserves character indices
  // but replacing a multibyte character with a space does not preserve its
  // encoded length, so the original is the only valid measuring stick.
  const locator = new Locator(input.body)
  const offset: OffsetFn = (start, end) => ({
    start,
    end,
    byteStart: locator.byteAt(start),
    byteEnd: locator.byteAt(end),
  })

  switch (kind) {
    case 'html':
      return new HtmlExtractor(input, offset).run()
    case 'xml':
      return extractXml(input, offset)
    case 'csv':
    case 'tsv': {
      const delimited = extractDelimited(input, offset, kind)
      if (delimited) return delimited
      return { ...document, kind: 'text', mediaType: 'text/plain', blocks: textBlocks(input.body, offset) }
    }
    case 'json':
      return { ...document, kind: 'text', mediaType: 'application/json', blocks: textBlocks(input.body, offset) }
    case 'text':
      return { ...document, kind: 'text', mediaType: 'text/plain', blocks: textBlocks(input.body, offset) }
  }
}

/**
 * Route a response to a parser.
 *
 * The advertised media type wins. Appliances lie about content types constantly —
 * a CSV export served as `text/html` and an XML status page served as
 * `text/plain` are both routine — so an unremarkable type gets one cheap content
 * sniff rather than a plaintext dump of a table nobody can read.
 */
export function detectKind(mediaType: string, body: string): MediaKind {
  const declared = mediaType.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  if (declared === 'text/html' || declared === 'application/xhtml+xml') return 'html'
  if (declared === 'text/xml' || declared === 'application/xml' || declared.endsWith('+xml')) return 'xml'
  if (declared === 'text/csv' || declared === 'application/csv') return 'csv'
  if (declared === 'text/tab-separated-values') return 'tsv'
  if (declared === 'application/json' || declared.endsWith('+json')) return 'json'
  if (declared === '' || declared === 'text/plain' || declared === 'application/octet-stream' || declared === 'binary/octet-stream') {
    const head = body.slice(0, 4096)
    if (/^\uFEFF?<\?xml\b/i.test(head) || /^\uFEFF?<[a-z][\w:.-]*[\s>/]/i.test(head)) return 'xml'
    if (/^\uFEFF?<!doctype\s+html/i.test(head) || /<(html|body|table|form)[\s>]/i.test(head)) return 'html'
    const lines = firstNonEmptyLines(head, 5)
    if (lines.length >= 2 && lines.every((line) => line.includes('\t'))) return 'tsv'
  }
  return 'text'
}

type OffsetFn = (start: number, end: number) => ExtractOffset

// ─── Byte offsets ───────────────────────────────────────────────────

/**
 * `String.prototype.slice` counts UTF-16 code units, which makes an offset usable
 * in code but useless in a hex dump. This maps a code-unit index to its UTF-8
 * byte position with one linear precompute, so a citation can be stated in either
 * unit and stay true in both.
 */
class Locator {
  private readonly prefix: Uint32Array

  constructor(body: string) {
    this.prefix = new Uint32Array(body.length + 1)
    let bytes = 0
    for (let index = 0; index < body.length; index += 1) {
      this.prefix[index] = bytes
      const code = body.charCodeAt(index)
      if (code < 0x80) bytes += 1
      else if (code < 0x800) bytes += 2
      else if (code >= 0xd800 && code <= 0xdbff && isLowSurrogate(body.charCodeAt(index + 1))) {
        index += 1
        this.prefix[index] = bytes + 2
        bytes += 4
      } else bytes += 3
    }
    this.prefix[body.length] = bytes
  }

  byteAt(index: number): number {
    return this.prefix[Math.max(0, Math.min(index, this.prefix.length - 1))] ?? 0
  }
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

// ─── Stripping ──────────────────────────────────────────────────────

interface Blanked {
  body: string
  stripped: StrippedSummary
}

/**
 * Blank machine-only regions in place. This is the one stripping point.
 *
 * Anything on a page that exists to talk to a browser or a model rather than to a
 * human — script and style source, author comments, processing instructions,
 * `noscript` fallbacks, `template` fragments, and inline `on*` handler values —
 * has no business reaching a prompt, because a device page is untrusted input and
 * a page that can address the agent directly is a prompt-injection channel. Doing
 * it here, before any node is emitted, means every consumer inherits the same
 * decision instead of re-implementing it slightly differently.
 *
 * Every replacement is a space and the length never changes, which is the only
 * reason index-preserving offsets survive stripping. Line breaks are kept so a
 * line-number citation still lines up with the response. Only counts and a byte
 * total are reported back: quoting what was removed would re-import it.
 *
 * `<![CDATA[` is blanked for HTML and preserved for XML. In an appliance XML
 * status reply CDATA is how a device embeds a CLI block or config blob, and that
 * text is exactly what an operator wants quoted.
 */
function blankMachineContent(body: string, options: { keepCdata: boolean }): Blanked {
  const stripped: StrippedSummary = {
    scripts: 0,
    styles: 0,
    comments: 0,
    processingInstructions: 0,
    noscript: 0,
    templates: 0,
    cdata: 0,
    eventHandlers: 0,
    removedBytes: 0,
  }
  const chars = body.split('')
  const blank = (from: number, to: number): void => {
    const start = Math.max(0, from)
    const end = Math.min(to, chars.length)
    for (let index = start; index < end; index += 1) {
      const code = body.charCodeAt(index)
      if (code !== 10 && code !== 13) chars[index] = ' '
    }
    stripped.removedBytes += Math.max(0, end - start)
  }

  let index = 0
  while (index < body.length) {
    if (body.startsWith('<!--', index)) {
      const close = body.indexOf('-->', index)
      const end = close < 0 ? body.length : close + 3
      blank(index, end)
      stripped.comments += 1
      index = end
      continue
    }
    if (body.startsWith('<![CDATA[', index)) {
      const close = body.indexOf(']]>', index)
      const end = close < 0 ? body.length : close + 3
      if (options.keepCdata) {
        index = end
        continue
      }
      blank(index, end)
      stripped.cdata += 1
      index = end
      continue
    }
    if (body.startsWith('<!', index)) {
      const close = body.indexOf('>', index)
      const end = close < 0 ? body.length : close + 1
      blank(index, end)
      index = end
      continue
    }
    if (body.startsWith('<?', index)) {
      const close = body.indexOf('?>', index)
      const end = close < 0 ? body.length : close + 2
      blank(index, end)
      stripped.processingInstructions += 1
      index = end
      continue
    }
    if (body[index] === '<' && body[index + 1] !== '/') {
      const name = readTagName(body, index + 1)
      if (name) {
        const lower = name.name.toLowerCase()
        if (lower === 'script' || lower === 'style' || lower === 'noscript' || lower === 'template') {
          const end = rawElementEnd(body, lower, name.end)
          if (lower === 'script') stripped.scripts += 1
          else if (lower === 'style') stripped.styles += 1
          else if (lower === 'noscript') stripped.noscript += 1
          else stripped.templates += 1
          // Blank the whole element, delimiters included: a live `<script src=…>`
          // start tag would otherwise still be structure the tree has to carry.
          blank(index, end)
          index = end
          continue
        }
      }
    }
    index += 1
  }

  return { body: chars.join(''), stripped }
}

function readTagName(body: string, from: number): { name: string; end: number } | undefined {
  let index = from
  while (index < body.length && !/[\s/>]/.test(body[index] as string)) index += 1
  if (index === from) return undefined
  return { name: body.slice(from, index), end: index }
}

function rawElementEnd(body: string, name: string, from: number): number {
  const match = new RegExp(`</${name}\\s*>`, 'i').exec(body.slice(from))
  return match ? from + match.index + match[0].length : body.length
}

// ─── Tokenizer ──────────────────────────────────────────────────────

interface TokenAttribute {
  name: string
  value: string
}

interface OpenToken {
  kind: 'open'
  tag: string
  attributes: TokenAttribute[]
  selfClosing: boolean
  start: number
  end: number
}

interface CloseToken {
  kind: 'close'
  tag: string
  start: number
  end: number
}

interface TextToken {
  kind: 'text'
  start: number
  end: number
}

type Token = OpenToken | CloseToken | TextToken

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link',
  'meta', 'param', 'source', 'track', 'wbr',
])

const TABLE_TAGS = new Set(['table', 'tbody', 'thead', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup', 'col'])

/** Unclosed tags these implicitly end. */
const AUTO_CLOSE: Record<string, string[]> = {
  p: ['p'],
  li: ['li'],
  dt: ['dt', 'dd'],
  dd: ['dt', 'dd'],
  option: ['option'],
  optgroup: ['option', 'optgroup'],
  td: ['td', 'th'],
  th: ['td', 'th'],
  tr: ['td', 'th', 'tr'],
  thead: ['td', 'th', 'tr'],
  tbody: ['td', 'th', 'tr'],
  tfoot: ['td', 'th', 'tr'],
}

function tokenize(body: string): Token[] {
  const tokens: Token[] = []
  let index = 0
  while (index < body.length) {
    const lt = body.indexOf('<', index)
    if (lt < 0) {
      pushText(tokens, index, body.length)
      break
    }
    if (lt > index) pushText(tokens, index, lt)
    const closing = body[lt + 1] === '/'
    const name = readTagName(body, lt + (closing ? 2 : 1))
    if (!name) {
      pushText(tokens, lt, lt + 1)
      index = lt + 1
      continue
    }
    const tagEnd = findTagEnd(body, name.end)
    const end = Math.min(tagEnd + 1, body.length)
    if (closing) tokens.push({ kind: 'close', tag: name.name.toLowerCase(), start: lt, end })
    else {
      const raw = body.slice(name.end, tagEnd)
      tokens.push({
        kind: 'open',
        tag: name.name.toLowerCase(),
        attributes: parseAttributes(raw),
        selfClosing: /\/\s*$/.test(raw) || VOID_TAGS.has(name.name.toLowerCase()),
        start: lt,
        end,
      })
    }
    index = end
  }
  return tokens
}

function pushText(tokens: Token[], start: number, end: number): void {
  if (end > start) tokens.push({ kind: 'text', start, end })
}

function findTagEnd(body: string, from: number): number {
  let index = from
  while (index < body.length) {
    const char = body[index] as string
    if (char === '"' || char === "'") {
      index += 1
      while (index < body.length && (body[index] as string) !== char) index += 1
      index += 1
      continue
    }
    if (char === '>') return index
    index += 1
  }
  return body.length
}

/**
 * Parse tag attributes, dropping inline event handlers.
 *
 * An `on*` attribute is script source wearing an attribute's clothing: it is the
 * one place JavaScript survives a `<script>` strip, so it is dropped at the same
 * boundary rather than smuggled through as a field value.
 */
function parseAttributes(raw: string): TokenAttribute[] {
  const attributes: TokenAttribute[] = []
  const pattern = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]*)))?/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(raw))) {
    const name = match[1]
    if (!name) continue
    const lower = name.toLowerCase()
    if (lower === 'href' && /^(javascript|data|vbscript):/i.test(match[2] ?? match[3] ?? match[4] ?? '')) continue
    if (/^on[a-z]+$/.test(lower)) continue
    attributes.push({ name: lower, value: decodeEntities(match[2] ?? match[3] ?? match[4] ?? '') })
  }
  return attributes
}

// ─── Tree ───────────────────────────────────────────────────────────

interface TextChunk {
  type: 'text'
  value: string
  start: number
  end: number
}

interface Element {
  type: 'element'
  tag: string
  attributes: Record<string, string>
  children: Array<Element | TextChunk>
  /** Offset of the `<` that opened this element. */
  start: number
  /** Offset just past this element's own `>`, open tag or close tag. */
  end: number
  /** True for the synthesized document root, which has no tag of its own. */
  synthetic: boolean
}

function makeElement(tag: string, start: number, end: number): Element {
  return { type: 'element', tag, attributes: {}, children: [], start, end, synthetic: false }
}

/**
 * Build a tree with light error recovery.
 *
 * Deliberately not spec-complete: appliance markup is table soup with unclosed
 * `<p>` and `<td>` tags, and the useful behaviour is to keep the content and the
 * offsets rather than to fail the way a strict parser would.
 */
function buildTree(body: string, tokens: Token[]): Element {
  const root = makeElement('#document', 0, body.length)
  root.synthetic = true
  const stack: Element[] = [root]
  const top = (): Element => stack[stack.length - 1] as Element

  const closeTo = (tag: string, end: number, stopAt?: string[]): boolean => {
    for (let index = stack.length - 1; index > 0; index -= 1) {
      const candidate = (stack[index] as Element).tag
      // Table tags never reach past a table boundary: otherwise a `<tr>` in a
      // nested table silently closes the cell holding it, and two tables merge
      // into one that is wrong in a way nothing downstream can detect. The frame
      // being closed is not a boundary against itself.
      if (candidate !== tag && stopAt?.includes(candidate)) return false
      if (candidate !== tag) continue
      const closed = stack.splice(index)[0] as Element
      closed.end = end
      stack.length = index
      return true
    }
    return false
  }

  for (const token of tokens) {
    if (token.kind === 'text') {
      top().children.push({ type: 'text', value: body.slice(token.start, token.end), start: token.start, end: token.end })
      continue
    }
    if (token.kind === 'close') {
      // An unmatched close tag is noise; the content it claims to end is already
      // attached higher up, so dropping the tag loses nothing.
      closeTo(token.tag, token.end, TABLE_TAGS.has(token.tag) ? ['table'] : undefined)
      continue
    }
    if (token.tag === 'br') {
      // A hard break is content, not structure: it becomes a newline so console
      // text reads the way the appliance laid it out.
      top().children.push({ type: 'text', value: '\n', start: token.start, end: token.end })
      continue
    }
    const boundary = TABLE_TAGS.has(token.tag) ? ['table'] : undefined
    for (const tag of AUTO_CLOSE[token.tag] ?? []) closeTo(tag, token.start, boundary)
    const node = makeElement(token.tag, token.start, token.end)
    for (const attribute of token.attributes) node.attributes[attribute.name] = attribute.value
    top().children.push(node)
    if (!token.selfClosing) stack.push(node)
  }

  while (stack.length > 1) (stack.pop() as Element).end = body.length
  return root
}

function indexParents(node: Element, parents: Map<Element, Element>): void {
  for (const child of node.children) {
    if (child.type !== 'element') continue
    parents.set(child, node)
    indexParents(child, parents)
  }
}

function collectText(node: Element, out: TextChunk[], stopAtNestedTable = false): void {
  for (const child of node.children) {
    if (child.type === 'text') {
      out.push(child)
      continue
    }
    // A cell that contains a table holds that table as its own node, so inlining
    // every row into the cell text would bury the outer page's own words.
    if (stopAtNestedTable && child.tag === 'table') continue
    collectText(child, out, stopAtNestedTable)
  }
}

function childElements(node: Element): Element[] {
  return node.children.filter((child): child is Element => child.type === 'element')
}

function findTag(node: Element, tag: string): Element | undefined {
  for (const child of childElements(node)) {
    if (child.tag === tag) return child
    const nested = findTag(child, tag)
    if (nested) return nested
  }
  return undefined
}

function textOf(node: Element): string {
  const chunks: TextChunk[] = []
  collectText(node, chunks)
  return chunks.map((chunk) => chunk.value).join('')
}

function rawTextOf(node: Element): string {
  return decodeEntities(textOf(node)).replace(/\r\n/g, '\n').replace(/\n$/, '')
}

function hasFlag(node: Element, attribute: string): boolean {
  return node.attributes[attribute] !== undefined
}

// ─── HTML extraction ────────────────────────────────────────────────

/**
 * Depth-first structural pass.
 *
 * A node is emitted by the first classifier that claims it and its subtree is
 * then consumed, which is what keeps a heading inside a table cell from appearing
 * both as a heading and as cell text.
 */
class HtmlExtractor {
  private readonly blanked: string
  private readonly stripped: StrippedSummary
  private readonly root: Element
  private readonly parents = new Map<Element, Element>()
  private readonly labels = new Map<string, string>()
  private readonly nodes: HtmlNode[] = []
  private readonly consumed = new Set<Element>()
  private counter = 0

  constructor(private readonly input: ExtractDocumentInput, private readonly offset: OffsetFn) {
    const blanked = blankMachineContent(input.body, { keepCdata: false })
    this.blanked = blanked.body
    this.stripped = blanked.stripped
    this.root = buildTree(this.blanked, tokenize(this.blanked))
    indexParents(this.root, this.parents)
    for (const label of findAllTags(this.root, 'label')) {
      const forId = label.attributes['for']
      const text = this.textSpan(label).text
      if (forId && text && !this.labels.has(forId)) this.labels.set(forId, text)
    }
  }

  run(): ExtractedHtmlDocument {
    this.walk(this.root, false)
    const title = findTag(this.root, 'title')
    const text = title ? collapseWhitespace(textOf(title)) : ''
    return {
      ...(this.input.url ? { url: this.input.url } : {}),
      kind: 'html',
      source: sourceOf(this.input),
      mediaType: 'text/html',
      ...(text ? { title: text } : {}),
      nodes: this.nodes,
      stripped: this.stripped,
    }
  }

  private nextId(prefix: string): string {
    this.counter += 1
    return `${prefix}${this.counter}`
  }

  private walk(node: Element, inForm: boolean): void {
    if (this.nodes.length >= MAX_NODES) return
    if (this.consumed.has(node)) return

    switch (node.tag) {
      case 'table': {
        const table = this.tableNode(node)
        if (table) {
          consume(node, this.consumed)
          this.nodes.push(table)
          // Appliance pages put tables inside table cells. The outer cell keeps
          // its own words; the inner table is still structure worth reading, so it
          // is walked as its own node instead of being consumed with the parent.
          for (const nested of findAllTags(node, 'table')) {
            this.consumed.delete(nested)
            this.walk(nested, inForm)
          }
          return
        }
        break
      }
      case 'form': {
        const form = this.formNode(node)
        consume(node, this.consumed)
        this.nodes.push(form)
        // Fields were collected with the form; the rest of the subtree still gets
        // read, because an appliance form wraps the table that describes it.
        this.consumed.delete(node)
        for (const child of childElements(node)) this.walkChild(child, true)
        return
      }
      case 'pre': {
        consume(node, this.consumed)
        this.nodes.push({ kind: 'pre', id: this.nextId('pre'), text: truncate(rawTextOf(node)), offset: this.offset(node.start, node.end) })
        return
      }
      case 'ul':
      case 'ol': {
        const items = this.listItems(node)
        consume(node, this.consumed)
        if (items.length) {
          this.nodes.push({ kind: 'list', id: this.nextId('list'), ordered: node.tag === 'ol', items, offset: this.offset(node.start, node.end) })
        }
        return
      }
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
        consume(node, this.consumed)
        const span = this.textSpan(node)
        if (span.text) {
          this.nodes.push({
            kind: 'heading',
            id: this.nextId('h'),
            level: Number(node.tag.slice(1)),
            text: truncate(span.text),
            offset: this.offset(node.start, node.end),
            textOffset: this.offset(span.start, span.end),
          })
        }
        return
      }
      case 'p':
      case 'blockquote': {
        consume(node, this.consumed)
        const span = this.textSpan(node)
        if (span.text) {
          this.nodes.push({
            kind: 'paragraph',
            id: this.nextId('p'),
            text: truncate(span.text),
            offset: this.offset(node.start, node.end),
            textOffset: this.offset(span.start, span.end),
          })
        }
        return
      }
      case 'a': {
        consume(node, this.consumed)
        const href = node.attributes['href']
        const span = this.textSpan(node)
        if (href && href.trim() && !href.trim().startsWith('#')) {
          this.nodes.push({
            kind: 'link',
            id: this.nextId('link'),
            text: truncate(span.text || href),
            href,
            ...absoluteHref(href, this.input.url),
            offset: this.offset(node.start, node.end),
            textOffset: this.offset(span.start, span.end),
          })
        } else if (span.text) {
          // A named anchor carries no destination, but its text is still on the page.
          this.nodes.push({ kind: 'text', id: this.nextId('t'), text: truncate(span.text), offset: this.offset(span.start, span.end) })
        }
        return
      }
      case 'input': case 'select': case 'textarea': case 'button': {
        consume(node, this.consumed)
        if (!inForm) {
          const field = this.fieldNode(node, undefined)
          if (field) this.nodes.push(field)
        }
        return
      }
      default:
        break
    }

    const own = node.children.filter((child): child is TextChunk => child.type === 'text' && child.value.trim().length > 0)
    if (own.length && !node.synthetic) {
      const span = this.textSpan(node, true)
      if (span.text) {
        this.nodes.push({ kind: 'text', id: this.nextId('t'), text: truncate(span.text), offset: this.offset(span.start, span.end) })
      }
    }
    for (const child of node.children) {
      if (child.type === 'element') this.walk(child, inForm)
    }
  }

  private walkChild(child: Element, inForm: boolean): void {
    if (child.tag === 'input' || child.tag === 'select' || child.tag === 'textarea' || child.tag === 'button') return
    // The form subtree was marked consumed as a whole; clear just this node so the
    // structural walk can still read the table the form wraps.
    this.consumed.delete(child)
    this.walk(child, inForm)
  }

  /**
   * Visible text of a subtree plus the span covering it.
   *
   * `directOnly` narrows to this element's own text nodes, which is how a
   * container keeps a label line apart from the controls nested inside it.
   */
  private textSpan(node: Element, directOnly = false): { text: string; start: number; end: number } {
    const chunks: TextChunk[] = []
    if (directOnly) {
      for (const child of node.children) if (child.type === 'text') chunks.push(child)
    } else {
      collectText(node, chunks, true)
    }
    const printable = chunks.filter((chunk) => chunk.value.trim().length > 0)
    if (!printable.length) return { text: '', start: node.start, end: node.start }
    let joined = ''
    for (const chunk of printable) joined += chunk.value
    const first = printable[0] as TextChunk
    const last = printable[printable.length - 1] as TextChunk
    let start = first.start
    while (start < first.end && !/\S/.test(first.value.charAt(start - first.start))) start += 1
    let end = last.end
    while (end > last.start && !/\S/.test(last.value.charAt(end - last.start - 1))) end -= 1
    return { text: collapseWhitespace(joined), start, end: Math.max(start, end) }
  }

  private listItems(node: Element): ListNodeItem[] {
    const items: ListNodeItem[] = []
    for (const child of childElements(node)) {
      if (child.tag !== 'li') continue
      const span = this.textSpan(child)
      if (span.text) items.push({ text: truncate(span.text), offset: this.offset(span.start, span.end) })
    }
    return items.slice(0, 500)
  }

  private formNode(node: Element): FormNode {
    const id = this.nextId('form')
    const fields: FieldNode[] = []
    const collect = (current: Element): void => {
      for (const child of childElements(current)) {
        if (child.tag === 'form') continue
        if (child.tag === 'input' || child.tag === 'select' || child.tag === 'textarea' || child.tag === 'button') {
          const field = this.fieldNode(child, id)
          if (field) fields.push(field)
          continue
        }
        collect(child)
      }
    }
    collect(node)
    return {
      kind: 'form',
      id,
      ...(node.attributes['name'] ? { name: node.attributes['name'] } : {}),
      method: (node.attributes['method'] ?? 'get').toLowerCase(),
      action: node.attributes['action'] ?? '',
      enctype: (node.attributes['enctype'] ?? 'application/x-www-form-urlencoded').toLowerCase(),
      fields,
      offset: this.offset(node.start, node.end),
    }
  }

  private fieldNode(node: Element, formId: string | undefined): FieldNode | undefined {
    const name = node.attributes['name']
    if (!name || !name.trim()) return undefined
    const type = normalizeFieldType(node)
    const options = type === 'select-one' || type === 'select-multiple'
      ? fieldOptions(node)
      : type === 'checkbox' || type === 'radio'
        ? checkboxOption(node)
        : undefined
    const values = options?.filter((option) => option.selected).map((option) => option.value) ?? []
    const label = this.labelFor(node)
    return {
      kind: 'field',
      id: this.nextId('field'),
      ...(formId ? { formId } : {}),
      name: decodeEntities(name),
      type,
      value: fieldValue(node, type, options ?? []),
      ...(type === 'select-multiple' ? { values } : {}),
      ...(options && options.length ? { options } : {}),
      required: hasFlag(node, 'required') || node.attributes['aria-required'] === 'true',
      disabled: hasFlag(node, 'disabled') || hasFlag(node, 'readonly'),
      ...(label ? { label: truncate(label) } : {}),
      offset: this.offset(node.start, node.end),
    }
  }

  /**
   * Recover what a control is for.
   *
   * `<label for>` when present; otherwise the preceding table cell, which is how
   * nearly every appliance console labels a field — the layout *is* the label.
   */
  private labelFor(node: Element): string | undefined {
    const id = node.attributes['id']
    if (id && this.labels.has(id)) return this.labels.get(id)
    // `for` binds to an id in real HTML. Appliance markup routinely writes
    // `<label for="ruleName">` beside `<input name="ruleName">` with no id at
    // all, and a label recovered that way beats telling the model there is none.
    if (this.labels.has(node.attributes['name'] ?? '')) return this.labels.get(node.attributes['name'] as string)
    const aria = node.attributes['aria-label']
    if (aria?.trim()) return aria
    let ancestor = this.parents.get(node)
    while (ancestor) {
      if (ancestor.tag === 'label') {
        const own = this.textSpan(ancestor)
        const withoutControl = own.text.replace(collapseWhitespace(textOf(node)), '').trim()
        if (withoutControl) return withoutControl
      }
      ancestor = this.parents.get(ancestor)
    }
    const cell = this.parents.get(node)
    const row = cell ? this.parents.get(cell) : undefined
    if (cell && row && cell.tag === 'td' && row.tag === 'tr') {
      const cells = childElements(row).filter((child) => child.tag === 'td' || child.tag === 'th')
      const index = cells.indexOf(cell)
      const previous = index > 0 ? cells[index - 1] : undefined
      if (previous) {
        const span = this.textSpan(previous)
        if (span.text) return span.text
      }
    }
    return undefined
  }

  /**
   * Lay declared cells onto a grid.
   *
   * `colspan` and `rowspan` shift every following cell in a naive scrape, which
   * silently labels a column with the wrong header. Expanding spans onto grid
   * positions first is what keeps `column` truthful, and a short row against a
   * wider header becomes an explicit missing cell instead of a shifted value.
   */
  private tableNode(node: Element): TableNode | undefined {
    const rows = collectRows(node)
    if (!rows.length) return undefined

    const grid: PlannedRow[] = []
    const carry = new Map<number, { element: Element; remaining: number }>()
    for (const row of rows) {
      const planned: PlannedRow = []
      let column = 0
      for (const cell of childElements(row).filter((child) => child.tag === 'td' || child.tag === 'th')) {
        while ((carry.get(column)?.remaining ?? 0) > 0) {
          const carried = carry.get(column) as { element: Element; remaining: number }
          planned[column] = { element: carried.element, continuation: true }
          carry.set(column, { element: carried.element, remaining: carried.remaining - 1 })
          column += 1
        }
        const colspan = spanOf(cell, 'colspan')
        const rowspan = spanOf(cell, 'rowspan')
        for (let index = column; index < column + colspan; index += 1) {
          planned[index] = { element: cell, continuation: index !== column }
          if (rowspan > 1) carry.set(index, { element: cell, remaining: rowspan - 1 })
        }
        column += colspan
      }
      grid.push(planned)
    }

    const width = grid.reduce((widest, row) => Math.max(widest, row.length), 0)
    if (!width) return undefined
    const headerIndex = this.pickHeaderRow(grid, width)
    // A colspan header covers every column it spans, so its name carries across
    // the span: the value under it really is that kind of thing.
    const names: Array<string | null> = []
    const columns: TableColumn[] = []
    let carriedName: string | null = null
    for (let index = 0; index < width; index += 1) {
      const entry = headerIndex >= 0 ? grid[headerIndex]?.[index] : undefined
      if (!entry?.continuation) carriedName = entry ? this.textSpan(entry.element).text : ''
      const name = carriedName
      names.push(name || null)
      const source = entry?.element ?? node
      columns.push({
        name: name ? truncate(name) : `column${index + 1}`,
        index,
        offset: this.offset(source.start, source.end),
      })
    }

    const tableRows: TableRow[] = []

    for (const [rowIndex, row] of rows.entries()) {
      if (rowIndex === headerIndex) continue
      if (tableRows.length >= MAX_TABLE_ROWS) break
      const cells: TableCell[] = []
      for (let index = 0; index < width; index += 1) {
        const entry = grid[rowIndex]?.[index]
        if (!entry) {
          cells.push({ column: names[index] ?? null, columnIndex: index, text: null, offset: this.offset(row.start, row.end), header: false, missing: true })
          continue
        }
        cells.push({
          column: names[index] ?? null,
          columnIndex: index,
          text: entry.continuation ? null : truncate(this.textSpan(entry.element).text),
          offset: this.offset(entry.element.start, entry.element.end),
          header: entry.element.tag === 'th',
          ...(entry.continuation ? { spanned: true } : {}),
        })
      }
      tableRows.push({ index: tableRows.length, cells, offset: this.offset(row.start, row.end) })
    }

    const caption = childElements(node).find((child) => child.tag === 'caption')
    const captionText = caption ? this.textSpan(caption).text : ''
    return {
      kind: 'table',
      id: this.nextId('table'),
      ...(captionText ? { caption: truncate(captionText) } : {}),
      columns,
      rows: tableRows,
      offset: this.offset(node.start, node.end),
    }
  }

  /**
   * Choose the header row, or -1 when the table is a key/value stack.
   *
   * A `th` row wins outright. Failing that, the first row is treated as a header
   * only when it reads as prose and the rows under it read as data; guessing wrong
   * here would rename every column, which is worse than admitting there is none.
   */
  private pickHeaderRow(grid: PlannedRow[], width: number): number {
    for (const [index, row] of grid.entries()) {
      const real = row.filter((entry): entry is PlannedCell => entry !== null && !entry.continuation)
      if (!real.length) continue
      const headers = real.filter((entry) => entry.element.tag === 'th')
      const prose = real.filter((entry) => proseLike(this.textSpan(entry.element).text))
      if (headers.length === real.length && real.length >= Math.min(width, 2)) return index
      if (index === 0 && headers.length > 0 && headers.length >= real.length - 1) return 0
      if (index === 0 && real.length >= 2 && prose.length === real.length && grid.length > 1) {
        const body = (grid[1] ?? []).filter((entry): entry is PlannedCell => entry !== null && !entry.continuation)
        if (body.some((entry) => !proseLike(this.textSpan(entry.element).text))) return 0
      }
    }
    return -1
  }
}

interface PlannedCell {
  element: Element
  continuation: boolean
}

type PlannedRow = Array<PlannedCell | null>

function findAllTags(node: Element, tag: string): Element[] {
  const found: Element[] = []
  const visit = (current: Element): void => {
    for (const child of childElements(current)) {
      if (child.tag === tag) found.push(child)
      visit(child)
    }
  }
  visit(node)
  return found
}

function consume(node: Element, seen: Set<Element>): void {
  seen.add(node)
  for (const child of node.children) {
    if (child.type === 'element') consume(child, seen)
  }
}

function absoluteHref(href: string, url?: string): { absoluteHref?: string } {
  if (!url || href.trim().startsWith('#')) return {}
  try {
    const resolved = new URL(href, url)
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return {}
    return { absoluteHref: resolved.toString() }
  } catch {
    return {}
  }
}

function collectRows(table: Element): Element[] {
  const rows: Element[] = []
  const visit = (node: Element): void => {
    for (const child of childElements(node)) {
      if (child.tag === 'table') continue
      if (child.tag === 'tr') rows.push(child)
      else visit(child)
    }
  }
  visit(table)
  return rows.slice(0, MAX_TABLE_ROWS + 50)
}

function spanOf(node: Element, attribute: 'colspan' | 'rowspan'): number {
  const raw = node.attributes[attribute]
  if (!raw) return 1
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) && value > 0 && value < 100 ? value : 1
}

function proseLike(value: string): boolean {
  if (!value) return false
  return !/^[-+]?\d{1,3}([.,]\d{3})*(\.\d+)?\s*(%|B|KB|MB|GB|bps|Kbps|Mbps|Gbps|ms|s|min|h|d|days?)?$/i.test(value.trim())
    && !/^\d{2,4}[-/]\d{1,2}[-/]\d{1,2}/.test(value.trim())
    && !/^(up|down|enabled|disabled|yes|no|true|false)$/i.test(value.trim())
}

function normalizeFieldType(node: Element): string {
  if (node.tag === 'textarea') return 'textarea'
  if (node.tag === 'button') return (node.attributes['type'] ?? 'submit').toLowerCase()
  if (node.tag === 'select') return hasFlag(node, 'multiple') ? 'select-multiple' : 'select-one'
  const declared = (node.attributes['type'] ?? 'text').toLowerCase()
  const known = [
    'text', 'password', 'hidden', 'checkbox', 'radio', 'submit', 'image', 'file',
    'number', 'email', 'tel', 'search', 'url', 'date', 'time', 'datetime-local',
    'month', 'week', 'color', 'range', 'reset', 'button',
  ]
  return known.includes(declared) ? declared : 'text'
}

function fieldOptions(node: Element): FieldOption[] {
  const options: FieldOption[] = []
  const visit = (current: Element): void => {
    for (const child of childElements(current)) {
      if (child.tag === 'option') {
        const label = collapseWhitespace(textOf(child))
        const value = child.attributes['value'] ?? label
        options.push({ label: truncate(label), value: decodeEntities(value), selected: hasFlag(child, 'selected') })
      } else if (child.tag === 'optgroup') {
        visit(child)
      }
    }
  }
  visit(node)
  // Browsers select the first option when no `selected` is present. The value a
  // submission would send has to match what the operator sees, not the markup.
  if (options.length && !options.some((option) => option.selected)) {
    const first = options[0] as FieldOption
    options[0] = { ...first, selected: true }
  }
  return options
}

function checkboxOption(node: Element): FieldOption[] {
  const value = node.attributes['value'] ?? 'on'
  return [{ label: truncate(value), value: decodeEntities(value), selected: hasFlag(node, 'checked') }]
}

function fieldValue(node: Element, type: string, options: FieldOption[]): string | null {
  if (node.tag === 'textarea') return rawTextOf(node)
  if (node.tag === 'select') return options.find((option) => option.selected)?.value ?? null
  if (type === 'submit' || type === 'image' || type === 'button') {
    const declared = node.attributes['value']
    if (declared !== undefined) return declared
    const text = collapseWhitespace(textOf(node))
    return text || null
  }
  if (type === 'checkbox' || type === 'radio') return hasFlag(node, 'checked') ? (node.attributes['value'] ?? 'on') : null
  const value = node.attributes['value']
  if (value !== undefined) return value
  return type === 'password' ? '' : null
}

function truncate(value: string): string {
  const text = value.trim()
  if (text.length <= MAX_TEXT_CHARS) return text
  return `${text.slice(0, MAX_TEXT_CHARS)}…[${text.length - MAX_TEXT_CHARS} more chars]`
}

function collapseWhitespace(value: string): string {
  return decodeEntities(value).replace(/[ \t\f\v]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{2,}/g, '\n').trim()
}

// ─── XML ────────────────────────────────────────────────────────────

function extractXml(input: ExtractDocumentInput, offset: OffsetFn): ExtractedXmlDocument {
  const blanked = blankMachineContent(input.body, { keepCdata: true })
  const root = parseXml(blanked.body, offset)
  const elements = root.children.filter((child): child is XmlElementNode => child.kind === 'xmlElement')
  const single = elements.length === 1 ? elements[0] : undefined
  return {
    ...(input.url ? { url: input.url } : {}),
    kind: 'xml',
    source: sourceOf(input),
    mediaType: 'application/xml',
    root: single ?? root,
    malformed: elements.length !== 1,
    stripped: blanked.stripped,
  }
}

interface XmlFrame {
  node: XmlElementNode
  /** Namespace prefix map in scope at this element, '' for the default. */
  prefixes: Record<string, string>
}

/**
 * Tolerant XML reader.
 *
 * Appliance feeds are frequently namespace-heavy, occasionally not well-formed,
 * and sometimes carry a stray HTML entity. Nothing here validates against a
 * schema, because there rarely is one: the reader preserves what the document
 * actually says — qualified names, repeated siblings, CDATA, mixed content — and
 * reports `malformed` rather than guessing at a structure it was not given.
 */
function parseXml(body: string, offset: OffsetFn): XmlElementNode {
  const root: XmlElementNode = {
    kind: 'xmlElement',
    name: '#document',
    prefix: null,
    local: '#document',
    attributes: {},
    children: [],
    offset: offset(0, body.length),
  }
  const stack: XmlFrame[] = [{ node: root, prefixes: {} }]
  const current = (): XmlFrame => stack[stack.length - 1] as XmlFrame

  const pushText = (from: number, to: number, cdata: boolean): void => {
    if (to <= from) return
    const raw = body.slice(from, to)
    if (!cdata && !raw.trim()) return
    current().node.children.push({
      kind: 'xmlText',
      text: truncate(cdata ? raw.replace(/\s+$/g, '') : decodeEntities(raw)),
      cdata,
      offset: offset(from, to),
    })
  }

  let index = 0
  while (index < body.length) {
    const lt = body.indexOf('<', index)
    if (lt < 0) {
      pushText(index, body.length, false)
      break
    }
    if (lt > index) pushText(index, lt, false)
    if (body.startsWith('<![CDATA[', lt)) {
      const close = body.indexOf(']]>', lt)
      const contentEnd = close < 0 ? body.length : close
      pushText(lt + 9, contentEnd, true)
      index = close < 0 ? body.length : close + 3
      continue
    }
    if (body[lt + 1] === '!' || body[lt + 1] === '?') {
      // Blanked to spaces already; step over the delimiters so their remnants
      // are not mistaken for a tag.
      const close = body.indexOf('>', lt)
      index = close < 0 ? body.length : close + 1
      continue
    }
    const closing = body[lt + 1] === '/'
    const name = readTagName(body, lt + (closing ? 2 : 1))
    if (!name) {
      pushText(lt, lt + 1, false)
      index = lt + 1
      continue
    }
    const tagEnd = findTagEnd(body, name.end)
    const end = Math.min(tagEnd + 1, body.length)
    const inner = body.slice(name.end, tagEnd)

    if (closing) {
      if (inner.trim()) {
        pushText(lt, end, false)
        index = end
        continue
      }
      let depth = stack.length - 1
      while (depth > 0) {
        if ((stack[depth] as XmlFrame).node.name === name.name) break
        depth -= 1
      }
      if (depth > 0) {
        // The span of an element includes its own close tag, so a slice of the
        // body between start and end is the whole element as it was served.
        const closed = stack.splice(depth)[0] as XmlFrame
        closed.node.offset = offset(closed.node.offset.start, end)
        stack.length = depth
      }
      index = end
      continue
    }

    const attributes = parseAttributes(inner)
    const prefixes: Record<string, string> = { ...current().prefixes }
    for (const attribute of attributes) {
      if (attribute.name === 'xmlns') prefixes[''] = attribute.value
      else if (attribute.name.startsWith('xmlns:')) prefixes[attribute.name.slice(6)] = attribute.value
    }
    const resolved = resolveQName(name.name, prefixes)
    const node: XmlElementNode = {
      kind: 'xmlElement',
      name: name.name,
      prefix: resolved.prefix,
      local: resolved.local,
      ...(resolved.uri ? { namespace: resolved.uri } : {}),
      attributes: Object.fromEntries(attributes.map((attribute) => [attribute.name, attribute.value])),
      children: [],
      offset: offset(lt, end),
    }
    current().node.children.push(node)
    if (/\/\s*$/.test(inner)) index = end
    else {
      stack.push({ node, prefixes })
      index = end
    }
  }

  while (stack.length > 1) {
    // Unclosed elements still have to stop somewhere an offset can point at: the
    // end of the body, past the last child actually received.
    const open = stack.pop() as XmlFrame
    open.node.offset = offset(open.node.offset.start, furthestEnd(open.node, body.length))
  }
  root.offset = offset(0, body.length)
  return root
}

function furthestEnd(node: XmlElementNode, floor: number): number {
  let end = floor
  for (const child of node.children) end = Math.max(end, child.offset.end)
  return end
}

function resolveQName(qualified: string, prefixes: Record<string, string>): { prefix: string | null; local: string; uri?: string } {
  const colon = qualified.indexOf(':')
  if (colon < 0) {
    const uri = prefixes['']
    return { prefix: null, local: qualified, ...(uri ? { uri } : {}) }
  }
  const prefix = qualified.slice(0, colon)
  const local = qualified.slice(colon + 1)
  const uri = prefixes[prefix]
  return { prefix, local, ...(uri ? { uri } : {}) }
}

// ─── CSV / TSV ──────────────────────────────────────────────────────

const DELIMITED_CANDIDATES = ['\t', ',', ';', '|']

function extractDelimited(input: ExtractDocumentInput, offset: OffsetFn, kind: 'csv' | 'tsv'): ExtractedDelimitedDocument | undefined {
  const delimiter = kind === 'tsv' ? '\t' : inferDelimiter(input.body)
  if (!delimiter) return undefined
  const records = parseDelimited(input.body, delimiter)
  if (!records.length) return undefined
  const width = records.reduce((widest, record) => Math.max(widest, record.values.length), 0)
  if (width < 2) return undefined

  const header = looksLikeHeader(records[0]?.values ?? [], records.slice(1))
  const data = header ? records.slice(1) : records
  const columns: DelimitedColumn[] = []
  for (let index = 0; index < width; index += 1) {
    const values = data.map((record) => record.values[index] ?? null)
    const nonEmpty = values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    const declaredName = header ? (records[0]?.values[index] ?? '').trim() : ''
    columns.push({
      name: truncate(declaredName || `column${index + 1}`),
      index,
      type: columnType(nonEmpty),
      emptyCount: values.length - nonEmpty.length,
      sample: nonEmpty[0] !== undefined ? truncate(nonEmpty[0]) : null,
    })
  }

  return {
    ...(input.url ? { url: input.url } : {}),
    kind: 'delimited',
    source: sourceOf(input),
    mediaType: kind === 'tsv' ? 'text/tab-separated-values' : 'text/csv',
    table: {
      delimiter,
      header,
      columns,
      rows: data.slice(0, MAX_TABLE_ROWS).map((record, index) => ({
        index,
        values: Array.from({ length: width }, (_, column) => record.values[column] ?? null),
        offset: offset(record.start, record.end),
      })),
      truncated: data.length > MAX_TABLE_ROWS,
    },
  }
}

function firstNonEmptyLines(body: string, limit: number): string[] {
  const lines: string[] = []
  for (const line of body.split(/\r?\n/)) {
    if (line.trim()) lines.push(line)
    if (lines.length >= limit) break
  }
  return lines
}

/**
 * Infer the delimiter rather than trusting the extension.
 *
 * Scoring rewards a count that repeats across lines, because a comma inside a
 * free-text field is common and a column count that changes row to row means the
 * character being counted is not the delimiter.
 */
function inferDelimiter(body: string): string | undefined {
  const lines = firstNonEmptyLines(body, 10)
  if (!lines.length) return undefined
  let best: { delimiter: string; score: number } | undefined
  for (const delimiter of DELIMITED_CANDIDATES) {
    const counts = lines.map((line) => countFields(line, delimiter))
    const first = counts[0] ?? 0
    if (first < 2) continue
    const stable = counts.every((count) => count === first)
    const score = first * (stable ? 2 : 1)
    if (!best || score > best.score) best = { delimiter, score }
  }
  return best?.delimiter
}

function countFields(line: string, delimiter: string): number {
  let count = 1
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index] as string
    if (char === '"') quoted = !quoted
    else if (char === delimiter && !quoted) count += 1
  }
  return count
}

interface DelimitedRecord {
  values: string[]
  start: number
  end: number
}

/** RFC4180-ish: quoted fields, doubled quotes, newlines inside quotes. */
function parseDelimited(body: string, delimiter: string): DelimitedRecord[] {
  const records: DelimitedRecord[] = []
  let values: string[] = []
  let field = ''
  let quoted = false
  let start = 0
  let started = false
  let index = 0

  const finishRecord = (end: number): void => {
    values.push(field)
    const record = { values, start, end }
    values = []
    field = ''
    started = false
    if (record.values.some((value) => value.trim().length > 0)) records.push(record)
  }

  while (index < body.length) {
    const char = body[index] as string
    if (quoted) {
      if (char === '"') {
        if (body[index + 1] === '"') {
          field += '"'
          index += 2
          continue
        }
        quoted = false
        index += 1
        continue
      }
      field += char
      index += 1
      continue
    }
    if (char === '"' && field === '') {
      quoted = true
      started = true
      index += 1
      continue
    }
    if (char === delimiter) {
      if (!started) start = index
      started = true
      values.push(field)
      field = ''
      index += 1
      continue
    }
    if (char === '\n' || char === '\r') {
      if (started || field || values.length) finishRecord(index)
      index += char === '\r' && body[index + 1] === '\n' ? 2 : 1
      start = index
      continue
    }
    if (!started) start = index
    started = true
    field += char
    index += 1
  }
  if (started || field || values.length) finishRecord(body.length)
  return records
}

function looksLikeHeader(first: Array<string | null>, rest: Array<DelimitedRecord>): boolean {
  if (!first.length || !rest.length) return false
  const declared = first.filter((value) => value !== null && value.trim().length > 0)
  if (!declared.length) return false
  const firstHasNumeric = declared.some((value) => numericLike(String(value)))
  const sample = rest.slice(0, 10).flatMap((record) => record.values.filter((value) => value !== null && value.trim().length > 0))
  if (!sample.length) return !firstHasNumeric
  const bodyShare = sample.filter(numericLike).length / sample.length
  // Numeric in the first row and numeric in the body means the first row is data.
  return bodyShare > 0.4 ? !firstHasNumeric : declared.every((value) => !numericLike(String(value)))
}

function columnType(values: string[]): DelimitedColumn['type'] {
  if (!values.length) return 'empty'
  const trimmed = values.map((value) => value.trim())
  if (trimmed.every((value) => /^(true|false|yes|no|enabled|disabled|up|down)$/i.test(value))) return 'boolean'
  if (trimmed.every((value) => /^-?\d+$/.test(value))) return 'integer'
  if (trimmed.every((value) => /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(value))) return 'number'
  if (trimmed.every((value) => /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?(Z|[+-]\d{2}:?\d{2})?$/.test(value))) return 'date'
  return 'string'
}

function numericLike(value: string): boolean {
  return /^[-+]?\d{1,3}(,\d{3})*(\.\d+)?\s*(%|B|KB|MB|GB|bps|Kbps|Mbps|Gbps)?$/i.test(value.trim())
    || /^[-+]?\d+(\.\d+)?$/.test(value.trim())
}

// ─── Plaintext ──────────────────────────────────────────────────────

function textBlocks(body: string, offset: OffsetFn): Array<{ text: string; offset: ExtractOffset }> {
  const blocks: Array<{ text: string; offset: ExtractOffset }> = []
  const pattern = /[^\r\n]+/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(body))) {
    const text = match[0]
    if (!text.trim()) continue
    blocks.push({ text: truncate(text), offset: offset(match.index, match.index + text.length) })
    if (blocks.length >= MAX_NODES) break
  }
  return blocks
}

// ─── Pages into APIs ───────────────────────────────────────────────

export interface ApiParameter {
  name: string
  /** Where the value rides: a GET form is query-only, everything else a body. */
  in: 'query' | 'body'
  type: 'string' | 'number' | 'boolean' | 'file'
  required: boolean
  /** Value the page currently holds, which is the value a send re-submits. */
  default?: string
  values?: string[]
  options?: Array<{ label: string; value: string }>
  /**
   * True for a control whose value the caller must not invent. Appliance pages
   * carry CSRF and session tokens in hidden fields, and a stale or invented one
   * is the difference between a working request and a confusing rejection.
   */
  carried: boolean
  description: string
  offset: ExtractOffset
}

export interface ApiOperation {
  name: string
  method: string
  path: string
  /** Absolute target when the document URL is known and the action is relative. */
  url?: string
  enctype: string
  params: ApiParameter[]
  docs: string
  /** Source form node id, so a proposal can cite the page it came from. */
  sourceId: string
  /**
   * Whether `offset` indexes the served response or a rendered DOM serialization.
   * Carried here because an operation is quoted on its own, away from the document
   * it came from, and a resolved offset means nothing without it.
   */
  source: ContentSource
  offset: ExtractOffset
}

/**
 * Describe every form on an extracted page as a callable shape.
 *
 * Deliberately pure: it emits a description of what a submission would send and
 * performs no I/O. The browser tools turn an operation into a proposal a human
 * approves; nothing in here submits anything.
 */
export function toApiShape(extracted: ExtractedDocument): ApiOperation[] {
  if (extracted.kind !== 'html') return []
  const operations: ApiOperation[] = []
  for (const node of extracted.nodes) {
    if (node.kind === 'form') operations.push(formOperation(node, extracted.url, extracted.source))
  }
  return operations
}

/** Shape one form. Exported for the proposal path, which holds a single form. */
export function formOperation(form: FormNode, url?: string, source: ContentSource = 'served'): ApiOperation {
  const method = form.method === 'post' ? 'POST' : form.method === 'get' ? 'GET' : form.method.toUpperCase()
  const location: ApiParameter['in'] = method === 'GET' ? 'query' : 'body'
  const params: ApiParameter[] = []
  for (const field of form.fields) {
    if (field.type === 'submit' || field.type === 'button' || field.type === 'reset') continue
    const carried = field.type === 'hidden' || isTokenName(field.name)
    params.push({
      name: field.name,
      in: location,
      type: parameterType(field.type),
      required: field.required || field.type === 'hidden',
      ...(field.value !== null ? { default: field.value } : {}),
      ...(field.values && field.values.length ? { values: field.values } : {}),
      ...(field.options && field.options.length ? { options: field.options.map((option) => ({ label: option.label, value: option.value })) } : {}),
      carried,
      description: parameterDocs(field, carried),
      offset: field.offset,
    })
  }

  const path = form.action ? stripFragment(form.action) : url ? pathnameOf(url) : ''
  const absolute = form.action && url ? safeJoin(url, form.action) : undefined
  const submit = form.fields.find((field) => field.type === 'submit' || field.type === 'image')
  const heading = form.name ?? submit?.value ?? `${method} ${path || 'the current page'}`
  return {
    name: truncate(heading).slice(0, 80) || form.id,
    method,
    path,
    ...(absolute ? { url: absolute } : {}),
    enctype: form.enctype,
    params,
    docs: operationDocs(method, path, params, submit),
    sourceId: form.id,
    source,
    offset: form.offset,
  }
}

function parameterType(fieldType: string): ApiParameter['type'] {
  if (fieldType === 'file') return 'file'
  if (fieldType === 'number' || fieldType === 'range') return 'number'
  if (fieldType === 'checkbox' || fieldType === 'radio') return 'boolean'
  return 'string'
}

function parameterDocs(field: FieldNode, carried: boolean): string {
  const parts: string[] = []
  if (field.label) parts.push(`label: ${field.label}`)
  if (field.type === 'password') parts.push('secret: supply from the credential layer, never from page text or chat')
  else if (carried && field.value !== null) parts.push(`carry the served value unchanged (${field.value.length} chars)`)
  else if (carried) parts.push('carry the value the page just served; do not invent it')
  if (field.options?.length) parts.push(`choices: ${field.options.map((option) => `${option.value}${option.selected ? ' (current)' : ''}`).join(', ')}`)
  if (field.disabled) parts.push('read-only on the page')
  if (field.type === 'checkbox' || field.type === 'radio') parts.push('omit when unset')
  return parts.join('; ') || `${field.type} field`
}

const TOKEN_NAME = /(csrf|xsrf|_?token|authenticity|nonce|sess|ticket|verif|viewstate|requesthash)/i

function isTokenName(name: string): boolean {
  return TOKEN_NAME.test(name)
}

function operationDocs(method: string, path: string, params: ApiParameter[], submit: FieldNode | undefined): string {
  const lines = [
    `${method} ${path || 'the current page'}`,
    `Sends ${params.length} parameter${params.length === 1 ? '' : 's'}${submit?.value ? `, triggered by the "${submit.value}" control` : ''}.`,
  ]
  if (!params.length) lines.push('This form carries no named controls: submitting it only re-requests the page.')
  for (const param of params) {
    const state = param.default !== undefined ? `current value ${JSON.stringify(param.default)}` : 'currently unset'
    const choices = param.options?.length ? ` [${param.options.map((option) => option.value).join(' | ')}]` : ''
    lines.push(`- ${param.name} (${param.type}, ${param.required ? 'required' : 'optional'}, ${state})${choices}: ${param.description}`)
  }
  lines.push('Description only. Nothing here has been sent to the device.')
  return lines.join('\n')
}

function stripFragment(value: string): string {
  const hash = value.indexOf('#')
  return hash < 0 ? value : value.slice(0, hash)
}

function pathnameOf(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    return ''
  }
}

function safeJoin(base: string, action: string): string | undefined {
  try {
    const resolved = new URL(action, base)
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return undefined
    return resolved.toString()
  } catch {
    return undefined
  }
}
