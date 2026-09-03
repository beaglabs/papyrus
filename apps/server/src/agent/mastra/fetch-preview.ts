import { isIP } from 'node:net'
import { lookup } from 'node:dns/promises'

export interface UrlPreview {
  kind: 'url_preview'
  url: string
  finalUrl: string
  status: number
  contentType: string
  title?: string
  description?: string
  excerpt?: string
}

export class UnsafeFetchTargetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsafeFetchTargetError'
  }
}

const MAX_BYTES = 512_000
const TIMEOUT_MS = 10_000
const MAX_REDIRECTS = 5

export async function fetchUrlPreview(rawUrl: string, allowedHosts = configuredAllowedHosts()): Promise<UrlPreview> {
  return fetchPreview(rawUrl, rawUrl, allowedHosts, 0)
}

async function fetchPreview(rawUrl: string, currentUrl: string, allowedHosts: Set<string>, redirects: number): Promise<UrlPreview> {
  const url = new URL(currentUrl)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHostname(url.hostname))) {
    throw new UnsafeFetchTargetError('Only HTTPS URLs are allowed outside loopback development')
  }
  if (url.username || url.password) throw new UnsafeFetchTargetError('URLs containing credentials are not allowed')
  await assertPublicTarget(url, allowedHosts)

  const response = await fetch(url, {
    redirect: 'manual',
    headers: { accept: 'text/html,application/json,text/plain;q=0.8,*/*;q=0.2', 'user-agent': 'Papyrus-Preview/1.0' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (response.status >= 300 && response.status < 400) {
    if (redirects >= MAX_REDIRECTS) throw new Error(`Preview exceeded ${MAX_REDIRECTS} redirects`)
    const location = response.headers.get('location')
    if (!location) throw new Error(`Preview redirect (${response.status}) has no location`)
    const redirected = new URL(location, url)
    await assertPublicTarget(redirected, allowedHosts)
    return fetchPreview(rawUrl, redirected.toString(), allowedHosts, redirects + 1)
  }

  const limited = await readAtMost(response, MAX_BYTES)
  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim() ?? 'application/octet-stream'
  const text = new TextDecoder().decode(limited)
  const title = contentType === 'text/html' ? meta(text, /<title[^>]*>([\s\S]*?)<\/title>/i) : undefined
  const description = contentType === 'text/html'
    ? meta(text, /<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']*)["'][^>]*>/i)
      ?? meta(text, /<meta[^>]+content=["']([^"']*)["'][^>]+(?:name|property)=["'](?:description|og:description)["'][^>]*>/i)
    : undefined
  const excerpt = ['text/html', 'text/plain', 'application/json'].includes(contentType)
    ? clean(contentType === 'text/html' ? text.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ') : text).slice(0, 700)
    : undefined

  return {
    kind: 'url_preview', url: rawUrl, finalUrl: url.toString(), status: response.status, contentType,
    ...(title ? { title } : {}), ...(description ? { description } : {}), ...(excerpt ? { excerpt } : {}),
  }
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

function meta(html: string, pattern: RegExp): string | undefined {
  const match = pattern.exec(html)?.[1]
  return match ? clean(decodeEntities(match)).slice(0, 300) : undefined
}

function clean(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function decodeEntities(value: string): string {
  return value.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
}
