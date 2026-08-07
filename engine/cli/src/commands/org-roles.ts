import { defineCommand } from 'citty'
import { stub } from './_shared.js'

export default defineCommand({
  meta: {
    name: 'papyrus org-roles',
    description: 'Organization RBAC: add | assign | list | remove | delete.',
  },
  subCommands: {
    add: defineCommand({
      meta: { name: 'papyrus org-roles add', description: 'Define a role within an organization.' },
      run: stub('org-roles add'),
    }),
    assign: defineCommand({
      meta: { name: 'papyrus org-roles assign', description: 'Assign a role to a member.' },
      run: stub('org-roles assign'),
    }),
    list: defineCommand({
      meta: { name: 'papyrus org-roles list', description: 'List roles and assignments.' },
      run: stub('org-roles list'),
    }),
    remove: defineCommand({
      meta: {
        name: 'papyrus org-roles remove',
        description: 'Remove a role assignment from a member.',
      },
      run: stub('org-roles remove'),
    }),
    delete: defineCommand({
      meta: { name: 'papyrus org-roles delete', description: 'Delete a role definition.' },
      run: stub('org-roles delete'),
    }),
  },
})
