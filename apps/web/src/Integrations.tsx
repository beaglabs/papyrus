import { useMemo, useState, type CSSProperties, type FormEvent } from 'react'
import type { EntraAppRole, IntegrationCatalogEntry, IntegrationClass, IntegrationConfiguration, IntegrationEvent, PortalPrincipal } from '@papyrus/contracts'
import { createIntegration, integrationEvents, requestIntegrationSync, transitionIntegration } from './api.js'
import { Alert, Badge, Button, Card, Dialog, DialogContent, DialogFooter, DialogHeader, Input, Label, NativeSelect } from './components/ui/index.js'

const CLASS_LABELS: Record<IntegrationClass, string> = {
  human_interface: 'Human interface', evidence_source: 'Evidence source', terrain_source: 'Terrain source',
  action_executor: 'Action executor', agent_peer: 'Agent peer', infrastructure: 'Infrastructure',
}

function can(principal: PortalPrincipal, role: EntraAppRole): boolean {
  return principal.roles.includes('Papyrus.System.Owner') || principal.roles.includes(role)
}

export function IntegrationsView({ me, catalog, integrations, onChanged }: {
  me: PortalPrincipal
  catalog: IntegrationCatalogEntry[]
  integrations: IntegrationConfiguration[]
  onChanged: () => Promise<void>
}) {
  const [filter, setFilter] = useState<'all' | IntegrationClass>('all')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<IntegrationCatalogEntry>()
  const [setupFor, setSetupFor] = useState<IntegrationConfiguration>()
  const [eventsFor, setEventsFor] = useState<IntegrationConfiguration>()
  const [events, setEvents] = useState<IntegrationEvent[]>([])
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  const visibleCatalog = useMemo(() => catalog.filter((entry) => {
    const matchesClass = filter === 'all' || entry.integrationClass === filter
    const haystack = `${entry.name} ${entry.vendor} ${entry.description} ${entry.capabilities.join(' ')}`.toLowerCase()
    return matchesClass && haystack.includes(query.trim().toLowerCase())
  }), [catalog, filter, query])
  const configuredIds = new Set(integrations.map((item) => item.catalogId))
  const canManage = can(me, 'Papyrus.Integration.Manage')
  const canAudit = can(me, 'Papyrus.Audit.View')

  const transition = async (integration: IntegrationConfiguration, action: 'test' | 'submit' | 'activate' | 'disable') => {
    setBusy(`${integration.id}:${action}`); setError(undefined)
    try { await transitionIntegration(integration.id, action); await onChanged() }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Integration transition failed') }
    finally { setBusy(undefined) }
  }

  const openEvents = async (integration: IntegrationConfiguration) => {
    setEventsFor(integration); setEvents([]); setError(undefined)
    try { setEvents(await integrationEvents(integration.id)) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to load integration events') }
  }

  const syncNow = async (integration: IntegrationConfiguration) => {
    setBusy(`${integration.id}:sync`); setError(undefined)
    try { await requestIntegrationSync(integration.id); await onChanged() }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to queue synchronization') }
    finally { setBusy(undefined) }
  }

  return <div className="integrations-page">
    <section className="integration-summary">
      <div><span className="summary-number">{integrations.length}</span><span>configured</span></div>
      <div><span className="summary-number">{integrations.filter((item) => item.state === 'active').length}</span><span>active</span></div>
      <div><span className="summary-number">{integrations.filter((item) => item.state === 'awaiting_approval').length}</span><span>awaiting approval</span></div>
      <div><span className="summary-number">{integrations.filter((item) => item.health === 'degraded' || item.health === 'unreachable').length}</span><span>degraded</span></div>
    </section>

    {error && <Alert className="error integration-error">{error}<Button variant="ghost" onClick={() => setError(undefined)} aria-label="Dismiss">×</Button></Alert>}

    <section className="portal-section">
      <div className="section-heading"><div><p className="eyebrow">DEPLOYED CONNECTIONS</p><h2>Operational integrations</h2></div><Badge>{integrations.length} TOTAL</Badge></div>
      {integrations.length === 0
        ? <Card className="empty-integration"><span aria-hidden="true">↗</span><div><h3>No integrations configured</h3><p>Connect an operator interface or security evidence source from the catalog below.</p></div></Card>
        : <div className="configured-list">{integrations.map((integration) => {
          const entry = catalog.find((candidate) => candidate.id === integration.catalogId)
          const canActivate = integration.risk === 'high' || integration.risk === 'critical' || integration.authority === 'controlled_actions'
            ? can(me, 'Papyrus.Security.Manage') : canManage
          return <Card className="configured-row" key={integration.id}>
            <div className="connector-mark" style={{ '--connector-accent': entry?.accent ?? '#ece7d8' } as CSSProperties}>{entry?.initials ?? '??'}</div>
            <div className="configured-main"><div className="configured-title"><h3>{integration.name}</h3><Badge className={`state-${integration.state}`}>{integration.state.replaceAll('_', ' ')}</Badge></div><p>{CLASS_LABELS[integration.integrationClass]} · {entry?.observationProtocol ? 'Observation API' : entry?.syncMode ?? 'none'} · {integration.scope}</p>{integration.lastEvidenceAt && <small>Last evidence {new Date(integration.lastEvidenceAt).toLocaleString()}</small>}{integration.lastSyncAt && <small>Last sync {new Date(integration.lastSyncAt).toLocaleString()}</small>}</div>
            <div className="integration-health" title={integration.lastSyncError}><span className={`health-dot ${integration.health}`} />{integration.health}</div>
            <div className="configured-actions">
              {integration.state === 'draft' && canManage && <Button size="sm" disabled={Boolean(busy)} onClick={() => void transition(integration, 'test')}>Test configuration</Button>}
              {integration.state === 'tested' && canManage && <Button size="sm" disabled={Boolean(busy)} onClick={() => void transition(integration, 'submit')}>Submit</Button>}
              {integration.state === 'awaiting_approval' && canActivate && <Button className="primary" size="sm" disabled={Boolean(busy)} onClick={() => void transition(integration, 'activate')}>Activate</Button>}
              {integration.state === 'active' && entry?.observationProtocol && canManage && <Button className="primary" size="sm" onClick={() => setSetupFor(integration)}>Ingestion setup</Button>}
              {integration.state === 'active' && entry && ['pull', 'hybrid'].includes(entry.syncMode) && canManage && <Button size="sm" disabled={Boolean(busy)} onClick={() => void syncNow(integration)}>Sync now</Button>}
              {integration.state !== 'disabled' && canManage && <Button variant="ghost" size="sm" disabled={Boolean(busy)} onClick={() => void transition(integration, 'disable')}>Disable</Button>}
              {canAudit && <Button variant="ghost" size="sm" onClick={() => void openEvents(integration)}>Audit</Button>}
            </div>
          </Card>
        })}</div>}
    </section>

    <section className="portal-section catalog-section">
      <div className="section-heading"><div><p className="eyebrow">CONNECTOR CATALOG</p><h2>Add an integration</h2></div><div className="catalog-search"><Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search connectors" aria-label="Search connectors" /></div></div>
      <div className="filter-row">
        <Button size="sm" variant={filter === 'all' ? 'reverse' : 'ghost'} onClick={() => setFilter('all')}>All</Button>
        {Object.entries(CLASS_LABELS).map(([value, label]) => <Button key={value} size="sm" variant={filter === value ? 'reverse' : 'ghost'} onClick={() => setFilter(value as IntegrationClass)}>{label}</Button>)}
      </div>
      <div className="catalog-grid">{visibleCatalog.map((entry) => <Card className="catalog-card" key={entry.id} style={{ '--connector-accent': entry.accent } as CSSProperties}>
        <div className="catalog-card-head"><div className="connector-mark">{entry.initials}</div><Badge className={`risk-${entry.risk}`}>{entry.risk}</Badge></div>
        <p className="catalog-vendor">{entry.vendor}</p><h3>{entry.name}</h3><p>{entry.description}</p>
        <div className="capability-list">{entry.capabilities.slice(0, 3).map((capability) => <span key={capability}>{capability}</span>)}</div>
        <div className="catalog-card-foot"><span>{CLASS_LABELS[entry.integrationClass]}</span><Button disabled={!canManage} onClick={() => setSelected(entry)}>{configuredIds.has(entry.id) ? 'Add another' : 'Configure'} →</Button></div>
      </Card>)}</div>
    </section>

    <ConfigureIntegration entry={selected} open={Boolean(selected)} onClose={() => setSelected(undefined)} onCreated={async () => { setSelected(undefined); await onChanged() }} />
    <PushSourceSetup key={setupFor?.id ?? 'closed'} integration={setupFor} entry={catalog.find((candidate) => candidate.id === setupFor?.catalogId)} onClose={() => setSetupFor(undefined)} />
    <Dialog open={Boolean(eventsFor)} onOpenChange={(open) => { if (!open) setEventsFor(undefined) }}><DialogHeader><div><p className="eyebrow">APPEND-ONLY HISTORY</p><h2>{eventsFor?.name}</h2></div><Button variant="ghost" onClick={() => setEventsFor(undefined)}>×</Button></DialogHeader><DialogContent>
      <div className="event-list">{events.length ? events.map((event) => <div key={event.sequence}><span>{event.sequence}</span><div><strong>{event.action}</strong><small>{new Date(event.occurredAt).toLocaleString()} · {event.actorOid}</small></div></div>) : <p className="empty-copy">No audit events available.</p>}</div>
    </DialogContent></Dialog>
  </div>
}

function ConfigureIntegration({ entry, open, onClose, onCreated }: { entry: IntegrationCatalogEntry | undefined; open: boolean; onClose: () => void; onCreated: () => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  if (!entry) return null
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setBusy(true); setError(undefined)
    const form = new FormData(event.currentTarget)
    try {
      await createIntegration({
        catalogId: entry.id,
        name: String(form.get('name') ?? ''),
        scope: String(form.get('scope') ?? ''),
        ...(form.get('endpoint') ? { endpoint: String(form.get('endpoint')) } : {}),
        ...(form.get('credentialRef') ? { credentialRef: String(form.get('credentialRef')) } : {}),
        settings: entry.observationProtocol
          ? { ingestion: 'daemon_observation_api' }
          : { dataHandling: String(form.get('dataHandling') ?? 'metadata_only') },
      })
      await onCreated()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to configure integration') }
    finally { setBusy(false) }
  }
  return <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}><form onSubmit={submit}>
    <DialogHeader><div><p className="eyebrow">NEW {CLASS_LABELS[entry.integrationClass].toUpperCase()}</p><h2>Configure {entry.name}</h2></div><Button type="button" variant="ghost" onClick={onClose}>×</Button></DialogHeader>
    <DialogContent>{error && <Alert className="error">{error}</Alert>}<div className="connector-intro"><div className="connector-mark" style={{ '--connector-accent': entry.accent } as CSSProperties}>{entry.initials}</div><p>{entry.description}</p></div>
      <div className="form-grid"><Label>Display name<Input name="name" required defaultValue={entry.name} /></Label><Label>Operational scope<Input name="scope" required placeholder="IL4 enterprise enclave" /></Label>{entry.observationProtocol
        ? <Alert className="span-two source-boundary"><strong>Daemon ingestion</strong><span>This registers a source identity and its allowed schemas inside this Papyrus daemon. It does not provision another service or external API endpoint.</span></Alert>
        : <><Label className="span-two">Endpoint<Input name="endpoint" type="url" placeholder="https://approved.internal.example/api" /><small>HTTPS is required outside loopback development.</small></Label><Label className="span-two">Credential reference<Input name="credentialRef" placeholder="keyvault://papyrus/connectors/example" /><small>Paste a vault, certificate, or managed-identity reference—never a secret.</small></Label><Label>Data handling<NativeSelect name="dataHandling" defaultValue="metadata_only"><option value="metadata_only">Metadata only</option><option value="normalized_evidence">Normalized evidence</option><option value="customer_defined">Customer defined</option></NativeSelect></Label></>}</div>
      {entry.authority === 'controlled_actions' && <Alert className="authority-warning"><strong>Controlled-action connector</strong><span>Configuration does not grant execution authority. Activation requires the Papyrus.Security.Manage Entra role; individual actions require separate approval.</span></Alert>}
    </DialogContent><DialogFooter><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button className="primary" disabled={busy}>{busy ? 'Saving…' : 'Save draft'}</Button></DialogFooter>
  </form></Dialog>
}

export function buildCanonicalObservationExample(entry: IntegrationCatalogEntry, integration: IntegrationConfiguration, schemaId?: string) {
  const profile = entry.observationProtocol?.schemas.find((candidate) => candidate.id === schemaId)
  if (profile?.canonicalExample) return {
    sourceRecordId: `${entry.id}-canonical-demo-${crypto.randomUUID()}`,
    observedAt: new Date().toISOString(),
    evidenceType: profile.canonicalExample.evidenceType,
    subject: profile.canonicalExample.subject,
    payload: profile.example,
    terrain: profile.canonicalExample.terrain,
  }
  const evidenceType = entry.evidenceTypes[0] ?? 'Observation'
  return {
    sourceRecordId: `${entry.id}-canonical-demo-${crypto.randomUUID()}`,
    observedAt: new Date().toISOString(),
    evidenceType,
    subject: `resource:${entry.id}:demo`,
    payload: { sourceProfile: entry.id, originalRecord: 'preserved here' },
    terrain: {
      entities: [{ externalId: `resource:${entry.id}:demo`, kind: 'ObservedResource', label: `${integration.name} demo resource`, confidence: 1 }],
      relationships: [],
    },
  }
}

export function buildNativeObservationExample(entry: IntegrationCatalogEntry, schemaId: string) {
  const profile = entry.observationProtocol?.schemas.find((candidate) => candidate.id === schemaId)
  if (!profile) return undefined
  return {
    sourceRecordId: `${entry.id}-native-demo-${crypto.randomUUID()}`,
    observedAt: new Date().toISOString(),
    schema: profile.id,
    payload: profile.example,
  }
}

export function buildObservationCurlCommand(integration: IntegrationConfiguration, payload: unknown): string {
  return `export PAPYRUS_DAEMON_ORIGIN=https://papyrus-daemon.internal
export PAPYRUS_ENTRA_TOKEN='replace-with-entra-access-token'

curl --fail-with-body -X POST \\
  -H "Authorization: Bearer $PAPYRUS_ENTRA_TOKEN" \\
  -H "Content-Type: application/json" \\
  "$PAPYRUS_DAEMON_ORIGIN/api/integrations/${integration.id}/observations" \\
  --data-binary @- <<'JSON'
${JSON.stringify(payload, null, 2)}
JSON`
}

const SOURCE_SPOOL_PATHS: Record<string, string> = {
  zeek: '/opt/zeek/logs/current/conn.log',
  suricata: '/var/log/suricata/eve.json',
  sysmon: '/var/lib/papyrus-ingest/sysmon.ndjson',
  'dns-observation': '/var/lib/papyrus-ingest/dns.ndjson',
  'asset-inventory': '/var/lib/papyrus-ingest/assets.ndjson',
  'microsoft-entra': '/var/lib/papyrus-ingest/entra.ndjson',
  'defender-xdr': '/var/lib/papyrus-ingest/defender.ndjson',
  'microsoft-sentinel': '/var/lib/papyrus-ingest/sentinel.ndjson',
}

export function buildObservationTailCommand(integration: IntegrationConfiguration, schemaId: string): string {
  const spoolPath = SOURCE_SPOOL_PATHS[integration.catalogId] ?? `/var/lib/papyrus-ingest/${integration.catalogId}.ndjson`
  return `export PAPYRUS_DAEMON_ORIGIN=https://papyrus-daemon.internal
export PAPYRUS_ENTRA_TOKEN='replace-with-entra-access-token'
export SOURCE_NDJSON=${spoolPath}

# Each input line must be one JSON object matching ${schemaId}.
tail -Fn0 "$SOURCE_NDJSON" | while IFS= read -r record; do
  observed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  source_record_id=$(printf '%s' "$record" | sha256sum | cut -d' ' -f1)

  jq -cn \\
    --arg sourceRecordId "$source_record_id" \\
    --arg observedAt "$observed_at" \\
    --arg schema "${schemaId}" \\
    --argjson payload "$record" \\
    '{sourceRecordId:$sourceRecordId,observedAt:$observedAt,schema:$schema,payload:$payload}' \\
  | curl --fail-with-body --silent --show-error -X POST \\
      -H "Authorization: Bearer $PAPYRUS_ENTRA_TOKEN" \\
      -H "Content-Type: application/json" \\
      "$PAPYRUS_DAEMON_ORIGIN/api/integrations/${integration.id}/observations" \\
      --data-binary @-
done`
}

function PushSourceSetup({ integration, entry, onClose }: {
  integration: IntegrationConfiguration | undefined
  entry: IntegrationCatalogEntry | undefined
  onClose: () => void
}) {
  const schemas = entry?.observationProtocol?.schemas ?? []
  const [mode, setMode] = useState<'native' | 'canonical'>(schemas.length ? 'native' : 'canonical')
  const [commandMode, setCommandMode] = useState<'stream' | 'test'>(schemas.length ? 'stream' : 'test')
  const [selectedSchema, setSelectedSchema] = useState(schemas[0]?.id ?? '')
  const [copied, setCopied] = useState(false)
  const payload = useMemo(
    () => !integration || !entry?.observationProtocol ? undefined
      : mode === 'native' ? buildNativeObservationExample(entry, selectedSchema) : buildCanonicalObservationExample(entry, integration, selectedSchema),
    [entry, integration, mode, selectedSchema],
  )
  if (!integration || !entry?.observationProtocol) return null
  const command = commandMode === 'stream' && mode === 'native'
    ? buildObservationTailCommand(integration, selectedSchema)
    : buildObservationCurlCommand(integration, payload)
  const copy = async () => {
    await navigator.clipboard.writeText(command)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1_500)
  }
  return <Dialog open onOpenChange={(open) => { if (!open) onClose() }}><DialogHeader><div><p className="eyebrow">DAEMON INGESTION</p><h2>{integration.name}</h2></div><Button variant="ghost" onClick={onClose}>×</Button></DialogHeader><DialogContent>
    <div className="source-setup-meta"><Badge>ACTIVE</Badge><code>/api/integrations/{integration.id}/observations</code></div>
    <p className="source-setup-copy">This route is served by the current Papyrus daemon. The integration ID identifies the source; the selected schema controls deterministic normalization into Terrain.</p>
    <div className="segmented source-mode" role="group" aria-label="Observation payload mode">
      {schemas.length > 0 && <button className={mode === 'native' ? 'active' : ''} onClick={() => setMode('native')}>Source-native</button>}
      <button className={mode === 'canonical' ? 'active' : ''} onClick={() => { setMode('canonical'); setCommandMode('test') }}>Canonical Terrain</button>
    </div>
    {schemas.length > 0 && <Label>{mode === 'native' ? 'Versioned source schema' : 'Canonical projection example'}<NativeSelect value={selectedSchema} onChange={(event) => setSelectedSchema(event.target.value)}>{schemas.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label} · {candidate.id}</option>)}</NativeSelect><small>{schemas.find((candidate) => candidate.id === selectedSchema)?.description}</small></Label>}
    <div className="command-head"><div><strong>Connect this source</strong><small>Uses an Entra bearer token with Papyrus.Integration.Manage.</small></div><Button size="sm" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy command'}</Button></div>
    <div className="terminal-shell">
      <div className="terminal-bar"><span className="terminal-lights" aria-hidden="true"><i /><i /><i /></span><div className="terminal-tabs" role="group" aria-label="Ingestion command">
        {schemas.length > 0 && <button className={commandMode === 'stream' ? 'active' : ''} onClick={() => setCommandMode('stream')}>Stream NDJSON</button>}
        <button className={commandMode === 'test' ? 'active' : ''} onClick={() => setCommandMode('test')}>Send one record</button>
      </div></div>
      <pre className="source-command"><code>{command}</code></pre>
    </div>
    {commandMode === 'stream' && mode === 'native'
      ? <Alert className="source-boundary"><strong>Customer-owned bridge</strong><span>Point SOURCE_NDJSON at a JSON-lines export matching the selected schema. The command tails it continuously and sends each record to this daemon; Papyrus does not need credentials for the source system.</span></Alert>
      : <Alert className="source-boundary"><strong>One-record validation</strong><span>Run this against the daemon to validate authentication, schema acceptance, normalization, and Terrain projection before connecting a live stream.</span></Alert>}
  </DialogContent><DialogFooter><Button onClick={onClose}>Done</Button></DialogFooter></Dialog>
}
