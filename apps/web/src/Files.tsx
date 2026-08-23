import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FileEntry, FileMount, FileProposal, FileVersion } from '@papyrus/contracts'
import { fileMounts, fileProposals, fileVersions, listManagedFiles, proposeFileChange, publishFileProposal, readManagedFile, rollbackFileVersion } from './api.js'

export function FilesView() {
  const [mounts, setMounts] = useState<FileMount[]>([])
  const [mountId, setMountId] = useState<string>()
  const [path, setPath] = useState('/')
  const [files, setFiles] = useState<FileEntry[]>([])
  const [selected, setSelected] = useState<FileEntry>()
  const [content, setContent] = useState('')
  const [baseSha256, setBaseSha256] = useState('')
  const [versions, setVersions] = useState<FileVersion[]>([])
  const [proposals, setProposals] = useState<FileProposal[]>([])
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const mount = mounts.find((item) => item.id === mountId)

  const loadMounts = useCallback(async () => {
    const next = await fileMounts()
    setMounts(next)
    setMountId((current) => current && next.some((item) => item.id === current) ? current : next[0]?.id)
    setProposals(await fileProposals())
  }, [])

  useEffect(() => { void loadMounts().catch(show) }, [loadMounts])
  useEffect(() => {
    if (!mountId) return
    setSelected(undefined); setContent(''); setVersions([])
    void listManagedFiles(mountId, path).then(setFiles).catch(show)
  }, [mountId, path])

  function show(cause: unknown) { setError(cause instanceof Error ? cause.message : 'File operation failed') }

  const open = async (entry: FileEntry) => {
    if (entry.type === 'directory') { setPath(entry.path); return }
    if (!mountId) return
    setBusy(true); setError(undefined)
    try {
      const result = await readManagedFile(mountId, entry.path)
      const bytes = Uint8Array.from(atob(result.contentBase64), (char) => char.charCodeAt(0))
      if (bytes.some((value) => value === 0)) throw new Error('Binary preview is unavailable; the file remains governed and downloadable through an approved client.')
      setSelected(entry); setContent(new TextDecoder().decode(bytes)); setBaseSha256(result.sha256)
      setVersions(await fileVersions(mountId, entry.path))
    } catch (cause) { show(cause) } finally { setBusy(false) }
  }

  const propose = async () => {
    if (!mountId || !selected) return
    setBusy(true); setError(undefined)
    try {
      const encoded = bytesToBase64(new TextEncoder().encode(content))
      const proposal = await proposeFileChange(mountId, selected.path, baseSha256, encoded)
      setProposals((items) => [proposal, ...items])
    } catch (cause) { show(cause) } finally { setBusy(false) }
  }

  const publish = async (proposal: FileProposal) => {
    setBusy(true); setError(undefined)
    try {
      await publishFileProposal(proposal.id)
      await open(selected!)
      setProposals(await fileProposals())
    } catch (cause) { show(cause); setProposals(await fileProposals().catch(() => proposals)) } finally { setBusy(false) }
  }

  const rollback = async (version: FileVersion) => {
    if (!selected) return
    setBusy(true); setError(undefined)
    try {
      await rollbackFileVersion(version.id, baseSha256)
      await open(selected)
    } catch (cause) { show(cause) } finally { setBusy(false) }
  }

  const pending = useMemo(() => proposals.filter((item) => item.status === 'pending' && item.mountId === mountId), [proposals, mountId])

  if (!mounts.length) return <article className="panel files-empty"><div className="panel-head"><h2>Files</h2><span>0 MOUNTS</span></div><div className="empty">No file mounts are assigned to your identity.</div></article>

  return <section className="files-workspace">
    {error && <div className="error">{error}<button onClick={() => setError(undefined)}>×</button></div>}
    <aside className="files-mounts panel">
      <div className="panel-head"><h2>Mounts</h2><span>{mounts.length}</span></div>
      {mounts.map((item) => <button key={item.id} className={mountId === item.id ? 'active' : ''} onClick={() => { setMountId(item.id); setPath('/') }}><strong>{item.name}</strong><span>{item.access === 'publish' ? 'READ + PUBLISH' : 'READ ONLY'}</span></button>)}
    </aside>
    <article className="files-browser panel">
      <div className="panel-head"><div><h2>{mount?.name}</h2><span>{path}</span></div>{path !== '/' && <button className="secondary compact-button" onClick={() => setPath(parentPath(path))}>Up</button>}</div>
      <div className="file-entry-list">{files.length ? files.map((entry) => <button key={entry.path} onClick={() => void open(entry)} className={selected?.path === entry.path ? 'active' : ''}><span className="file-kind">{entry.type === 'directory' ? 'DIR' : 'FILE'}</span><strong>{entry.name}</strong><span>{entry.type === 'file' ? formatBytes(entry.size) : ''}</span></button>) : <div className="empty">This folder is empty.</div>}</div>
    </article>
    <article className="files-preview panel">
      <div className="panel-head"><div><h2>{selected?.name ?? 'Preview'}</h2>{selected && <span>SHA-256 {baseSha256.slice(0, 16)}…</span>}</div></div>
      {selected ? <>
        <textarea className="file-editor" value={content} readOnly={mount?.access !== 'publish'} onChange={(event) => setContent(event.target.value)} />
        {mount?.access === 'publish' && <div className="file-actions"><button className="primary compact-button" disabled={busy} onClick={() => void propose()}>Propose changes</button><span>Changes remain isolated until you publish them.</span></div>}
      </> : <div className="empty">Select a file to preview it.</div>}
    </article>
    <article className="files-history panel">
      <div className="panel-head"><h2>Changes and versions</h2><span>{pending.length + versions.length}</span></div>
      <div className="admin-list compact">
        {pending.map((proposal) => <article key={proposal.id}><div><strong>Pending · {proposal.path}</strong><span>{proposal.proposedSha256.slice(0, 16)}…</span></div><button className="primary compact-button" disabled={busy} onClick={() => void publish(proposal)}>Publish</button></article>)}
        {versions.map((version) => <article key={version.id}><div><strong>{version.operation === 'rollback' ? 'Rollback checkpoint' : 'Previous version'}</strong><span>{new Date(version.createdAt).toLocaleString()} · {version.sha256.slice(0, 16)}…</span></div>{mount?.access === 'publish' && <button className="secondary compact-button" disabled={busy} onClick={() => void rollback(version)}>Restore</button>}</article>)}
        {!pending.length && !versions.length && <div className="empty">No proposed changes or stored versions for this file.</div>}
      </div>
    </article>
  </section>
}

function parentPath(path: string) { const parts = path.split('/').filter(Boolean); parts.pop(); return '/' + parts.join('/') }
function formatBytes(size: number) { return size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB` }
function bytesToBase64(bytes: Uint8Array) { let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary) }
