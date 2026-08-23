import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { FileEntry } from '@papyrus/contracts'

export const MAX_MANAGED_FILE_BYTES = 10 * 1024 * 1024

export class ManagedFileRoot {
  readonly root: string

  constructor(rootPath: string) {
    if (!isAbsolute(rootPath)) throw new Error('File mount path must be absolute')
    this.root = realpathSync(rootPath)
    if (dirname(this.root) === this.root) throw new Error('The filesystem root cannot be registered as a file mount')
    if (!statSync(this.root).isDirectory()) throw new Error('File mount path must reference a directory')
  }

  list(mountId: string, requestedPath = '/'): FileEntry[] {
    const directory = this.resolveExisting(requestedPath)
    if (!statSync(directory).isDirectory()) throw new Error('File path is not a directory')
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry): FileEntry[] => {
      if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) return []
      const absolute = this.resolveExisting('/' + relative(this.root, resolve(directory, entry.name)))
      const stats = statSync(absolute)
      const path = '/' + relative(this.root, absolute).split(sep).join('/')
      return [{
        mountId,
        path,
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : 'file',
        size: stats.size,
        modifiedAt: stats.mtime.toISOString(),
        ...(entry.isFile() && stats.size <= MAX_MANAGED_FILE_BYTES ? { sha256: sha256(readFileSync(absolute)) } : {}),
      }]
    })
  }

  read(requestedPath: string): { content: Buffer; sha256: string; modifiedAt: string } {
    const absolute = this.resolveExisting(requestedPath)
    const stats = statSync(absolute)
    if (!stats.isFile()) throw new Error('File path is not a regular file')
    if (stats.size > MAX_MANAGED_FILE_BYTES) throw new Error('File exceeds the 10 MB managed-file limit')
    const content = readFileSync(absolute)
    return { content, sha256: sha256(content), modifiedAt: stats.mtime.toISOString() }
  }

  publish(requestedPath: string, expectedSha256: string, content: Buffer): { previous: Buffer; sha256: string } {
    if (content.length > MAX_MANAGED_FILE_BYTES) throw new Error('Proposed file exceeds the 10 MB managed-file limit')
    const absolute = this.resolveExisting(requestedPath)
    const previous = this.read(requestedPath)
    if (previous.sha256 !== expectedSha256) throw new FileConflictError(previous.sha256)
    const temporary = resolve(dirname(absolute), `.papyrus-${randomUUID()}.tmp`)
    try {
      writeFileSync(temporary, content, { mode: statSync(absolute).mode })
      renameSync(temporary, absolute)
    } catch (error) {
      try { unlinkSync(temporary) } catch {}
      throw error
    }
    return { previous: previous.content, sha256: sha256(content) }
  }

  restore(requestedPath: string, expectedSha256: string, content: Buffer): { previous: Buffer; sha256: string } {
    return this.publish(requestedPath, expectedSha256, content)
  }

  private resolveExisting(requestedPath: string): string {
    if (requestedPath.includes('\0')) throw new Error('Invalid file path')
    const candidate = resolve(this.root, requestedPath.replace(/^[/\\]+/, ''))
    const canonical = realpathSync(candidate)
    if (canonical !== this.root && !canonical.startsWith(this.root + sep)) throw new Error('File path escapes its assigned mount')
    return canonical
  }
}

export class FileConflictError extends Error {
  constructor(readonly currentSha256: string) {
    super('The NAS file changed after this working copy was created')
  }
}

export function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}
