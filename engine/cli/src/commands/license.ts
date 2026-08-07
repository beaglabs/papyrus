import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LicenseFile, LicenseStatus } from '@papyrus/core'
import { defineCommand } from 'citty'
import { banner } from './_shared.js'

const PORT = Number(process.env.PAPYRUS_PORT ?? 3777)
const BASE_URL = `http://localhost:${PORT}`

async function ensureDaemon(): Promise<void> {
  try {
    const response = await fetch(`${BASE_URL}/api/health`)
    if (response.ok) return
  } catch {
    const daemon = spawn(
      'node',
      ['--import', 'tsx', join(import.meta.dirname, '../../../daemon/src/server.ts')],
      { detached: true, stdio: 'ignore' },
    )
    daemon.unref()
  }
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      if ((await fetch(`${BASE_URL}/api/health`)).ok) return
    } catch {
      /* daemon is starting */
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Papyrus daemon did not start')
}

async function getJson<T>(path: string): Promise<T> {
  await ensureDaemon()
  const response = await fetch(`${BASE_URL}${path}`)
  if (!response.ok) throw new Error(`Daemon returned ${response.status}`)
  return response.json() as Promise<T>
}

export default defineCommand({
  meta: {
    name: 'papyrus license',
    description: 'Offline license management: status | request | activate | validate.',
  },
  subCommands: {
    status: defineCommand({
      meta: { name: 'papyrus license status', description: 'Show license and deployment status.' },
      async run() {
        banner('license status')
        try {
          const status = await getJson<LicenseStatus>('/api/license/status')
          console.log(`  Deployment : ${status.deploymentId}`)
          console.log(`  License ID : ${status.licenseId ?? 'none'}`)
          console.log(`  Licensee   : ${status.licensee ?? 'none'}`)
          console.log(`  Profile    : ${status.profile ?? 'unlicensed'}`)
          console.log(`  Expires    : ${status.expiresAt ?? 'never / not installed'}`)
          console.log(
            `  Status     : ${status.valid ? 'VALID' : `INVALID — ${status.reason ?? 'unknown'}`}\n`,
          )
        } catch (error) {
          console.error(`  ${(error as Error).message}\n`)
          process.exitCode = 1
        }
      },
    }),
    request: defineCommand({
      meta: {
        name: 'papyrus license request',
        description: 'Print the offline deployment activation request.',
      },
      async run() {
        banner('license request')
        try {
          console.log(`${JSON.stringify(await getJson('/api/license/request'), null, 2)}\n`)
        } catch (error) {
          console.error(`  ${(error as Error).message}\n`)
          process.exitCode = 1
        }
      },
    }),
    activate: defineCommand({
      meta: {
        name: 'papyrus license activate',
        description: 'Install an offline Beag Labs-signed license.',
      },
      args: {
        file: {
          type: 'positional',
          description: 'Path to the signed license JSON file.',
          required: true,
        },
      },
      async run(ctx) {
        banner('license activate')
        try {
          await ensureDaemon()
          const license = JSON.parse(readFileSync(ctx.args.file as string, 'utf8')) as LicenseFile
          const response = await fetch(`${BASE_URL}/api/license/activate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(license),
          })
          const status = (await response.json()) as LicenseStatus
          if (!response.ok || !status.valid)
            throw new Error(status.reason ?? 'License activation failed')
          console.log(`  Activated ${status.licenseId} for ${status.licensee}.\n`)
        } catch (error) {
          console.error(`  ${(error as Error).message}\n`)
          process.exitCode = 1
        }
      },
    }),
    validate: defineCommand({
      meta: { name: 'papyrus license validate', description: 'Revalidate the installed license.' },
      async run() {
        try {
          const status = await getJson<LicenseStatus>('/api/license/status')
          if (!status.valid) throw new Error(status.reason ?? 'License is invalid')
          console.log(
            `  License ${status.licenseId} is VALID for deployment ${status.deploymentId}.\n`,
          )
        } catch (error) {
          console.error(`  ${(error as Error).message}\n`)
          process.exitCode = 1
        }
      },
    }),
  },
})
