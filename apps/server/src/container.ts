import { assertContainerFips } from './fips.js'

assertContainerFips()
await import('./index.js')
