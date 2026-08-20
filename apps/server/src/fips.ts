import { getFips } from 'node:crypto'

export function assertContainerFips(enabled = getFips()): void {
  if (enabled !== 1) throw new Error('Papyrus hardened container requires Node.js FIPS mode')
}
