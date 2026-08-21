import { readFileSync } from 'node:fs'

export interface ConnectOptions {
  url: string
  headers: Record<string, string>
}

export function resolveConnectOptions(argv: string[], env: NodeJS.ProcessEnv): ConnectOptions {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]
    if (!['--url', '--environment', '--workspace'].includes(name ?? '')) throw new Error(`Unknown papyrus-connect option: ${name ?? ''}`)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`)
    values.set(name as string, value)
    index += 1
  }

  const configuredUrl = values.get('--url') ?? env.PAPYRUS_CONNECT_URL
  if (!configuredUrl) throw new Error('PAPYRUS_CONNECT_URL or --url is required')
  const url = new URL(configuredUrl)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Papyrus connector URL must be HTTP(S) without credentials, query, or fragment')
  }
  if (url.pathname === '/' || url.pathname === '') url.pathname = '/acp'
  if (url.pathname !== '/acp') throw new Error('Papyrus connector URL must target the single /acp endpoint')

  const token = readToken(env)
  const environment = values.get('--environment') ?? values.get('--workspace')
    ?? env.PAPYRUS_CONNECT_ENVIRONMENT ?? env.PAPYRUS_CONNECT_WORKSPACE
  const headers: Record<string, string> = {}
  if (token) headers.authorization = `Bearer ${token}`
  if (environment) headers['x-papyrus-environment-id'] = environment
  return { url: url.toString(), headers }
}

function readToken(env: NodeJS.ProcessEnv): string | undefined {
  if (env.PAPYRUS_CONNECT_TOKEN && env.PAPYRUS_CONNECT_TOKEN_FILE) {
    throw new Error('Set only one of PAPYRUS_CONNECT_TOKEN or PAPYRUS_CONNECT_TOKEN_FILE')
  }
  const token = env.PAPYRUS_CONNECT_TOKEN
    ?? (env.PAPYRUS_CONNECT_TOKEN_FILE ? readFileSync(env.PAPYRUS_CONNECT_TOKEN_FILE, 'utf8').trim() : undefined)
  if (token && (token.length > 8_192 || /[\r\n]/.test(token))) throw new Error('Invalid Papyrus connector token')
  return token || undefined
}
