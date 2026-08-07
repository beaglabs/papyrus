import { type NetworkProfile, resolveProfile } from '@papyrus/core'

/** Header used by interactive commands; keeps the neobrutalist feel in the terminal. */
export function banner(title: string): void {
  console.log(`\n  PAPYRUS · ${title}\n  ${'─'.repeat(Math.max(8, title.length + 2))}\n`)
}

/** Standard "not implemented yet" message for P0 stubs. */
export function stub(name: string): () => void {
  return () => {
    banner(name)
    console.log('  Not implemented yet (P0 stub). The daemon wiring lands in P2.\n')
  }
}

/** Active network profile, for reference in command output. */
export function activeProfile(): NetworkProfile {
  return resolveProfile(process.env)
}
