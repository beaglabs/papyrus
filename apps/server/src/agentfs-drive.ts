import { statSync } from 'node:fs'
import { isAbsolute, normalize, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const FILE_TYPE_MASK = 0o170000
const REGULAR_FILE = 0o100000
const DIRECTORY = 0o040000
const MAX_READ_BYTES = 5 * 1024 * 1024

type Row = Record<string, unknown>

export interface AgentFsEntry {
  name: string
  path: string
  type: 'file' | 'directory'
  size: number
}

/**
 * Read-only adapter for AgentFS specification v0.4 databases.
 * Papyrus never mutates an approved-data drive.
 */
export class AgentFsDriveReader {
  static validate(databasePath: string): void {
    if (!isAbsolute(databasePath)) throw new Error('AgentFS database path must be absolute')
    const file = statSync(databasePath)
    if (!file.isFile()) throw new Error('AgentFS database path must reference a file')
    const db = new DatabaseSync(databasePath, { readOnly: true })
    try {
      const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Row[]).map((row) => String(row.name)))
      for (const required of ['fs_config', 'fs_inode', 'fs_dentry', 'fs_data']) {
        if (!tables.has(required)) throw new Error(`Not an AgentFS database: missing ${required}`)
      }
      const root = db.prepare('SELECT mode FROM fs_inode WHERE ino=1').get() as Row | undefined
      if (!root || (Number(root.mode) & FILE_TYPE_MASK) !== DIRECTORY) throw new Error('Not an AgentFS database: invalid root inode')
    } finally {
      db.close()
    }
  }

  constructor(private readonly databasePath: string) {}

  list(path = '/'): AgentFsEntry[] {
    const normalized = safePath(path)
    const db = this.open()
    try {
      const inode = resolveInode(db, normalized)
      if ((Number(inode.mode) & FILE_TYPE_MASK) !== DIRECTORY) throw new Error('AgentFS path is not a directory')
      return (db.prepare(`SELECT d.name,i.mode,i.size FROM fs_dentry d
        JOIN fs_inode i ON i.ino=d.ino WHERE d.parent_ino=? ORDER BY d.name`).all(Number(inode.ino)) as Row[])
        .flatMap((row): AgentFsEntry[] => {
          const kind = Number(row.mode) & FILE_TYPE_MASK
          if (kind !== REGULAR_FILE && kind !== DIRECTORY) return []
          return [{
            name: String(row.name),
            path: normalized === '/' ? `/${String(row.name)}` : `${normalized}/${String(row.name)}`,
            type: kind === DIRECTORY ? 'directory' : 'file',
            size: Number(row.size),
          }]
        })
    } finally {
      db.close()
    }
  }

  read(path: string, encoding: 'utf-8' | 'base64' = 'utf-8'): { content: string; size: number } {
    const normalized = safePath(path)
    if (normalized === '/') throw new Error('AgentFS path must reference a file')
    const db = this.open()
    try {
      const inode = resolveInode(db, normalized)
      if ((Number(inode.mode) & FILE_TYPE_MASK) !== REGULAR_FILE) throw new Error('AgentFS path is not a regular file')
      const size = Number(inode.size)
      if (!Number.isSafeInteger(size) || size < 0 || size > MAX_READ_BYTES) throw new Error('AgentFS file exceeds the 5 MB read limit')
      const chunks = (db.prepare('SELECT data FROM fs_data WHERE ino=? ORDER BY chunk_index').all(Number(inode.ino)) as Row[])
        .map((row) => Buffer.from(row.data as Uint8Array))
      const bytes = Buffer.concat(chunks)
      if (bytes.length !== size) throw new Error('AgentFS file size does not match stored chunks')
      return { content: bytes.toString(encoding === 'base64' ? 'base64' : 'utf8'), size }
    } finally {
      db.close()
    }
  }

  private open(): DatabaseSync {
    return new DatabaseSync(this.databasePath, { readOnly: true })
  }
}

function safePath(value: string): string {
  if (value.includes('\0')) throw new Error('Invalid AgentFS path')
  const normalized = normalize('/' + value.replaceAll('\\', '/')).replaceAll('\\', '/')
  const absolute = resolve('/', normalized).replaceAll('\\', '/')
  if (!absolute.startsWith('/')) throw new Error('AgentFS path traversal is not allowed')
  return absolute
}

function resolveInode(db: DatabaseSync, path: string): Row {
  let inode = db.prepare('SELECT ino,mode,size FROM fs_inode WHERE ino=1').get() as Row | undefined
  if (!inode) throw new Error('AgentFS root inode is missing')
  for (const part of path.split('/').filter(Boolean)) {
    inode = db.prepare(`SELECT i.ino,i.mode,i.size FROM fs_dentry d
      JOIN fs_inode i ON i.ino=d.ino WHERE d.parent_ino=? AND d.name=?`).get(Number(inode.ino), part) as Row | undefined
    if (!inode) throw new Error('AgentFS path not found')
  }
  return inode
}
