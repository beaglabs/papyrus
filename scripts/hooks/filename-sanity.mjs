import { trackedPaths } from './git.mjs'

const errors = []
const seen = new Map()
for (const path of trackedPaths()) {
  if (path !== path.normalize('NFC')) errors.push(`${path}: path is not Unicode NFC normalized`)
  if (/[. ](?:\/|$)/.test(path)) errors.push(`${path}: path segment may not end with a dot or space`)
  if (/[<>:"|?*\x00-\x1f]/.test(path)) errors.push(`${path}: contains a cross-platform unsafe filename character`)
  if (path.split('/').some((part) => part.length > 120)) errors.push(`${path}: path segment exceeds 120 characters`)
  const folded = path.toLocaleLowerCase('en-US')
  const prior = seen.get(folded)
  if (prior && prior !== path) errors.push(`${path}: case-collides with ${prior}`)
  else seen.set(folded, path)
}
if (errors.length) {
  console.error('Filename/case/path sanity failed:')
  for (const error of errors) console.error(`  - ${error}`)
  process.exit(1)
}
