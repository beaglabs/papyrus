import { addedLines, stagedPaths } from '../../../scripts/hooks/git.mjs'

const errors = []
for (const path of stagedPaths().filter((path) => path.startsWith('apps/web/src/') && path.endsWith('.tsx'))) {
  for (const item of addedLines(path)) {
    const line = item.text
    if (/<img\b/i.test(line) && !/\balt\s*=/.test(line)) errors.push(`${path}:${item.line}: <img> requires alt`)
    if (/target\s*=\s*["']_blank["']/.test(line) && !/rel\s*=\s*["'][^"']*(?:noopener|noreferrer)/.test(line)) errors.push(`${path}:${item.line}: target="_blank" requires rel`)
    if (/<(?:div|span|li|p)\b[^>]*\bonClick=/.test(line) && !/\brole=/.test(line)) errors.push(`${path}:${item.line}: clickable non-button element requires an interactive role; prefer <button>`)
  }
}
if (errors.length) {
  console.error('Frontend accessibility guard failed:')
  for (const error of errors) console.error(`  - ${error}`)
  process.exit(1)
}
