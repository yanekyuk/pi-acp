import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function omitIntegerBounds(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(omitIntegerBounds)
  if (!isObject(schema)) return schema

  return Object.fromEntries(
    Object.entries(schema)
      .filter(([key]) => schema.type !== 'integer' || (key !== 'minimum' && key !== 'maximum'))
      .map(([key, value]) => [key, omitIntegerBounds(value)])
  )
}

export function normalizeAnthropicOauthToolSchemas(payload: unknown): unknown {
  if (!isObject(payload) || !Array.isArray(payload.tools)) return payload

  return {
    ...payload,
    tools: payload.tools.map(tool => {
      if (!isObject(tool) || !isObject(tool.input_schema)) return tool
      return { ...tool, input_schema: omitIntegerBounds(tool.input_schema) }
    })
  }
}

export default function anthropicOauthExtension(pi: ExtensionAPI): void {
  pi.on('before_provider_request', (event, ctx) => {
    const model = ctx.model
    if (!model || model.provider !== 'anthropic' || !ctx.modelRegistry.isUsingOAuth(model)) return
    return normalizeAnthropicOauthToolSchemas(event.payload)
  })
}
