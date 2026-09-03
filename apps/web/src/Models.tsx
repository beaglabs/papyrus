import { useState, type FormEvent } from 'react'
import type { ModelProfile } from '@papyrus/contracts'
import { createModelProfile, deleteModelProfile, disableModelProfile, setDefaultModelProfile, testModelProfile } from './api.js'
import { Alert, Badge, Button, Card } from './components/ui/index.js'

const directSetupRequest = {
  fields: [
    { name: 'model', label: 'Model ID', kind: 'text', required: true, placeholder: 'qwen3-32b' },
    { name: 'baseUrl', label: 'Base URL', kind: 'url', required: true, placeholder: 'https://inference.example.gov/v1', help: 'HTTPS is required outside loopback development.' },
    { name: 'authScheme', label: 'Authentication', kind: 'select', required: true, options: [{ label: 'No authentication', value: 'none' }, { label: 'API key from daemon environment', value: 'api_key' }] },
    { name: 'credentialRef', label: 'API key environment variable', kind: 'credential_reference', required: false, placeholder: 'OPENAI_API_KEY', help: 'The daemon reads this variable at request time; the secret never enters chat or Papyrus storage.' },
  ],
  note: 'The daemon validates and tests the endpoint. The first gateway that passes becomes active automatically.',
}

export function ModelsView({ profiles, onAskAgent, onChanged, canManage }: {
  profiles: ModelProfile[]
  onAskAgent: (prompt: string) => void
  onChanged: () => Promise<void>
  canManage: boolean
}) {
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()

  const action = async (profile: ModelProfile, operation: 'test' | 'default' | 'disable' | 'delete') => {
    if (!canManage) return
    if (operation === 'delete' && !window.confirm(`Delete ${profile.name}? The daemon removes its metadata; customer-held credentials are not touched.`)) return
    setBusy(`${operation}:${profile.id}`); setError(undefined)
    try {
      if (operation === 'test') await testModelProfile(profile.id)
      if (operation === 'default') await setDefaultModelProfile(profile.id)
      if (operation === 'disable') await disableModelProfile(profile.id)
      if (operation === 'delete') await deleteModelProfile(profile.id)
      await onChanged()
    } catch (cause) { setError(cause instanceof Error ? cause.message : `Unable to ${operation} model profile`) }
    finally { setBusy(undefined) }
  }

  return <div className="models-view">
    <section className="surface-intro"><div><p className="eyebrow">CUSTOMER MODEL GATEWAYS</p><h2>Models</h2><p>Choose where Papyrus inference runs. The daemon stores only endpoint metadata and reads any API key from its own environment.</p></div>{profiles.length > 0 && <Button className="primary" onClick={() => onAskAgent('Configure another Papyrus model gateway. Ask me for the model, endpoint, and whether the daemon should use an API key environment variable.')}>Configure with agent →</Button>}</section>
    {error && <Alert className="error">{error}</Alert>}
    {canManage && <section className="portal-section"><div className="section-heading"><div><p className="eyebrow">{profiles.length === 0 ? 'FIRST-RUN SETUP' : 'ADD GATEWAY'}</p><h2>{profiles.length === 0 ? 'Connect your first model gateway' : 'Add a model gateway'}</h2></div>{profiles.length === 0 && <Badge>NO CHAT REQUIRED</Badge>}</div><ModelGatewayCard request={directSetupRequest} onChanged={onChanged} /></section>}
    <section className="portal-section"><div className="section-heading"><div><p className="eyebrow">ACTIVE PROFILES</p><h2>Configured gateways</h2></div><Badge>{profiles.length}</Badge></div>
      {profiles.length === 0 ? <Card className="empty-integration"><span>◎</span><div><h3>No model gateway configured</h3><p>Connect an approved OpenAI-compatible endpoint above. Chat unlocks after the daemon tests it successfully.</p></div></Card> : <div className="model-profile-list">{profiles.map((profile) => <ModelProfileCard key={profile.id} profile={profile} busy={busy} canManage={canManage} onAction={action} />)}</div>}
    </section>
  </div>
}

function ModelProfileCard({ profile, busy, canManage, onAction }: { profile: ModelProfile; busy: string | undefined; canManage: boolean; onAction: (profile: ModelProfile, operation: 'test' | 'default' | 'disable' | 'delete') => Promise<void> }) {
  const stateClass = profile.state === 'active' ? 'status-good' : profile.state === 'error' ? 'status-critical' : 'status-neutral'
  return <Card className={`model-profile-card ${profile.isDefault ? 'default' : ''}`}><div className="model-profile-head"><div><div className="model-profile-title"><span className="model-profile-icon">◎</span><div><h3>{profile.name}</h3><p>{profile.provider} / {profile.model}</p></div></div></div><div className="model-profile-badges">{profile.isDefault && <Badge className="status-info">DEFAULT</Badge>}<Badge className={stateClass}>{profile.state.toUpperCase()}</Badge></div></div><dl className="model-profile-details"><div><dt>Endpoint</dt><dd><code>{profile.baseUrl}</code></dd></div><div><dt>Authentication</dt><dd>{profile.authScheme === 'none' ? 'No authentication' : `API key · ${profile.credentialRef?.replace(/^env:\/\//, '') ?? 'daemon environment'}`}</dd></div><div><dt>Capabilities</dt><dd>{profile.capabilities.join(' · ')}</dd></div></dl>{profile.lastTestError && <Alert className="error">{profile.lastTestError}</Alert>}{profile.lastTestedAt && <small className="model-profile-tested">Last tested {new Date(profile.lastTestedAt).toLocaleString()}</small>}<div className="model-profile-actions"><Button variant="ghost" size="sm" disabled={!canManage || Boolean(busy)} onClick={() => void onAction(profile, 'test')}>{busy === `test:${profile.id}` ? 'Testing…' : 'Test gateway'}</Button>{!profile.isDefault && <Button variant="ghost" size="sm" disabled={!canManage || Boolean(busy) || profile.state !== 'active'} onClick={() => void onAction(profile, 'default')}>Make default</Button>}{profile.state !== 'disabled' && <Button variant="ghost" size="sm" disabled={!canManage || Boolean(busy)} onClick={() => void onAction(profile, 'disable')}>Disable</Button>}<Button variant="ghost" size="sm" className="danger-item" disabled={!canManage || Boolean(busy)} onClick={() => void onAction(profile, 'delete')}>Delete</Button></div></Card>
}

export function ModelGatewayCard({ request, onChanged }: { request: { fields: Array<{ name: string; label: string; kind: string; required: boolean; placeholder?: string; help?: string; options?: Array<{ label: string; value: string }> }>; note: string }; onChanged: () => Promise<void> }) {
  const [state, setState] = useState<'ready' | 'saving' | 'connected'>('ready')
  const [error, setError] = useState<string>()
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setState('saving'); setError(undefined)
    const form = new FormData(event.currentTarget)
    const model = String(form.get('model') ?? '').trim()
    const authScheme = String(form.get('authScheme') ?? 'none')
    const baseUrl = String(form.get('baseUrl') ?? '').trim()
    const credential = String(form.get('credentialRef') ?? '').trim()
    const input: Record<string, unknown> = {
      name: `${model} gateway`, gatewayKind: 'openai-compatible', provider: 'openai-compatible',
      model, baseUrl, authScheme, scope: 'daemon',
      ...(authScheme === 'api_key' && credential ? { credentialRef: credential.startsWith('env://') ? credential : `env://${credential}` } : {}),
    }
    try {
      const profile = await createModelProfile(input)
      const tested = await testModelProfile(profile.id)
      if (tested.state !== 'active' || !tested.lastTestedAt) throw new Error(tested.lastTestError ?? 'The daemon could not verify this model gateway')
      setState('connected'); await onChanged()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to configure model gateway'); setState('ready') }
  }
  if (state === 'connected') return <Card className="plugin-tool-card connected"><span className="tool-icon">✓</span><div><strong>Model gateway configured</strong><p>The daemon tested the endpoint and recorded only non-secret profile metadata.</p></div></Card>
  return <Card className="plugin-tool-card model-gateway-card"><div className="plugin-tool-head"><div><p className="eyebrow">SECURE MODEL SETUP</p><h3>Configure model gateway</h3></div><Badge>DAEMON-OWNED</Badge></div><p>The daemon owns the connection. If authentication is required, enter only the environment variable name; never paste the API key.</p><form onSubmit={(event) => void submit(event)}><div className="agent-form-grid">{request.fields.map((field) => <label className="nb-label" key={field.name}>{field.label}{field.kind === 'select' ? <select className="nb-select" name={field.name} required={field.required}>{field.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select> : <input className="nb-input" name={field.name} type={field.kind === 'credential_reference' ? 'text' : field.kind} required={field.required} placeholder={field.placeholder} autoComplete="off" />}{field.help && <small>{field.help}</small>}</label>)}</div>{error && <Alert className="error">{error}</Alert>}<div className="plugin-tool-foot"><small>{request.note}</small><Button className="primary" disabled={state === 'saving'}>{state === 'saving' ? 'Testing…' : 'Save and test gateway'}</Button></div></form></Card>
}
