import { describe, expect, it } from 'vitest'
import { assertContainerFips } from '../src/fips.js'

describe('hardened container FIPS gate', () => {
  it('accepts only an enabled FIPS provider', () => {
    expect(() => assertContainerFips(1)).not.toThrow()
    expect(() => assertContainerFips(0)).toThrow(/requires Node.js FIPS mode/)
  })
})
