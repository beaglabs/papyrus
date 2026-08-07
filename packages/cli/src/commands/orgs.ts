import { defineCommand } from 'citty'
import { stub } from './_shared.js'

export default defineCommand({
  meta: {
    name: 'papyrus orgs',
    description: 'Organization (tenant) management: create | archive | list.',
  },
  subCommands: {
    create: defineCommand({
      meta: {
        name: 'papyrus orgs create',
        description: 'Create an organization (backed by p2panda-auth).',
      },
      run: stub('orgs create'),
    }),
    archive: defineCommand({
      meta: { name: 'papyrus orgs archive', description: 'Archive an organization.' },
      run: stub('orgs archive'),
    }),
    list: defineCommand({
      meta: { name: 'papyrus orgs list', description: 'List organizations you belong to.' },
      run: stub('orgs list'),
    }),
  },
})
