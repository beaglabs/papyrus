import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineCommand } from 'citty'

const TOKEN_DIR = join(process.env.HOME ?? '~', '.papyrus', 'auth')
const TOKEN_FILE = join(TOKEN_DIR, 'session-token.json')
const IDENTITY_DIR = join(process.env.HOME ?? '~', '.papyrus', 'identity')
const IDENTITY_FILE = join(IDENTITY_DIR, 'member.json')

function getPort(): number {
  return Number(process.env.PAPYRUS_PORT ?? 3777)
}

function getBaseUrl(): string {
  return `http://localhost:${getPort()}`
}

function loadToken(): string | null {
  if (!existsSync(TOKEN_FILE)) return null
  try {
    const data = JSON.parse(readFileSync(TOKEN_FILE, 'utf-8')) as { token: string }
    return data.token
  } catch {
    return null
  }
}

function saveToken(token: string): void {
  if (!existsSync(TOKEN_DIR)) {
    mkdirSync(TOKEN_DIR, { recursive: true })
  }
  writeFileSync(
    TOKEN_FILE,
    JSON.stringify({ token, createdAt: new Date().toISOString() }, null, 2),
    'utf-8',
  )
}

function clearToken(): void {
  if (existsSync(TOKEN_FILE)) {
    unlinkSync(TOKEN_FILE)
  }
}

function loadIdentity(): { publicKey: string; privateKey: string } | null {
  if (!existsSync(IDENTITY_FILE)) return null
  try {
    return JSON.parse(readFileSync(IDENTITY_FILE, 'utf-8')) as {
      publicKey: string
      privateKey: string
    }
  } catch {
    return null
  }
}

function authHeaders(): Record<string, string> {
  const token = loadToken()
  if (!token) return {}
  return { Authorization: `Bearer ${token}` }
}

export const auth = defineCommand({
  meta: {
    name: 'auth',
    description: 'Authentication and session management',
  },
  subCommands: {
    login: defineCommand({
      meta: {
        name: 'login',
        description: 'Sign in to the Papyrus daemon',
      },
      args: {
        name: {
          type: 'string',
          description: 'Display name',
          required: false,
        },
      },
      async run({ args }) {
        const identity = loadIdentity()
        if (!identity) {
          console.error('No member identity found. The daemon will generate one on first login.')
          console.error('Identity is stored at:', IDENTITY_FILE)
          return
        }

        const displayName = (args.name as string) ?? 'CLI User'

        try {
          const res = await fetch(`${getBaseUrl()}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              memberKey: identity.publicKey,
              displayName,
            }),
          })

          if (!res.ok) {
            const err = (await res.json()) as { error?: string }
            console.error('Login failed:', err.error ?? res.statusText)
            return
          }

          const data = (await res.json()) as {
            token: string
            memberKey: string
            displayName: string
          }
          saveToken(data.token)
          console.log(`Logged in as ${data.displayName}`)
          console.log(`Member key: ${data.memberKey.slice(0, 16)}...`)
        } catch (err) {
          console.error('Connection failed. Is the daemon running?')
          console.error('Start it with: papyrus daemon start')
        }
      },
    }),

    logout: defineCommand({
      meta: {
        name: 'logout',
        description: 'Sign out and clear the session token',
      },
      async run() {
        const token = loadToken()
        if (token) {
          try {
            await fetch(`${getBaseUrl()}/api/auth/logout`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${token}` },
            })
          } catch {}
        }
        clearToken()
        console.log('Logged out')
      },
    }),

    status: defineCommand({
      meta: {
        name: 'status',
        description: 'Show current authentication status',
      },
      async run() {
        const token = loadToken()
        if (!token) {
          console.log('Not authenticated. Run: papyrus auth login')
          return
        }

        try {
          const res = await fetch(`${getBaseUrl()}/api/auth/me`, {
            headers: { Authorization: `Bearer ${token}` },
          })

          if (!res.ok) {
            console.log('Session expired. Run: papyrus auth login')
            clearToken()
            return
          }

          const data = (await res.json()) as {
            memberKey: string
            displayName: string
            role: string | null
          }
          console.log('Authenticated')
          console.log(`  Display name: ${data.displayName}`)
          console.log(`  Member key: ${data.memberKey.slice(0, 16)}...`)
          if (data.role) {
            console.log(`  Role: ${data.role}`)
          }
        } catch {
          console.log('Could not verify session (daemon may be offline)')
        }
      },
    }),

    refresh: defineCommand({
      meta: {
        name: 'refresh',
        description: 'Refresh the session token',
      },
      async run() {
        const token = loadToken()
        if (!token) {
          console.log('Not authenticated. Run: papyrus auth login')
          return
        }

        try {
          const res = await fetch(`${getBaseUrl()}/api/auth/refresh`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
          })

          if (!res.ok) {
            console.log('Refresh failed. Run: papyrus auth login')
            clearToken()
            return
          }

          const data = (await res.json()) as { token: string }
          saveToken(data.token)
          console.log('Token refreshed')
        } catch {
          console.error('Connection failed. Is the daemon running?')
        }
      },
    }),
  },
})
