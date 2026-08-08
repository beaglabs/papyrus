import { createOpenAI } from '@ai-sdk/openai'
import { generateText } from 'ai'

export interface ModelProviderConfig {
  provider: 'cloudflare-messages' | 'openai-compatible'
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

export async function generateModelText(
  config: ModelProviderConfig,
  input: {
    system: string
    messages: ModelMessage[]
    temperature?: number
    maxOutputTokens?: number
  },
): Promise<string> {
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
