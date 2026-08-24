import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import type { ContentBlock } from '@agentclientprotocol/sdk'
import { BrowserViewer } from '@mastra/browser-viewer'
import { LocalFilesystem, LocalSandbox, Workspace, WORKSPACE_TOOLS } from '@mastra/core/workspace'
import type { ServerConfig } from '../config.js'

const SESSION_SKILL = `---
name: papyrus-session
description: Work safely inside the current governed Papyrus session.
---

# Papyrus session workspace

- Keep generated and edited files inside this workspace.
- Read a file before overwriting it and preserve unrelated content.
- Use workspace search for uploaded files and workspace notes.
- Use LSP inspection for code navigation and diagnostics.
- Use the browser-use CLI for web tasks. It connects to the session-scoped browser exposed by Mastra.
- Approved organization sources and MCP integrations are available only through the papyrus_* tools. Never try to bypass their approval or authorization result.
`

export class PapyrusWorkspaceManager {
  readonly browser: BrowserViewer
  private readonly workspaces = new Map<string, Promise<Workspace>>()
  private readonly root: string
  private readonly isolation: 'none' | 'bwrap' | 'seatbelt'

  constructor(private readonly config: ServerConfig) {
    this.root = resolve(config.dataDir, 'workspaces')
    this.browser = new BrowserViewer({
      cli: 'browser-use',
      scope: 'thread',
      headless: process.env.PAPYRUS_BROWSER_HEADLESS !== 'false',
      ...(process.env.PAPYRUS_BROWSER_EXECUTABLE ? { executablePath: process.env.PAPYRUS_BROWSER_EXECUTABLE } : {}),
    })
    const detected = LocalSandbox.detectIsolation()
    if (!detected.available && config.mode === 'persistent') {
      throw new Error(`Mastra sandbox isolation is required in persistent mode: ${detected.message}`)
    }
    this.isolation = detected.available ? detected.backend : 'none'
  }

  async forSession(sessionId: string): Promise<Workspace> {
    if (!/^[0-9a-f-]{36}$/i.test(sessionId)) throw new Error('A valid Papyrus session is required for workspace access')
    let pending = this.workspaces.get(sessionId)
    if (!pending) {
      pending = this.create(sessionId)
      this.workspaces.set(sessionId, pending)
      pending.catch(() => this.workspaces.delete(sessionId))
    }
    return await pending
  }

  async stagePrompt(sessionId: string, prompt: string | ContentBlock[]): Promise<void> {
    if (typeof prompt === 'string') return
    const workspace = await this.forSession(sessionId)
    const filesystem = workspace.filesystem
    if (!filesystem) return
    let index = 0
    for (const block of prompt) {
      if (block.type === 'text' || block.type === 'resource_link') continue
      const fallback = `${++index}.${extensionFor((block.type === 'resource' ? block.resource.mimeType : block.mimeType) ?? 'application/octet-stream')}`
      const name = safeName(block.type === 'resource' ? uriName(block.resource.uri) : undefined, fallback)
      const content = block.type === 'resource'
        ? ('text' in block.resource ? block.resource.text : Buffer.from(block.resource.blob, 'base64'))
        : Buffer.from(block.data, 'base64')
      await filesystem.writeFile(`attachments/${name}`, content)
    }
  }

  async snapshotArtifacts(sessionId: string): Promise<Map<string, number>> {
    const files = await this.workspaceFiles(sessionId)
    return new Map(files.map((file) => [file.path, file.modified]))
  }

  async artifactsSince(sessionId: string, baseline: Map<string, number>): Promise<Array<{ path: string; mediaType: string; data: string }>> {
    const files = await this.workspaceFiles(sessionId)
    const changed = files.filter((file) => baseline.get(file.path) !== file.modified && file.size <= 10 * 1024 * 1024)
    return await Promise.all(changed.map(async (file) => ({
      path: file.path,
      mediaType: mediaTypeFor(file.path),
      data: (await readFile(file.absolute)).toString('base64'),
    })))
  }

  private async workspaceFiles(sessionId: string): Promise<Array<{ path: string; absolute: string; modified: number; size: number }>> {
    await this.forSession(sessionId)
    const root = join(this.root, sessionId)
    const files: Array<{ path: string; absolute: string; modified: number; size: number }> = []
    const visit = async (directory: string, prefix = ''): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (!prefix && (entry.name === 'attachments' || entry.name === 'skills' || entry.name.startsWith('.'))) continue
        const path = prefix ? `${prefix}/${entry.name}` : entry.name
        const absolute = join(directory, entry.name)
        if (entry.isDirectory()) await visit(absolute, path)
        else if (entry.isFile()) {
          const metadata = await stat(absolute)
          files.push({ path, absolute, modified: metadata.mtimeMs, size: metadata.size })
        }
      }
    }
    await visit(root)
    return files
  }

  private async create(sessionId: string): Promise<Workspace> {
    const root = join(this.root, sessionId)
    await mkdir(join(root, 'skills', 'papyrus-session'), { recursive: true })
    await mkdir(join(root, 'attachments'), { recursive: true })
    await writeFile(join(root, 'skills', 'papyrus-session', 'SKILL.md'), SESSION_SKILL, { flag: 'w' })
    const workspace = new Workspace({
      id: `papyrus-${sessionId}`,
      name: `Papyrus session ${sessionId}`,
      filesystem: new LocalFilesystem({ basePath: root, contained: true }),
      sandbox: new LocalSandbox({
        workingDirectory: root,
        isolation: this.isolation,
        ...(this.isolation === 'none' ? {} : { nativeSandbox: {
          // browser-use connects to BrowserViewer over its session-scoped CDP
          // endpoint and the browser itself needs outbound access.
          allowNetwork: true,
          allowSystemBinaries: true,
          readWritePaths: [root],
        } }),
      }),
      browser: this.browser,
      bm25: true,
      searchIndexName: `papyrus_ws_${sessionId.replaceAll('-', '_')}`,
      autoIndexPaths: ['attachments'],
      skills: ['skills'],
      lsp: { root },
      tools: {
        enabled: true,
        requireApproval: false,
        [WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE]: { requireReadBeforeWrite: true },
        [WORKSPACE_TOOLS.FILESYSTEM.DELETE]: { enabled: false },
        [WORKSPACE_TOOLS.SEARCH.INDEX]: { enabled: false },
      },
    })
    await workspace.init()
    return workspace
  }
}

function uriName(uri: string): string | undefined {
  try { return decodeURIComponent(new URL(uri).pathname.split('/').at(-1) ?? '') || undefined }
  catch { return undefined }
}

function safeName(value: string | undefined, fallback: string): string {
  const cleaned = basename(value ?? fallback).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 180)
  return cleaned || fallback
}

function extensionFor(mediaType: string): string {
  return mediaType === 'application/pdf' ? 'pdf'
    : mediaType.includes('json') ? 'json'
    : mediaType.startsWith('image/') ? mediaType.split('/')[1] ?? 'img'
    : mediaType.startsWith('audio/') ? mediaType.split('/')[1] ?? 'audio'
    : 'bin'
}

function mediaTypeFor(path: string): string {
  const extension = path.toLowerCase().split('.').at(-1)
  return ({
    pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    svg: 'image/svg+xml', json: 'application/json', csv: 'text/csv', html: 'text/html', md: 'text/markdown', txt: 'text/plain',
  } as Record<string, string>)[extension ?? ''] ?? 'application/octet-stream'
}
