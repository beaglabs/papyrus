import { resolveProfile } from '@papyrus/core'
import { defineCommand, runMain } from 'citty'

const main = defineCommand({
  meta: {
    name: 'papyrus',
    version: '0.1.0',
    description:
      'The secure product development canvas for regulated industries and public sector.',
  },
  args: {
    profile: {
      type: 'string',
      description: 'Network profile override (commercial | niprnet-il4 | siprnet-il6).',
      alias: 'p',
    },
  },
  subCommands: {
    auth: () => import('./commands/auth.js').then((m) => m.auth),
    license: () => import('./commands/license.js').then((m) => m.default),
    projects: () => import('./commands/projects.js').then((m) => m.default),
    skills: () => import('./commands/skills.js').then((m) => m.default),
    orgs: () => import('./commands/orgs.js').then((m) => m.default),
    'org-roles': () => import('./commands/org-roles.js').then((m) => m.default),
  },
  run(ctx) {
    const profile = ctx.args.profile
      ? String(ctx.args.profile).toLowerCase()
      : resolveProfile(process.env)
    console.log('\n  PAPYRUS — secure product development canvas')
    console.log(`  active profile: ${profile}\n`)
    console.log('  Usage: papyrus <command> [subcommand] [options]')
    console.log('  Commands:')
    console.log('    auth        login | logout | status | refresh')
    console.log('    license     status | activate | validate')
    console.log('    projects    init | list | share | join | open | invite')
    console.log('    skills      list')
    console.log('    orgs        create | archive | list')
    console.log('    org-roles   add | assign | list | remove | delete\n')
  },
})

runMain(main)
