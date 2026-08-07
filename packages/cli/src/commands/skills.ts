import { AI_SKILLS } from '@papyrus/core'
import { defineCommand } from 'citty'
import { banner } from './_shared.js'

export default defineCommand({
  meta: { name: 'papyrus skills', description: 'List available AI Skills.' },
  subCommands: {
    list: defineCommand({
      meta: { name: 'papyrus skills list', description: 'List available AI Skills.' },
      run: () => {
        banner('skills list')
        for (const s of AI_SKILLS) {
          console.log(
            `  ${s.id.padEnd(24)} ${s.consumes.join('+') || '\u{2014}'}  \u{2192}  ${s.produces.join('+') || '\u{2014}'}`,
          )
        }
        console.log('')
      },
    }),
  },
  run() {
    banner('skills')
    for (const s of AI_SKILLS) {
      console.log(`  ${s.id.padEnd(24)} ${s.consumes.join('+') || '\u{2014}'}  \u{2192}  ${s.produces.join('+') || '\u{2014}'}`)
    }
    console.log('')
  },
})
