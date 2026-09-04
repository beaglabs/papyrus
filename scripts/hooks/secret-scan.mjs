import { addedLines, stagedPaths } from './git.mjs'

const paths = stagedPaths()
const errors = []
const forbiddenExtensions = /\.(?:pem|key|p12|pfx|p8|der|jks|keystore|kdbx)$/i
const strongPatterns = [
  { name: 'private key material', regex: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  { name: 'GitHub token', regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/ },
  { name: 'OpenAI-style secret key', regex: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'Slack token', regex: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
  { name: 'AWS access key', regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Google API key', regex: /\bAIza[0-9A-Za-z_-]{30,}\b/ },
]
const genericSecret = /\b(api[_-]?key|client[_-]?secret|password|passwd|token|session[_-]?secret|bootstrap[_-]?secret)\b\s*[:=]\s*['"`]([^'"`]{12,})['"`]/i
const safeFixture = /(example|placeholder|changeme|dummy|fake|test[_-]?only|replace[_-]?me|your[_-]?)/i

for (const path of paths) {
  const lower = path.toLowerCase()
  const envFile = lower === '.env' || /(?:^|\/)\.env(?:\.[^/]+)?$/.test(lower)
  const envExample = lower === '.env.example' || lower.endsWith('/.env.example')
  if (envFile && !envExample) {
    errors.push(`${path}: environment files other than .env.example are forbidden`)
  }
  if (forbiddenExtensions.test(path)) errors.push(`${path}: cryptographic key/material files are forbidden`)

  for (const { line, text } of addedLines(path)) {
    for (const pattern of strongPatterns) {
      if (pattern.regex.test(text)) errors.push(`${path}:${line}: possible ${pattern.name}`)
    }
    const generic = text.match(genericSecret)
    if (generic && !safeFixture.test(generic[2])) errors.push(`${path}:${line}: possible hard-coded secret in ${generic[1]}`)
  }
}

if (errors.length) {
  console.error('Secret/key/material scan failed:')
  for (const error of [...new Set(errors)]) console.error(`  - ${error}`)
  console.error('Use environment/secret-store references and keep only non-secret examples in Git.')
  process.exit(1)
}
