import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

export interface UrlPreview {
  kind: 'url_preview'
  url: string
  finalUrl: string
  status: number
  contentType: string
  title?: string
  description?: string
  excerpt?: string
  siteName?: string
  type?: string
  image?: string
  imageAlt?: string
  favicon?: string
}

export interface UrlPreviewImage {
  contentType: string
  bytes: Uint8Array
  finalUrl: string
}

export class UnsafeFetchTargetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsafeFetchTargetError'
  }
}

const MAX_BYTES = 512_000
const MAX_IMAGE_BYTES = 3 * 1024 * 1024
const TIMEOUT_MS = 10_000
const MAX_REDIRECTS = 5

export async function fetchUrlPreview(rawUrl: string, allowedHosts = configuredAllowedHosts()): Promise<UrlPreview> {
  return fetchPreview(rawUrl, rawUrl, allowedHosts, 0)
}

/**
 * Fetch an image discovered by the preview parser through the same SSRF policy
 * as the page fetch. The browser never talks to arbitrary OG hosts directly.
 */
export async function fetchUrlPreviewImage(rawUrl: string, allowedHosts = configuredAllowedHosts()): Promise<UrlPreviewImage> {
  return fetchPreviewImage(rawUrl, allowedHosts, 0)
}

async function fetchPreview(rawUrl: string, currentUrl: string, allowedHosts: Set<string>, redirects: number): Promise<UrlPreview> {
  const url = await approvedUrl(currentUrl, allowedHosts)

  const response = await fetch(url, {
    redirect: 'manual',
    headers: { accept: 'text/html,application/json,text/plain;q=0.8,*/*;q=0.2', 'user-agent': 'Papyrus-Preview/1.0' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (isRedirect(response.status)) {
    if (redirects >= MAX_REDIRECTS) throw new Error(`Preview exceeded ${MAX_REDIRECTS} redirects`)
    const location = response.headers.get('location')
    if (!location) throw new Error(`Preview redirect (${response.status}) has no location`)
    const redirected = new URL(location, url)
    await assertPublicTarget(redirected, allowedHosts)
    return fetchPreview(rawUrl, redirected.toString(), allowedHosts, redirects + 1)
  }

  const limited = await readAtMost(response, MAX_BYTES)
  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? 'application/octet-stream'
  const text = new TextDecoder().decode(limited)
  const metadata = contentType === 'text/html' ? htmlMetadata(text, url) : {}
  const excerpt = ['text/html', 'text/plain', 'application/json'].includes(contentType)
    ? clean(contentType === 'text/html' ? visibleText(text) : text).slice(0, 700)
    : undefined

  return {
    kind: 'url_preview',
    url: rawUrl,
    finalUrl: url.toString(),
    status: response.status,
    contentType,
    ...metadata,
    ...(excerpt ? { excerpt } : {}),
  }
}

async function fetchPreviewImage(currentUrl: string, allowedHosts: Set<string>, redirects: number): Promise<UrlPreviewImage> {
  const url = await approvedUrl(currentUrl, allowedHosts)
  const response = await fetch(url, {
    redirect: 'manual',
    headers: { accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif,image/*;q=0.8', 'user-agent': 'Papyrus-Preview/1.0' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (isRedirect(response.status)) {
    if (redirects >= MAX_REDIRECTS) throw new Error(`Preview image exceeded ${MAX_REDIRECTS} redirects`)
    const location = response.headers.get('location')
    if (!location) throw new Error(`Preview image redirect (${response.status}) has no location`)
    return fetchPreviewImage(new URL(location, url).toString(), allowedHosts, redirects + 1)
  }
  if (!response.ok) throw new Error(`Preview image returned HTTP ${response.status}`)

  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? ''
  if (!contentType.startsWith('image/') || contentType === 'image/svg+xml') {
    throw new Error('Preview image must be a non-SVG image')
  }
  const advertised = Number(response.headers.get('content-length') ?? 0)
  if (Number.isFinite(advertised) && advertised > MAX_IMAGE_BYTES) throw new Error('Preview image exceeds three MiB')

  return {
    contentType,
    bytes: await readAtMost(response, MAX_IMAGE_BYTES),
    finalUrl: url.toString(),
  }
}

async function approvedUrl(value: string, allowedHosts: Set<string>): Promise<URL> {
  const url = new URL(value)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHostname(url.hostname))) {
    throw new UnsafeFetchTargetError('Only HTTPS URLs are allowed outside loopback development')
  }
  if (url.username || url.password) throw new UnsafeFetchTargetError('URLs containing credentials are not allowed')
  await assertPublicTarget(url, allowedHosts)
  return url
}

async function readAtMost(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (total < limit) {
    const { done, value } = await reader.read()
    if (done) break
    const available = Math.min(value.byteLength, limit - total)
    chunks.push(value.subarray(0, available))
    total += available
    if (available < value.byteLength || total === limit) {
      await reader.cancel('Preview byte limit reached')
      break
    }
  }
  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength }
  return result
}

async function assertPublicTarget(url: URL, allowedHosts: Set<string>): Promise<void> {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (allowedHosts.has(host)) return
  if (isLoopbackHostname(host) || host === '169.254.169.254' || host.endsWith('.internal') || host.endsWith('.local')) {
    throw new UnsafeFetchTargetError(`Host ${host} is private; add it to PAPYRUS_FETCH_ALLOWED_HOSTS only after review`)
  }
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true })
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new UnsafeFetchTargetError(`Host ${host} resolves to a private or reserved address`)
  }
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400
}

function isLoopbackHostname(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1'
}

function isPrivateAddress(address: string): boolean {
  if (address.includes(':')) {
    const value = address.toLowerCase()
    return value === '::1' || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb')
  }
  const [a = 0, b = 0] = address.split('.').map(Number)
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224
}

function configuredAllowedHosts(): Set<string> {
  return new Set((process.env.PAPYRUS_FETCH_ALLOWED_HOSTS ?? '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean))
}

interface HtmlMetadata {
  title?: string
  description?: string
  siteName?: string
  type?: string
  image?: string
  imageAlt?: string
  favicon?: string
}

export function htmlMetadata(html: string, baseUrl: URL): HtmlMetadata {
  const metas = new Map<string, string>()
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attrs = tagAttributes(tag)
    const key = (attrs['property'] ?? attrs['name'] ?? '').trim().toLowerCase()
    const content = attrs['content']?.trim()
    if (key && content && !metas.has(key)) metas.set(key, decodeEntities(content))
  }

  const titleElement = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]
  const title = firstClean(metas.get('og:title'), metas.get('twitter:title'), titleElement ? decodeEntities(titleElement) : undefined)
  const description = firstClean(metas.get('og:description'), metas.get('twitter:description'), metas.get('description'))
  const siteName = firstClean(metas.get('og:site_name'))
  const type = firstClean(metas.get('og:type'))
  const image = resolvePreviewAsset(
    metas.get('og:image:secure_url') ?? metas.get('og:image') ?? metas.get('twitter:image') ?? metas.get('twitter:image:src'),
    baseUrl,
  )
  const imageAlt = firstClean(metas.get('og:image:alt'), metas.get('twitter:image:alt'))

  let favicon: string | undefined
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const attrs = tagAttributes(tag)
    const rel = (attrs['rel'] ?? '').toLowerCase().split(/\s+/)
    if (!rel.some((value) => ['icon', 'shortcut', 'apple-touch-icon'].includes(value))) continue
    favicon = resolvePreviewAsset(attrs['href'], baseUrl)
    if (favicon) break
  }

  return {
    ...(title ? { title: title.slice(0, 300) } : {}),
    ...(description ? { description: description.slice(0, 500) } : {}),
    ...(siteName ? { siteName: siteName.slice(0, 160) } : {}),
    ...(type ? { type: type.slice(0, 100) } : {}),
    ...(image ? { image } : {}),
    ...(imageAlt ? { imageAlt: imageAlt.slice(0, 300) } : {}),
    ...(favicon ? { favicon } : {}),
  }
}

function tagAttributes(tag: string): Record<string, string> {
  const attributes: Record<string, string> = {}
  const pattern = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(tag))) {
    attributes[match[1]!.toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? ''
  }
  return attributes
}

function resolvePreviewAsset(value: string | undefined, base: URL): string | undefined {
  if (!value?.trim()) return undefined
  try {
    const url = new URL(decodeEntities(value.trim()), base)
    if (url.username || url.password) return undefined
    if (url.protocol === 'https:' || (url.protocol === 'http:' && isLoopbackHostname(url.hostname))) return url.toString()
  } catch {
    return undefined
  }
  return undefined
}

function firstClean(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (!value) continue
    const cleaned = clean(value)
    if (cleaned) return cleaned
  }
  return undefined
}

function visibleText(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
}

function clean(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x2F;/gi, '/')
}
