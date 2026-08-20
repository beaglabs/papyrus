import { once } from 'node:events'
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import type { Stream } from '@agentclientprotocol/sdk'

const MAX_STDIO_FRAME_BYTES = 1_048_576

/** Transparently bridges newline-delimited ACP on stdio to an ACP stream. */
export async function bridgeAcp(
  stream: Stream,
  input: Readable,
  output: Writable,
  signal?: AbortSignal,
): Promise<void> {
  const lines = createInterface({ input, crlfDelay: Infinity, terminal: false })
  const writer = stream.writable.getWriter()
  const reader = stream.readable.getReader()
  const abort = (): void => {
    lines.close()
    void writer.abort(signal?.reason).catch(() => {})
    void reader.cancel(signal?.reason).catch(() => {})
  }
  signal?.addEventListener('abort', abort, { once: true })

  const upload = async (): Promise<void> => {
    for await (const line of lines) {
      const frame = line.trim()
      if (!frame) continue
      if (Buffer.byteLength(frame) > MAX_STDIO_FRAME_BYTES) {
        throw new Error(`papyrus-connect stdin frame exceeds ${MAX_STDIO_FRAME_BYTES} bytes`)
      }
      let message: unknown
      try {
        message = JSON.parse(frame) as unknown
      } catch {
        throw new Error('papyrus-connect received invalid JSON on stdin')
      }
      if (!message || typeof message !== 'object') {
        throw new Error('papyrus-connect received a non-object ACP frame on stdin')
      }
      await writer.write(message as never)
    }
    await writer.close()
  }

  const download = async (): Promise<void> => {
    for (;;) {
      const next = await reader.read()
      if (next.done) return
      if (!output.write(`${JSON.stringify(next.value)}\n`)) await once(output, 'drain')
    }
  }

  const downloadTask = download()
  try {
    await Promise.race([
      upload().then(() => downloadTask),
      downloadTask.then(() => {
        lines.close()
        void writer.abort(new Error('Remote ACP connection closed')).catch(() => {})
      }),
    ])
  } finally {
    signal?.removeEventListener('abort', abort)
    lines.close()
    await Promise.allSettled([reader.cancel(), writer.abort()])
    reader.releaseLock()
    writer.releaseLock()
  }
}
