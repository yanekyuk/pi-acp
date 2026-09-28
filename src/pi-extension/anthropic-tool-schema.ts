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

type ProviderModel = { provider?: string }
type OnPayload = (payload: unknown, model: ProviderModel) => unknown
type StreamSimple = (model: ProviderModel, context: unknown, options?: { onPayload?: OnPayload }) => unknown

const normalizedRuntimes = new WeakSet<object>()

function isRuntime(value: unknown): value is { streamSimple: StreamSimple } {
  return isObject(value) && typeof value.streamSimple === 'function'
}

/**
 * Extensions that call pi's model runtime directly (e.g. rpiv-advisor's `advisor` tool) skip
 * `before_provider_request`, so wrap the runtime to normalize their Anthropic payloads too.
 * The runtime sits behind a private `modelRegistry.runtime` slot; other shapes are left alone.
 */
export function normalizeRuntimeAnthropicRequests(runtime: unknown): void {
  if (!isRuntime(runtime) || normalizedRuntimes.has(runtime)) return
  normalizedRuntimes.add(runtime)

  const streamSimple = runtime.streamSimple.bind(runtime)
  runtime.streamSimple = (model, context, options) => {
    if (model?.provider !== 'anthropic') return streamSimple(model, context, options)
    const onPayload = options?.onPayload
    return streamSimple(model, context, {
      ...options,
      onPayload: async (payload, payloadModel) =>
        normalizeAnthropicToolSchemas((await onPayload?.(payload, payloadModel)) ?? payload)
    })
  }
}

export default function anthropicToolSchemaExtension(pi: ExtensionAPI): void {
  pi.on('before_provider_request', (event, ctx) => {
    if (ctx.model?.provider !== 'anthropic') return
    return normalizeAnthropicToolSchemas(event.payload)
  })
  pi.on('session_start', (_event, ctx) => {
    normalizeRuntimeAnthropicRequests(ctx.modelRegistry.runtime)
  })
}
