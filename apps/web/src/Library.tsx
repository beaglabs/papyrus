import { useEffect, useState } from 'react'
import { workspaceFileContentUrl, workspaceFilesPage, type WorkspaceLibraryFile } from './api.js'
import { Alert, Badge, Button, Input, Skeleton } from './components/ui/index.js'

const PAGE_SIZE = 60

export function LibraryView() {
  const [query, setQuery] = useState('')
  const [files, setFiles] = useState<WorkspaceLibraryFile[]>([])
  const [total, setTotal] = useState(0)
  const [nextOffset, setNextOffset] = useState<number>()
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    let active = true
    const timer = window.setTimeout(() => {
      setLoading(true)
      setError(undefined)
      workspaceFilesPage(query, 0, PAGE_SIZE).then((page) => {
        if (!active) return
        setFiles(page.files)
        setTotal(page.total)
        setNextOffset(page.nextOffset)
      }).catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : 'Unable to read AgentFS Library')
      }).finally(() => { if (active) setLoading(false) })
    }, query.trim() ? 160 : 0)
    return () => { active = false; window.clearTimeout(timer) }
  }, [query])

  const loadMore = async () => {
    if (nextOffset === undefined || loadingMore) return
    setLoadingMore(true)
    setError(undefined)
    try {
      const page = await workspaceFilesPage(query, nextOffset, PAGE_SIZE)
      setFiles((current) => [...current, ...page.files])
      setTotal(page.total)
      setNextOffset(page.nextOffset)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to read more AgentFS files')
    } finally {
      setLoadingMore(false)
    }
  }

  return <div className="library-view">
    <section className="surface-intro">
      <div><p className="eyebrow">AGENTFS · LOCAL SQLITE</p><h2>Library</h2><p>Durable files created or attached in Agent sessions. Files remain inside the customer-hosted AgentFS authority; this page is a browser, not a second storage system.</p></div>
      <Input className="library-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search files or paths…" aria-label="Search Library" />
    </section>
    {error && <Alert className="error">{error}</Alert>}
    <section className="library-browser" aria-busy={loading}>
      <div className="library-browser-head"><span>Name</span><span>Size</span><span>Modified</span><span>Actions</span></div>
      <div className="library-file-list">
        {loading && files.length === 0 ? <LibrarySkeleton /> : files.length === 0 ? <div className="library-empty-page"><span>▤</span><h3>{query ? 'No matching files' : 'Library is empty'}</h3><p>{query ? 'Try a different file name or AgentFS path.' : 'Files generated or attached in Agent chat will appear here automatically.'}</p></div> : files.map((file) => <LibraryFileRow file={file} key={file.path} />)}
      </div>
      <div className="library-browser-foot"><small>{files.length} of {total} files shown · /Library</small>{nextOffset !== undefined ? <Button variant="ghost" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? 'Loading…' : 'Load more'}</Button> : <Badge>{total} FILES</Badge>}</div>
    </section>
  </div>
}

function LibraryFileRow({ file }: { file: WorkspaceLibraryFile }) {
  const inline = workspaceFileContentUrl(file.path)
  const download = workspaceFileContentUrl(file.path, true)
  return <article className="library-file-row">
    <div className="library-file-main"><span className="library-kind-icon">{fileKind(file)}</span><span><strong>{file.name}</strong><small>{file.path}</small></span></div>
    <span className="library-file-meta">{formatBytes(file.size)}</span>
    <span className="library-file-meta">{new Date(file.updatedAt).toLocaleDateString()}</span>
    <div className="library-file-actions"><a href={inline} target="_blank" rel="noreferrer">Open</a><a href={download}>Download</a></div>
  </article>
}

function LibrarySkeleton() {
  return <div className="library-loading">{Array.from({ length: 7 }, (_, index) => <Skeleton className="skeleton-content-line" key={index} />)}</div>
}

function fileKind(file: WorkspaceLibraryFile): string {
  const extension = file.name.split('.').pop()?.toUpperCase()
  if (extension && extension.length <= 5 && extension !== file.name.toUpperCase()) return extension
  if (file.mediaType.startsWith('image/')) return 'IMG'
  if (file.mediaType.startsWith('video/')) return 'VID'
  if (file.mediaType.startsWith('text/')) return 'TXT'
  return 'FILE'
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`
}
