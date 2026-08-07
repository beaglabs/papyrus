import { spawn } from 'node:child_process'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineCommand } from 'citty'
import { banner } from './_shared.js'

const PORT = Number(process.env.PAPYRUS_PORT ?? 3777)
const PROJECTS_DIR = join(process.env.HOME ?? '~', '.papyrus', 'projects')

function ensureDaemon(): void {
  try {
    const res = execSync(`curl -s http://localhost:${PORT}/api/health`, { timeout: 2000 })
    const data = JSON.parse(res.toString()) as { ok?: boolean }
    if (data.ok) return
  } catch {
    // not running
  }

  // Start daemon in background
  const daemon = spawn(
    'node',
    ['--import', 'tsx', join(import.meta.dirname, '../../../daemon/src/server.ts')],
    {
      detached: true,
      stdio: 'ignore',
    },
  )
  daemon.unref()

  // Wait for daemon to be ready
  for (let i = 0; i < 30; i++) {
    try {
      execSync(`curl -s http://localhost:${PORT}/api/health`, { timeout: 1000 })
      return
    } catch {
      execSync('sleep 0.1')
    }
  }
  console.error('  Failed to start daemon.')
  process.exit(1)
}

function openBrowser(url: string): void {
  const platform = process.platform
  if (platform === 'darwin') spawn('open', [url])
  else if (platform === 'win32') spawn('cmd', ['/c', 'start', url])
  else spawn('xdg-open', [url])
}

const TOKEN_FILE = join(process.env.HOME ?? '~', '.papyrus', 'auth', 'session-token.json')

function loadToken(): string | null {
  if (!existsSync(TOKEN_FILE)) return null
  try {
    const data = JSON.parse(readFileSync(TOKEN_FILE, 'utf-8')) as { token: string }
    return data.token
  } catch {
    return null
  }
}

export default defineCommand({
  meta: {
    name: 'papyrus projects',
    description: 'Project lifecycle: init | list | share | join | open | invite.',
  },
  subCommands: {
    init: defineCommand({
      meta: {
        name: 'papyrus projects init',
        description: 'Create a new project.',
      },
      args: {
        name: {
          type: 'positional',
          description: 'Project name.',
        },
      },
      async run({ args }) {
        banner('projects init')
        ensureDaemon()
        const res = await fetch(`http://localhost:${PORT}/api/projects`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: args.name }),
        })
        const project = (await res.json()) as { id: string; name: string; createdAt: string }
        console.log(`  Created project: ${project.name}`)
        console.log(`  ID: ${project.id}`)
        console.log(`  Created: ${project.createdAt}\n`)
      },
    }),
    list: defineCommand({
      meta: {
        name: 'papyrus projects list',
        description: 'List projects.',
      },
      async run() {
        banner('projects list')
        ensureDaemon()
        const res = await fetch(`http://localhost:${PORT}/api/projects`)
        const projects = (await res.json()) as Array<{
          id: string
          name: string
          createdAt: string
        }>
        if (projects.length === 0) {
          console.log('  No projects yet. Create one with: papyrus projects init <name>\n')
          return
        }
        for (const p of projects) {
          console.log(`  ${p.name}  ${p.id}  ${p.createdAt}`)
        }
        console.log()
      },
    }),
    share: defineCommand({
      meta: {
        name: 'papyrus projects share',
        description: 'Get a shareable ticket for a project.',
      },
      args: {
        project: {
          type: 'positional',
          description: 'Project ID to share.',
        },
      },
      async run({ args }) {
        banner('projects share')
        ensureDaemon()

        if (!args.project) {
          console.error('  Usage: papyrus projects share <project-id>\n')
          return
        }

        // Get the Iroh ticket
        const ticketRes = await fetch(`http://localhost:${PORT}/api/network/ticket`)
        const ticketData = (await ticketRes.json()) as { ticket?: string; error?: string }

        if (ticketData.error) {
          console.error(`  Error: ${ticketData.error}\n`)
          return
        }

        console.log('  Share this ticket with your team:')
        console.log(`  ${ticketData.ticket}\n`)
        console.log('  They can join with: papyrus projects join <ticket>\n')
      },
    }),
    join: defineCommand({
      meta: {
        name: 'papyrus projects join',
        description: 'Join a project by ticket.',
      },
      args: {
        ticket: {
          type: 'positional',
          description: 'Iroh connection ticket.',
        },
      },
      async run({ args }) {
        banner('projects join')
        ensureDaemon()

        if (!args.ticket) {
          console.error('  Usage: papyrus projects join <ticket>\n')
          return
        }

        console.log('  Connecting to peer...')

        try {
          const res = await fetch(`http://localhost:${PORT}/api/network/connect`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ticket: args.ticket }),
          })
          const data = (await res.json()) as { peerId?: string; error?: string }

          if (data.error) {
            console.error(`  Error: ${data.error}\n`)
            return
          }

          console.log(`  Connected to peer: ${data.peerId}\n`)
          console.log('  Projects on the network:')

          // Fetch network projects
          const projectsRes = await fetch(`http://localhost:${PORT}/api/network/projects`)
          const projects = (await projectsRes.json()) as Array<{
            id: string
            name: string
            ownerId: string
            nodeCount: number
          }>

          if (projects.length === 0) {
            console.log('  No projects found on the network.\n')
          } else {
            for (const p of projects) {
              console.log(`  ${p.name}  ${p.id}  ${p.nodeCount} nodes`)
            }
            console.log()
          }
        } catch (err) {
          console.error(`  Connection failed: ${err instanceof Error ? err.message : err}\n`)
        }
      },
    }),
    open: defineCommand({
      meta: {
        name: 'papyrus projects open',
        description: 'Open the canvas portal (launches daemon + browser).',
      },
      args: {
        project: {
          type: 'string',
          description: 'Project ID to open.',
        },
      },
      async run({ args }) {
        banner('projects open')
        ensureDaemon()

        if (args.project) {
          // Open specific project
          const url = `http://localhost:${PORT}?project=${args.project}`
          console.log(`  Opening project ${args.project}...`)
          openBrowser(url)
          return
        }

        // Open project picker (default page)
        const url = `http://localhost:${PORT}`
        console.log('  Opening Papyrus canvas...')
        openBrowser(url)
        console.log()
      },
    }),
    invite: defineCommand({
      meta: {
        name: 'papyrus projects invite',
        description: 'Generate an invite for another member.',
      },
      args: {
        project: {
          type: 'positional',
          description: 'Project ID to invite to.',
        },
        role: {
          type: 'string',
          description: 'Role to assign (editor, viewer).',
          default: 'editor',
        },
      },
      async run({ args }) {
        banner('projects invite')
        ensureDaemon()

        const token = loadToken()
        if (!token) {
          console.log('  Not authenticated. Run: papyrus auth login\n')
          return
        }

        const projectId = args.project as string | undefined
        if (!projectId) {
          console.log('  Usage: papyrus projects invite <project-id> [role]\n')
          return
        }

        try {
          const res = await fetch(`http://localhost:${PORT}/api/invite/generate`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ projectId, role: args.role }),
          })

          if (!res.ok) {
            const err = (await res.json()) as { error?: string }
            console.error(`  Failed: ${err.error ?? res.statusText}\n`)
            return
          }

          const data = (await res.json()) as {
            inviteCode: string
            projectId: string
            role: string
            expiresAt: string
          }

          console.log(`  Invite code: ${data.inviteCode}`)
          console.log(`  Project: ${data.projectId}`)
          console.log(`  Role: ${data.role}`)
          console.log(`  Expires: ${data.expiresAt}`)
          console.log()
          console.log('  Share this code with the person you want to invite.')
          console.log(`  They can accept with: papyrus projects accept-invite ${data.inviteCode}\n`)
        } catch {
          console.error('  Connection failed. Is the daemon running?\n')
        }
      },
    }),
    'accept-invite': defineCommand({
      meta: {
        name: 'papyrus projects accept-invite',
        description: 'Accept an invite code to join a project.',
      },
      args: {
        code: {
          type: 'positional',
          description: 'Invite code to accept.',
        },
      },
      async run({ args }) {
        banner('projects accept-invite')
        ensureDaemon()

        const token = loadToken()
        if (!token) {
          console.log('  Not authenticated. Run: papyrus auth login\n')
          return
        }

        const code = args.code as string | undefined
        if (!code) {
          console.log('  Usage: papyrus projects accept-invite <invite-code>\n')
          return
        }

        try {
          const res = await fetch(`http://localhost:${PORT}/api/invite/accept`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ inviteCode: code }),
          })

          if (!res.ok) {
            const err = (await res.json()) as { error?: string }
            console.error(`  Failed: ${err.error ?? res.statusText}\n`)
            return
          }

          const data = (await res.json()) as { projectId: string; role: string }
          console.log(`  Joined project: ${data.projectId}`)
          console.log(`  Your role: ${data.role}\n`)
        } catch {
          console.error('  Connection failed. Is the daemon running?\n')
        }
      },
    }),
  },
})
