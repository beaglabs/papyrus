import { createOpenAI } from '@ai-sdk/openai'
import { generateText } from 'ai'

export interface ModelProviderConfig {
  provider: 'cloudflare-messages' | 'openai-compatible' | 'demo'
  baseURL: string
  apiKey: string
  model: string
}

export interface ModelMessage {
  role: 'user' | 'assistant'
  content: string
}

export function resolveModelProvider(
  env: NodeJS.ProcessEnv = process.env,
): ModelProviderConfig | null {
  const cloudflareAccountId = env.CLOUDFLARE_ACCOUNT_ID
  const cloudflareToken = env.CLOUDFLARE_API_TOKEN
  const requestedProvider = env.PAPYRUS_LLM_PROVIDER

  const useCloudflare =
    requestedProvider === 'cloudflare' ||
    (!requestedProvider && Boolean(cloudflareAccountId && cloudflareToken))

  if (useCloudflare) {
    if (!cloudflareAccountId || !cloudflareToken) return null
    return {
      provider: 'cloudflare-messages',
      baseURL:
        env.PAPYRUS_LLM_BASE_URL ??
        `https://api.cloudflare.com/client/v4/accounts/${cloudflareAccountId}/ai/v1`,
      apiKey: cloudflareToken,
      model: env.PAPYRUS_LLM_MODEL ?? 'thinkingmachines/inkling-256k',
    }
  }

  if (requestedProvider === 'demo') {
    return { provider: 'demo', baseURL: '', apiKey: '', model: 'demo-model' }
  }

  const apiKey = env.PAPYRUS_LLM_API_KEY ?? env.OPENROUTER_API_KEY ?? env.OPENAI_API_KEY
  if (!apiKey) return null
  const usingOpenRouter = Boolean(env.OPENROUTER_API_KEY) && !env.PAPYRUS_LLM_BASE_URL
  return {
    provider: 'openai-compatible',
    baseURL:
      env.PAPYRUS_LLM_BASE_URL ??
      (usingOpenRouter ? 'https://openrouter.ai/api/v1' : 'https://api.openai.com/v1'),
    apiKey,
    model: env.PAPYRUS_LLM_MODEL ?? (usingOpenRouter ? 'inclusionai/ling-3.0-tiny:free' : 'gpt-4o'),
  }
}

const DEMO_RESPONSES: Record<string, string> = {
  pm: `<artifact type="specification" title="Product Requirements Document">
# Product Requirements Document — Drone Asset Tracking Platform

## Vision
A peer-to-peer platform for real-time drone asset tracking across distributed teams in disconnected environments.

## User Stories
- **As a** field operator, **I want to** see all active drones on a map, **so that** I can monitor asset locations in real-time.
- **As a** mission commander, **I want to** receive alerts when drones deviate from planned routes, **so that** I can respond to anomalies.
- **As a** logistics coordinator, **I want to** generate utilization reports, **so that** I can optimize fleet allocation.

## Success Metrics
- 99.9% uptime for tracking data ingestion
- <2s latency for position updates
- Support for 500+ concurrent drone streams

## Requirements
1. Real-time GPS telemetry ingestion via MQTT
2. Offline-first architecture with CRDT sync
3. Role-based access control (RBAC)
4. Geofencing with configurable alert rules
</artifact>`,
  designer: `<artifact type="ui-mockup" title="Tracking Dashboard Wireframe">
{"schema":"papyrus.uswds-wireframe/v1","title":"UAS Marketplace","viewport":"desktop","description":"Federal marketplace discovery and onboarding dashboard","sections":[{"kind":"banner","text":"An official website of the United States government"},{"kind":"header","agency":"U.S. Army","title":"UAS Marketplace","navigation":["Marketplace","My requests","Vendors","Help"]},{"kind":"hero","eyebrow":"Commercial solutions","heading":"Find mission-ready UAS capabilities","body":"Search verified commercial systems, components, and enabling technologies available for evaluation.","primaryAction":"Browse capabilities","secondaryAction":"Submit a requirement"},{"kind":"search","label":"Search the UAS Marketplace","placeholder":"Search platforms, payloads, components, or vendors","buttonLabel":"Search"},{"kind":"card-grid","heading":"Featured capabilities","cards":[{"title":"Group 2 reconnaissance platform","body":"Modular ISR platform with government-defined interface documentation.","meta":"Assessment ready","action":"View capability"},{"title":"Navigation module","body":"Assured positioning component designed for contested environments.","meta":"Technical data available","action":"View capability"},{"title":"Payload integration kit","body":"Open interface kit for rapid sensor integration and evaluation.","meta":"New","action":"View capability"}]},{"kind":"summary-box","heading":"Need help defining a requirement?","body":"Start with a mission need and the marketplace team will help structure evaluation criteria.","items":["Describe the operational need","Identify constraints","Compare eligible capabilities"]},{"kind":"footer","agency":"U.S. Army","links":["Accessibility","Privacy","FOIA","Contact"]}]}
</artifact>`,
  engineer: `<artifact type="application" title="System Architecture">
# System Architecture

## Components
- **Ingestion Service** (Node.js) — MQTT broker subscriber, telemetry normalization
- **Sync Engine** (Rust) — CRDT-based state replication across nodes
- **API Gateway** (Go) — REST + WebSocket, RBAC enforcement
- **Storage** — SQLite (edge) / PostgreSQL (cloud), time-series telemetry
- **Web Client** (React) — XYFlow canvas, real-time map, offline support

## Data Flow
1. Drone → MQTT broker → Ingestion Service
2. Ingestion → Sync Engine → CRDT broadcast
3. Clients ← WebSocket ← API Gateway ← Sync Engine
4. Offline: Local SQLite outbox → flush on reconnect

## Security
- mTLS for all service-to-service communication
- Ed25519-signed operation bundles for cross-domain transfer
- AES-256-GCM encryption at rest
- SHA-256 hash-chained audit log
</artifact>`,
  security: `<artifact type="specification" title="Threat Model — Drone Tracking Platform">
# Threat Model

## Assets
- Real-time drone location data (classified up to SECRET)
- Fleet configuration and mission plans
- User credentials and RBAC policies

## Threat Actors
1. **Nation-state APT** — Targeted exfiltration of tracking data
2. **Insider threat** — Unauthorized access to mission plans
3. **Script kiddie** — Opportunistic scanning/exploitation

## Mitigations
- **Data exfiltration**: Cross-domain transfer allowlisting, signed bundles
- **Unauthorized access**: CAC/PIV + WebAuthn MFA, least-privilege RBAC
- **Network attacks**: mTLS, WAF, rate limiting (30 req/min/IP)
- **Supply chain**: Dependency pinning, SBOM generation, artifact signing

## Compliance
- FedRAMP Moderate baseline
- NIST 800-53 rev 5 controls
- IL4/IL6 deployment support via profile gating
</artifact>`,
}

const DEFAULT_DEMO_RESPONSE = `<artifact type="specification" title="Generated Artifact">
# Generated Content

Here is the generated artifact based on your request.

## Summary
This content was generated by the demo provider for Papyrus.

The system successfully routed your request to the appropriate persona agent and produced this structured output.
</artifact>`

export function getDemoResponse(persona: string): string {
  return DEMO_RESPONSES[persona] ?? DEFAULT_DEMO_RESPONSE
}

export async function generateModelText(
  config: ModelProviderConfig,
  input: {
    system: string
    messages: ModelMessage[]
    temperature?: number
    maxOutputTokens?: number
  },
): Promise<string> {
  if (config.provider === 'demo') {
    // Extract persona from system prompt
    const systemLower = input.system.toLowerCase()
    let persona = 'pm'
    if (systemLower.includes('designer')) persona = 'designer'
    else if (systemLower.includes('engineer')) persona = 'engineer'
    else if (systemLower.includes('security')) persona = 'security'
    const response = getDemoResponse(persona)
    // Simulate streaming delay
    await new Promise((r) => setTimeout(r, 800 + Math.random() * 1200))
    return response
  }

  if (config.provider === 'cloudflare-messages') {
    const response = await fetch(`${config.baseURL.replace(/\/$/, '')}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.model,
        system: input.system,
        messages: input.messages,
        max_tokens: input.maxOutputTokens ?? 4096,
        temperature: input.temperature ?? 0.7,
      }),
    })
    const responseBody = (await response.json()) as {
      content?: Array<{ type?: string; text?: string }>
      errors?: Array<{ message?: string }>
      error?: { message?: string }
      result?: {
        content?: Array<{ type?: string; text?: string }>
      }
    }
    if (!response.ok) {
      throw new Error(
        responseBody.errors
          ?.map((error) => error.message)
          .filter(Boolean)
          .join('; ') ||
          responseBody.error?.message ||
          `Cloudflare Workers AI request failed (${response.status})`,
      )
    }
    const body = responseBody.result ?? responseBody
    const text = body.content
      ?.filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('\n')
      .trim()
    if (!text) throw new Error('Cloudflare Workers AI returned no text content')
    return text
  }

  const provider = createOpenAI({ baseURL: config.baseURL, apiKey: config.apiKey })
  const result = await generateText({
    model: provider(config.model),
    system: input.system,
    messages: input.messages,
    temperature: input.temperature ?? 0.7,
    maxOutputTokens: input.maxOutputTokens ?? 4096,
  })
  return result.text
}
