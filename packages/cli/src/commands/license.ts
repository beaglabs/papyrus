import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  type LicenseFile,
  generateAuthorityKeyPair,
  loadStoredLicense,
  resolveConfig,
  signLicense,
  storeLicense,
  validateLicense,
} from '@papyrus/core'
import { defineCommand } from 'citty'
import { activeProfile, banner } from './_shared.js'

export default defineCommand({
  meta: {
    name: 'papyrus license',
    description: 'Offline license management: status | activate | validate | generate.',
  },
  subCommands: {
    status: defineCommand({
      meta: { name: 'papyrus license status', description: 'Show the current license status.' },
      run() {
        banner('license status')
        const profile = activeProfile()
        const stored = loadStoredLicense()
        if (!stored) {
          console.log('  No license activated.\n')
          console.log('  Activate one with:  papyrus license activate <license-file.json>\n')
          return
        }
        const status = validateLicense(stored.license, profile)
        console.log(`  License ID : ${stored.license.licenseId}`)
        console.log(`  Licensee   : ${stored.license.licensee}`)
        console.log(`  Profile    : ${stored.license.profile}`)
        console.log(`  Node limit : ${stored.license.nodeLimit}`)
        console.log(`  Expires    : ${stored.license.expiresAt ?? 'never (perpetual)'}`)
        console.log(`  Activated  : ${stored.activatedAt}`)
        console.log(`  Agents     : ${stored.license.features.agents ? 'enabled' : 'disabled'}`)
        console.log(
          `  Cross-Dom  : ${stored.license.features.crossDomainExport ? 'enabled' : 'disabled'}`,
        )
        console.log(
          `  Status     : ${status.valid ? 'VALID' : `INVALID — ${status.reason ?? ''}`}\n`,
        )
      },
    }),

    activate: defineCommand({
      meta: {
        name: 'papyrus license activate',
        description: 'Activate an offline, signed license file.',
      },
      args: {
        file: {
          type: 'positional',
          description: 'Path to the signed license JSON file.',
          required: true,
        },
      },
      run(ctx) {
        banner('license activate')
        const profile = activeProfile()
        const filePath = ctx.args.file as string
        try {
          const raw = readFileSync(filePath, 'utf-8')
          const license = JSON.parse(raw) as LicenseFile
          const status = validateLicense(license, profile)
          if (!status.valid) {
            console.error(`  License validation failed: ${status.reason}\n`)
            process.exitCode = 1
            return
          }
          storeLicense(license)
          console.log(`  License activated: ${license.licenseId}`)
          console.log(`  Licensee  : ${license.licensee}`)
          console.log(`  Profile   : ${license.profile}`)
          console.log(
            `  Features  : agents=${license.features.agents}, crossDomain=${license.features.crossDomainExport}\n`,
          )
        } catch (err) {
          console.error(`  Failed to activate license: ${(err as Error).message}\n`)
          process.exitCode = 1
        }
      },
    }),

    validate: defineCommand({
      meta: { name: 'papyrus license validate', description: 'Re-validate the active license.' },
      run() {
        banner('license validate')
        const profile = activeProfile()
        const stored = loadStoredLicense()
        if (!stored) {
          console.error('  No license to validate. Activate one first.\n')
          process.exitCode = 1
          return
        }
        const status = validateLicense(stored.license, profile)
        if (status.valid) {
          console.log(`  License ${stored.license.licenseId} is VALID for profile "${profile}".\n`)
        } else {
          console.error(`  License INVALID: ${status.reason}\n`)
          process.exitCode = 1
        }
      },
    }),

    generate: defineCommand({
      meta: {
        name: 'papyrus license generate',
        description: 'Generate a test license signed with a fresh authority keypair (dev only).',
      },
      args: {
        licensee: { type: 'string', description: 'Licensee name.', default: 'Test Organization' },
        profile: { type: 'string', description: 'Profile to bind to.', default: 'commercial' },
        output: { type: 'string', description: 'Output file path.', default: 'license.json' },
      },
      run(ctx) {
        banner('license generate (dev)')
        const authority = generateAuthorityKeyPair()
        const license = signLicense(
          {
            licenseId: `papyrus-dev-${Date.now()}`,
            licensee: ctx.args.licensee as string,
            profile: ctx.args.profile as string as 'commercial',
            features: { agents: true, crossDomainExport: true },
            nodeLimit: 100,
            expiresAt: null,
            issuedAt: new Date().toISOString(),
          },
          authority.privateKeyPem,
        )
        const out = ctx.args.output as string
        mkdirSync(dirname(out), { recursive: true })
        writeFileSync(out, JSON.stringify(license, null, 2), 'utf-8')
        console.log(`  License written to: ${out}`)
        console.log(`  License ID : ${license.licenseId}`)
        console.log(`  Licensee   : ${license.licensee}`)
        console.log(`  Profile    : ${license.profile}`)
        console.log(`  Authority  : ${authority.publicKeyPem.slice(0, 40)}...\n`)
      },
    }),
  },
})
