export interface WorkerConfig {
  host: string
  port: number
  command: string
  args: string[]
  token?: string
  tls?: { certPath: string; keyPath: string; caPath: string }
  /** Lowercase, colon-stripped SHA-256 client certificate fingerprints to allow. */
  allowFingerprints?: string[]
}

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is required`)
  return value
}

export function loadConfig(env = process.env): WorkerConfig {
  const host = env.PAPYRUS_WORKER_HOST ?? '127.0.0.1'
  const port = Number(env.PAPYRUS_WORKER_PORT ?? 3211)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('Invalid PAPYRUS_WORKER_PORT')
  const command = env.PAPYRUS_WORKER_GOOSE_COMMAND ?? 'goose'
  const args = (env.PAPYRUS_WORKER_GOOSE_ARGS ?? 'acp').split(',').map((item) => item.trim()).filter(Boolean)
  const tls = env.PAPYRUS_WORKER_TLS_CERT ? {
    certPath: env.PAPYRUS_WORKER_TLS_CERT,
    keyPath: required('PAPYRUS_WORKER_TLS_KEY', env.PAPYRUS_WORKER_TLS_KEY),
    caPath: required('PAPYRUS_WORKER_TLS_CA', env.PAPYRUS_WORKER_TLS_CA),
  } : undefined
  const allowFingerprints = env.PAPYRUS_WORKER_ALLOW_FINGERPRINTS
    ? env.PAPYRUS_WORKER_ALLOW_FINGERPRINTS.split(',').map((item) => item.trim().replace(/:/g, '').toLowerCase()).filter(Boolean)
    : undefined
  return {
    host,
    port,
    command,
    args,
    ...(env.PAPYRUS_WORKER_TOKEN ? { token: env.PAPYRUS_WORKER_TOKEN } : {}),
    ...(tls ? { tls } : {}),
    ...(allowFingerprints?.length ? { allowFingerprints } : {}),
  }
}
