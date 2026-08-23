import { useEffect, useState, type FormEvent } from 'react'
import type { ApprovedSource, SourceSearchResult } from '@papyrus/contracts'
import { approvedSources, searchApprovedSources } from './api.js'

export function SourcesView() {
  const [sources,setSources]=useState<ApprovedSource[]>([])
  const [results,setResults]=useState<SourceSearchResult[]>([])
  const [loading,setLoading]=useState(true)
  const [searching,setSearching]=useState(false)
  const [error,setError]=useState<string>()
  useEffect(()=>{void approvedSources().then(setSources).catch(show).finally(()=>setLoading(false))},[])
  function show(cause:unknown){setError(cause instanceof Error?cause.message:'Unable to load approved sources')}
  async function search(event:FormEvent<HTMLFormElement>){
    event.preventDefault(); const query=String(new FormData(event.currentTarget).get('query')??'').trim()
    if(!query)return
    setSearching(true);setError(undefined)
    try{setResults(await searchApprovedSources(query))}catch(cause){show(cause)}finally{setSearching(false)}
  }
  if(loading)return <div className="empty">Loading approved sources…</div>
  return <div className="approved-sources-view">
    <section className="source-catalog">
      <div className="section-heading"><div><p className="eyebrow">YOUR ACCESS</p><h2>Approved sources</h2></div><span>{sources.length}</span></div>
      {sources.length?<div className="source-cards">{sources.map(source=><article key={source.id}>
        <div><strong>{source.name}</strong><span className="source-kind">{source.kind}</span></div>
        <code>{source.locator}</code>
        <p>{source.documentCount} indexed {source.documentCount===1?'document':'documents'} · {source.mode}</p>
      </article>)}</div>:<div className="conversation-empty"><h2>No sources assigned.</h2><p>An Owner or Admin can assign approved uploads, directories, domains, MCP connectors, packages, or APIs to your identity.</p></div>}
    </section>
    <section className="source-search">
      <form onSubmit={search}><input name="query" aria-label="Search approved sources" placeholder="Search only the sources you can access…" /><button className="primary" disabled={searching||!sources.length}>{searching?'Searching…':'Search'}</button></form>
      {error&&<div className="error">{error}</div>}
      <div className="source-results">{results.map(result=><article key={result.chunkId}>
        <p>{result.content}</p>
        <footer><strong>{result.citation.sourceName}</strong><span>{result.citation.title}{result.citation.location?' · '+result.citation.location:''}</span><code>{result.citation.sha256.slice(0,16)}</code></footer>
      </article>)}</div>
    </section>
  </div>
}
