import { useEffect, useState, type FormEvent } from 'react'
import type { ApprovedSource, ResearchSource, SourceSearchResult } from '@papyrus/contracts'
import { approvedSources, searchApprovedSources } from './api.js'
import { Alert, Badge, Button, Card, Input } from './components/ui/index.js'

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
    <Card className="source-catalog">
      <div className="section-heading"><div><p className="eyebrow">YOUR ACCESS</p><h2>Approved sources</h2></div><span>{sources.length}</span></div>
      {sources.length?<div className="source-cards">{sources.map(source=><Card key={source.id}>
        <div><strong>{source.name}</strong><Badge className="source-kind">{source.kind}</Badge></div>
        <code>{source.locator}</code>
        <p>{source.documentCount} indexed {source.documentCount===1?'document':'documents'} · {source.mode}</p>
      </Card>)}</div>:<div className="conversation-empty"><h2>No sources assigned.</h2><p>An Owner or Admin can assign approved uploads, directories, domains, MCP connectors, packages, or APIs to your identity.</p></div>}
    </Card>
    <Card className="source-search">
      <form onSubmit={search}><Input name="query" aria-label="Search approved sources" placeholder="Search only the sources you can access…" /><Button className="primary" disabled={searching||!sources.length}>{searching?'Searching…':'Search'}</Button></form>
      {error&&<Alert className="error">{error}</Alert>}
      <div className="source-results">{results.map(result=><Card key={result.chunkId}>
        <p>{result.content}</p>
        <footer><strong>{result.citation.sourceName}</strong><span>{result.citation.title}{result.citation.location?' · '+result.citation.location:''}</span><code>{result.citation.sha256.slice(0,16)}</code></footer>
      </Card>)}</div>
    </Card>
  </div>
}


export function SourceList({sources,empty}:{sources:ResearchSource[];empty?:string}){
  if(!sources.length)return <div className="conversation-empty"><h2>No research sources yet.</h2><p>{empty??'Sources emitted by the session will appear here.'}</p></div>
  return <div className="source-view">{sources.map(source=><Card key={`${source.sessionId}-${source.id}`}>
    <div className="source-host">{source.host}</div>
    <div className="source-body">
      <strong>{source.title}</strong>
      <a href={safeHttpUrl(source.url)} target="_blank" rel="noreferrer">{source.url}</a>
      {source.preview?<pre className="source-preview">{source.preview}</pre>:source.excerpt&&<p>{source.excerpt}</p>}
      <span>Captured {new Date(source.capturedAt).toLocaleString()} · event {source.sequence}</span>
    </div>
  </Card>)}</div>
}

function safeHttpUrl(value:string):string|undefined{
  try{const url=new URL(value);return url.protocol==='http:'||url.protocol==='https:'?url.href:undefined}catch{return undefined}
}
