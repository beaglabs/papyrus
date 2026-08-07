import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DeploymentIdentity } from './types.js'

const DEFAULT_CONFIG_DIR = join(process.env.HOME ?? '.', '.papyrus')
const IDENTITY_FILE = 'deployment-identity.json'

export function deploymentFingerprint(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' })
  return createHash('sha256').update(der).digest('hex')
}

export function loadOrGenerateDeploymentIdentity(dir = DEFAULT_CONFIG_DIR): DeploymentIdentity {
  const path = join(dir, IDENTITY_FILE)
  if (existsSync(path)) {
    const identity = JSON.parse(readFileSync(path, 'utf8')) as DeploymentIdentity
    const derivedPublicKey = createPublicKey(identity.privateKeyPem).export({
      type: 'spki',
      format: 'pem',
    })
    if (derivedPublicKey !== identity.publicKeyPem) {
      throw new Error('Deployment identity keypair mismatch')
    }
    if (deploymentFingerprint(identity.publicKeyPem) !== identity.deploymentId)
      throw new Error('Deployment identity fingerprint mismatch')
    return identity
  }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  const identity: DeploymentIdentity = {
    publicKeyPem: publicKey,
    privateKeyPem: privateKey,
    deploymentId: deploymentFingerprint(publicKey),
    createdAt: new Date().toISOString(),
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(path, JSON.stringify(identity, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  })
  return identity
}
