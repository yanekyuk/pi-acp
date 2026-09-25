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

export function normalizeAnthropicToolSchemas(payload: unknown): unknown {
  if (!isObject(payload) || !Array.isArray(payload.tools)) return payload

  return {
    ...payload,
    tools: payload.tools.map(tool => {
      if (!isObject(tool) || !isObject(tool.input_schema)) return tool
      return { ...tool, input_schema: omitIntegerBounds(tool.input_schema) }
    })
  }
}

export default function anthropicToolSchemaExtension(pi: ExtensionAPI): void {
  pi.on('before_provider_request', (event, ctx) => {
    if (ctx.model?.provider !== 'anthropic') return
    return normalizeAnthropicToolSchemas(event.payload)
  })
}
