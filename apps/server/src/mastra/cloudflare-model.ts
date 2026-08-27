import type { LanguageModelV4, LanguageModelV4Prompt } from '@ai-sdk/provider'

function normalizeSystemMessages(prompt: LanguageModelV4Prompt): LanguageModelV4Prompt {
  const systemMessages = prompt.filter((message) => message.role === 'system')
  const first = systemMessages[0]
  if (!first || (systemMessages.length === 1 && prompt[0] === first)) return prompt

  // Qwen's chat template permits a system message only at index zero. Merely
  // moving multiple system messages to the front still triggers its 400 error.
  // Preserve instruction order and all non-system messages, without mutating
  // Mastra's memory/history (including on subsequent tool-call steps).
  return [
    { ...first, content: systemMessages.map((message) => message.content).join('\n\n') },
    ...prompt.filter((message) => message.role !== 'system'),
  ]
}

export function wrapModelForCloudflare(model: LanguageModelV4): LanguageModelV4 {
  return {
    ...model,
    specificationVersion: model.specificationVersion,
    provider: model.provider,
    modelId: model.modelId,
    supportedUrls: model.supportedUrls,
    async doGenerate(options) {
      return model.doGenerate({ ...options, prompt: normalizeSystemMessages(options.prompt) })
    },
    async doStream(options) {
      return model.doStream({ ...options, prompt: normalizeSystemMessages(options.prompt) })
    },
  }
}
