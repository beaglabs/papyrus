import { useEffect, useState } from 'react'
import type { ResearchSource } from '@papyrus/contracts'
import { researchSources } from './api.js'

export function SourcesView() {
  const [sources, setSources] = useState<ResearchSource[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  useEffect(() => {
    void researchSources().then(setSources).catch((cause) => setError(cause instanceof Error ? cause.message : 'Unable to load sources')).finally(() => setLoading(false))
  }, [])
  if (loading) return <div className="empty">Loading governed sources…</div>
  if (error) return <div className="error">{error}</div>
  return <SourceList sources={sources} empty="Browser evidence captured by your authorized sessions will appear here." />
}

export function SourceList({ sources, empty }: { sources: ResearchSource[]; empty?: string }) {
  return <div className="source-view">{sources.length ? sources.map((source) => <article key={`${source.sessionId}-${source.id}`}><div className="source-host">{source.host}</div><div><strong>{source.title}</strong><a href={source.url} target="_blank" rel="noreferrer">{source.url}</a>{source.excerpt && <p>{source.excerpt}</p>}<span>Captured {new Date(source.capturedAt).toLocaleString()} · event {source.sequence}</span></div></article>) : <div className="conversation-empty"><h2>No research sources yet.</h2><p>{empty ?? 'Sources emitted by governed browser research will appear here.'}</p></div>}</div>
}
