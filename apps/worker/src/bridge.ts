import { spawn } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { ndJsonStream, type Stream as AcpStream } from '@agentclientprotocol/sdk'

export interface GooseBridgeOptions {
  command: string
  args: string[]
  /** Environment injected into the `goose acp` child for this connection. */
  env: Record<string, string>
  onStderr?: (chunk: string) => void
}

/**
 * Transparent ACP relay between an inbound client connection (handed to us by
 * `AcpServer`) and a `goose acp` child process over stdio NDJSON.
 *
 * It moves JSON-RPC messages in both directions without interpreting them, so
 * goose remains the single ACP implementation. `initialize` and session
 * messages pass through verbatim.
 */
export class GooseBridge {
  constructor(private readonly options: GooseBridgeOptions) {}

  connect(stream: AcpStream, _connectOptions?: unknown): { closed: Promise<void> } {
    const child = spawn(this.options.command, this.options.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this.options.env },
    })
    const goose = ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    )
    child.stderr.on('data', (chunk) => this.options.onStderr?.(String(chunk).slice(0, 4_096)))

    const aborter = new AbortController()
    // Papyrus -> goose
    const forward = stream.readable.pipeTo(goose.writable, { signal: aborter.signal }).catch(() => {})
    // goose -> Papyrus
    const backward = goose.readable.pipeTo(stream.writable, { signal: aborter.signal }).catch(() => {})

    let settled = false
    const closed = new Promise<void>((resolve) => {
      const finish = () => {
        if (settled) return
        settled = true
        aborter.abort()
        try { child.kill('SIGKILL') } catch { /* already gone */ }
        void stream.writable.close().catch(() => {})
        void goose.writable.close().catch(() => {})
        resolve()
      }
      child.once('exit', () => finish())
      void forward.then(() => finish())
      void backward.then(() => finish())
    })

    return { closed }
  }
}
