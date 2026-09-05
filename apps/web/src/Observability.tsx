import { useCallback, useEffect, useMemo, useState } from 'react'
import { OBSERVABILITY_APP_ROLES, type EntraAppRole } from '@papyrus/contracts'
import {
  observabilityLogs,
  observabilityTrace,
  observabilityTraces,
  type ObservabilityLogLevel,
  type ObservabilityLogList,
  type ObservabilityLogRecord,
  type ObservabilitySpan,
  type ObservabilityTraceDetail,
  type ObservabilityTraceList,
  type ObservabilityTraceStatus,
} from './api.js'
import { Alert } from './components/ui/index.js'

type ObservabilityTab = 'traces' | 'logs'

const TRACE_STATUSES: Array<{ value: '' | ObservabilityTraceStatus; label: string }> = [
  { value: '', label: 'All statuses' },
  { value: 'success', label: 'Success' },
  { value: 'error', label: 'Error' },
  { value: 'running', label: 'Running' },
]

const LOG_LEVELS: Array<{ value: '' | ObservabilityLogLevel; label: string }> = [
  { value: '', label: 'All levels' },
  { value: 'debug', label: 'Debug' },
  { value: 'info', label: 'Info' },
  { value: 'warn', label: 'Warn' },
  { value: 'error', label: 'Error' },
  { value: 'fatal', label: 'Fatal' },
]

export function ObservabilityPanel({ roles }: { roles: EntraAppRole[] }) {
  const allowed = roles.some((role) => OBSERVABILITY_APP_ROLES.includes(role as (typeof OBSERVABILITY_APP_ROLES)[number]))
  const [tab, setTab] = useState<ObservabilityTab>('traces')
  const [traceStatus, setTraceStatus] = useState<'' | ObservabilityTraceStatus>('')
  const [logLevel, setLogLevel] = useState<'' | ObservabilityLogLevel>('')
  const [tracePage, setTracePage] = useState(0)
  const [logPage, setLogPage] = useState(0)
  const [traceList, setTraceList] = useState<ObservabilityTraceList>()
  const [logList, setLogList] = useState<ObservabilityLogList>()
  const [selectedTraceId, setSelectedTraceId] = useState<string>()
  const [traceDetail, setTraceDetail] = useState<ObservabilityTraceDetail>()
  const [selectedLog, setSelectedLog] = useState<ObservabilityLogRecord>()
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [refreshKey, setRefreshKey] = useState(0)

  const refresh = useCallback(() => setRefreshKey((value) => value + 1), [])

  useEffect(() => {
    if (!allowed) return
    let cancelled = false
    setLoading(true)
    setError(undefined)
    const request = tab === 'traces'
      ? observabilityTraces({ page: tracePage, perPage: 50, ...(traceStatus ? { status: traceStatus } : {}) })
      : observabilityLogs({ page: logPage, perPage: 50, ...(logLevel ? { level: logLevel } : {}) })
    void request.then((result) => {
      if (cancelled) return
      if (tab === 'traces') setTraceList(result as ObservabilityTraceList)
      else setLogList(result as ObservabilityLogList)
    }).catch((cause: unknown) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : 'Unable to load observability data')
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [allowed, tab, tracePage, traceStatus, logPage, logLevel, refreshKey])

  useEffect(() => {
    if (!allowed || !selectedTraceId) {
      setTraceDetail(undefined)
      return
    }
    let cancelled = false
    setDetailLoading(true)
    void observabilityTrace(selectedTraceId).then((result) => {
      if (!cancelled) setTraceDetail(result)
    }).catch((cause: unknown) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : 'Unable to load trace')
    }).finally(() => {
      if (!cancelled) setDetailLoading(false)
    })
    return () => { cancelled = true }
  }, [allowed, selectedTraceId, refreshKey])

  const filteredTraces = useMemo(() => {
    const query = search.trim().toLowerCase()
    const traces = traceList?.traces ?? []
    if (!query) return traces
    return traces.filter((trace) => [
      trace.traceId,
      trace.name,
      trace.spanType,
      trace.entityName,
      trace.entityType,
    ].some((value) => typeof value === 'string' && value.toLowerCase().includes(query)))
  }, [search, traceList])

  const filteredLogs = useMemo(() => {
    const query = search.trim().toLowerCase()
    const logs = logList?.logs ?? []
    if (!query) return logs
    return logs.filter((log) => [
      log.message,
      log.traceId,
      log.spanId,
      log.entityName,
      log.entityType,
    ].some((value) => typeof value === 'string' && value.toLowerCase().includes(query)))
  }, [search, logList])

  if (!allowed) return null

  const storage = traceList?.storage ?? logList?.storage
  const pagination = tab === 'traces' ? traceList?.pagination : logList?.pagination

  return <section className="governance-observability" aria-labelledby="observability-title">
    <div className="obs-head">
      <div>
        <p className="eyebrow">AUDIT + EXECUTION EVIDENCE</p>
        <h2 id="observability-title">Observability</h2>
        <p>Inspect persisted Mastra execution traces and trace-correlated logs without leaving the customer-hosted Papyrus boundary.</p>
      </div>
      <div className="obs-storage" title="Observability storage backend">
        <span className="dot good" />
        <span><strong>LibSQL</strong><small>{storage?.database ?? 'mastra.db'} · local</small></span>
      </div>
    </div>

    <div className="obs-controls">
      <div className="obs-tabs" role="tablist" aria-label="Observability data">
        <button type="button" role="tab" aria-selected={tab === 'traces'} className={tab === 'traces' ? 'active' : ''} onClick={() => { setTab('traces'); setSelectedLog(undefined); setSearch('') }}>Traces</button>
        <button type="button" role="tab" aria-selected={tab === 'logs'} className={tab === 'logs' ? 'active' : ''} onClick={() => { setTab('logs'); setSearch('') }}>Logs</button>
      </div>
      <label className="obs-search">
        <span className="sr-only">Filter current page</span>
        <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={tab === 'traces' ? 'Filter trace, entity, type…' : 'Filter message, trace, entity…'} />
      </label>
      {tab === 'traces'
        ? <label className="obs-filter"><span>Status</span><select value={traceStatus} onChange={(event) => { setTraceStatus(event.target.value as '' | ObservabilityTraceStatus); setTracePage(0) }}>{TRACE_STATUSES.map((item) => <option key={item.value || 'all'} value={item.value}>{item.label}</option>)}</select></label>
        : <label className="obs-filter"><span>Level</span><select value={logLevel} onChange={(event) => { setLogLevel(event.target.value as '' | ObservabilityLogLevel); setLogPage(0) }}>{LOG_LEVELS.map((item) => <option key={item.value || 'all'} value={item.value}>{item.label}</option>)}</select></label>}
      <button type="button" className="obs-refresh" onClick={refresh} disabled={loading}>↻ Refresh</button>
    </div>

    {error && <Alert className="error obs-alert">{error}</Alert>}

    <div className="obs-workspace">
      <div className="obs-list">
        <div className="obs-list-head">
          <span>{loading ? 'Loading…' : `${pagination?.total ?? 0} ${tab}`}</span>
          <span>Newest first · 50/page</span>
        </div>
        {tab === 'traces'
          ? <TraceRows traces={filteredTraces} selectedTraceId={selectedTraceId} loading={loading} onSelect={(traceId) => { setSelectedTraceId(traceId); setSelectedLog(undefined) }} />
          : <LogRows logs={filteredLogs} selectedLog={selectedLog} loading={loading} onSelect={(log) => setSelectedLog(log)} />}
        <Pagination
          page={tab === 'traces' ? tracePage : logPage}
          hasMore={Boolean(pagination?.hasMore)}
          onPrevious={() => tab === 'traces' ? setTracePage((page) => Math.max(0, page - 1)) : setLogPage((page) => Math.max(0, page - 1))}
          onNext={() => tab === 'traces' ? setTracePage((page) => page + 1) : setLogPage((page) => page + 1)}
        />
      </div>

      <aside className="obs-detail" aria-live="polite">
        {tab === 'traces'
          ? <TraceDetail detail={traceDetail} loading={detailLoading} />
          : <LogDetail log={selectedLog} onOpenTrace={(traceId) => { setSelectedTraceId(traceId); setTab('traces'); setSearch('') }} />}
      </aside>
    </div>
  </section>
}

function TraceRows({ traces, selectedTraceId, loading, onSelect }: {
  traces: ObservabilitySpan[]
  selectedTraceId?: string
  loading: boolean
  onSelect: (traceId: string) => void
}) {
  if (loading && !traces.length) return <div className="obs-empty">Reading traces from LibSQL…</div>
  if (!traces.length) return <div className="obs-empty">No traces match this view.</div>
  return <div className="obs-rows">{traces.map((trace) => <button
    type="button"
    key={trace.traceId}
    className={`obs-row ${selectedTraceId === trace.traceId ? 'selected' : ''}`}
    onClick={() => onSelect(trace.traceId)}
  >
    <span className={`obs-status ${trace.status ?? statusForSpan(trace)}`}>{trace.status ?? statusForSpan(trace)}</span>
    <span className="obs-row-main"><strong>{trace.entityName ?? trace.name}</strong><small>{trace.spanType} · {shortId(trace.traceId)}</small></span>
    <span className="obs-row-time"><strong>{formatDuration(trace.startedAt, trace.endedAt)}</strong><small>{formatTime(trace.startedAt)}</small></span>
  </button>)}</div>
}

function LogRows({ logs, selectedLog, loading, onSelect }: {
  logs: ObservabilityLogRecord[]
  selectedLog?: ObservabilityLogRecord
  loading: boolean
  onSelect: (log: ObservabilityLogRecord) => void
}) {
  if (loading && !logs.length) return <div className="obs-empty">Reading logs from LibSQL…</div>
  if (!logs.length) return <div className="obs-empty">No log records match this view.</div>
  return <div className="obs-rows">{logs.map((log, index) => {
    const id = log.logId ?? `${log.timestamp}:${index}`
    const selected = selectedLog && (selectedLog.logId ? selectedLog.logId === log.logId : selectedLog === log)
    return <button type="button" key={id} className={`obs-row log ${selected ? 'selected' : ''}`} onClick={() => onSelect(log)}>
      <span className={`obs-level ${log.level}`}>{log.level}</span>
      <span className="obs-row-main"><strong>{log.message}</strong><small>{log.traceId ? `trace ${shortId(log.traceId)}` : 'uncorrelated'}{log.entityName ? ` · ${log.entityName}` : ''}</small></span>
      <span className="obs-row-time"><small>{formatTime(log.timestamp)}</small></span>
    </button>
  })}</div>
}

function TraceDetail({ detail, loading }: { detail?: ObservabilityTraceDetail; loading: boolean }) {
  if (loading) return <div className="obs-detail-empty"><span>◇</span><strong>Loading trace</strong><small>Resolving the complete span tree from LibSQL.</small></div>
  if (!detail) return <div className="obs-detail-empty"><span>◇</span><strong>Select a trace</strong><small>Inspect model calls, tools, workflow steps, timing, inputs, outputs, and errors.</small></div>
  const spans = [...detail.spans].sort((left, right) => new Date(left.startedAt).getTime() - new Date(right.startedAt).getTime())
  const byId = new Map(spans.map((span) => [span.spanId, span]))
  return <div className="obs-trace-detail">
    <div className="obs-detail-head"><span><p className="eyebrow">TRACE</p><strong>{shortId(detail.traceId, 20)}</strong></span><small>{spans.length} spans</small></div>
    <div className="obs-span-tree">{spans.map((span) => {
      const depth = spanDepth(span, byId)
      const status = statusForSpan(span)
      return <details className={`obs-span ${status}`} key={span.spanId} style={{ '--span-depth': Math.min(depth, 8) } as React.CSSProperties}>
        <summary>
          <span className="obs-span-line" />
          <span className="obs-span-copy"><strong>{span.name}</strong><small>{span.spanType} · {formatDuration(span.startedAt, span.endedAt)}</small></span>
          <span className={`obs-status ${status}`}>{status}</span>
        </summary>
        <div className="obs-span-body">
          <KeyValue label="Span ID" value={span.spanId} />
          {span.entityName && <KeyValue label="Entity" value={String(span.entityName)} />}
          {span.error != null && <JsonValue label="Error" value={span.error} />}
          {span.input != null && <JsonValue label="Input" value={span.input} />}
          {span.output != null && <JsonValue label="Output" value={span.output} />}
          {span.attributes != null && <JsonValue label="Attributes" value={span.attributes} />}
          {span.metadata != null && <JsonValue label="Metadata" value={span.metadata} />}
        </div>
      </details>
    })}</div>
  </div>
}

function LogDetail({ log, onOpenTrace }: { log?: ObservabilityLogRecord; onOpenTrace: (traceId: string) => void }) {
  if (!log) return <div className="obs-detail-empty"><span>≡</span><strong>Select a log record</strong><small>Structured metadata and trace correlation appear here.</small></div>
  return <div className="obs-log-detail">
    <div className="obs-detail-head"><span><p className="eyebrow">LOG RECORD</p><strong className={`obs-level ${log.level}`}>{log.level}</strong></span><small>{formatTime(log.timestamp)}</small></div>
    <h3>{log.message}</h3>
    {log.traceId && <div className="obs-correlation"><span><small>TRACE</small><code>{log.traceId}</code></span><button type="button" onClick={() => onOpenTrace(log.traceId as string)}>Open trace →</button></div>}
    {log.spanId && <KeyValue label="Span ID" value={log.spanId} />}
    {log.entityName && <KeyValue label="Entity" value={String(log.entityName)} />}
    {log.data != null && <JsonValue label="Data" value={log.data} />}
    {log.metadata != null && <JsonValue label="Metadata" value={log.metadata} />}
  </div>
}

function Pagination({ page, hasMore, onPrevious, onNext }: { page: number; hasMore: boolean; onPrevious: () => void; onNext: () => void }) {
  return <div className="obs-pagination"><button type="button" onClick={onPrevious} disabled={page === 0}>← Previous</button><span>Page {page + 1}</span><button type="button" onClick={onNext} disabled={!hasMore}>Next →</button></div>
}

function KeyValue({ label, value }: { label: string; value: string }) {
  return <div className="obs-kv"><span>{label}</span><code>{value}</code></div>
}

function JsonValue({ label, value }: { label: string; value: unknown }) {
  return <details className="obs-json"><summary>{label}</summary><pre>{formatJson(value)}</pre></details>
}

function formatJson(value: unknown): string {
  try { return JSON.stringify(value, null, 2) ?? String(value) }
  catch { return String(value) }
}

function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function formatDuration(start: string, end?: string | null): string {
  if (!end) return 'running'
  const duration = new Date(end).getTime() - new Date(start).getTime()
  if (!Number.isFinite(duration) || duration < 0) return '—'
  if (duration < 1000) return `${duration} ms`
  if (duration < 60_000) return `${(duration / 1000).toFixed(duration < 10_000 ? 1 : 0)} s`
  return `${(duration / 60_000).toFixed(1)} min`
}

function shortId(value: string, length = 12): string {
  return value.length > length ? `${value.slice(0, length)}…` : value
}

function statusForSpan(span: ObservabilitySpan): ObservabilityTraceStatus {
  if (span.error != null) return 'error'
  return span.endedAt ? 'success' : 'running'
}

function spanDepth(span: ObservabilitySpan, byId: Map<string, ObservabilitySpan>): number {
  let depth = 0
  let parent = span.parentSpanId
  const visited = new Set<string>([span.spanId])
  while (parent && byId.has(parent) && !visited.has(parent) && depth < 20) {
    visited.add(parent)
    depth += 1
    parent = byId.get(parent)?.parentSpanId
  }
  return depth
}
