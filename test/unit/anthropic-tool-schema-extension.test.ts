import assert from 'node:assert/strict'
import test from 'node:test'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import anthropicToolSchemaExtension, {
  normalizeAnthropicToolSchemas,
  normalizeRuntimeAnthropicRequests
} from '../../src/pi-extension/anthropic-tool-schema.js'

const payload = {
  model: 'claude-opus-5-5',
  tools: [
    {
      name: 'agent_browser_code',
      input_schema: {
        type: 'object',
        properties: {
          timeoutMs: { type: 'integer', minimum: 1, maximum: 300000, description: 'Timeout in milliseconds' },
          options: {
            anyOf: [
              { type: 'object', properties: { attempts: { type: 'integer', minimum: 0 } } },
              { type: 'number', minimum: 0, maximum: 1 }
            ]
          }
        }
      }
    },
    { name: 'web_fetch', input_schema: { type: 'object', properties: { url: { type: 'string' } } } }
  ]
}

test('removes integer bounds from outgoing tool schemas without changing Pi tool definitions', () => {
  const normalized = normalizeAnthropicToolSchemas(payload) as typeof payload

  assert.deepEqual(normalized.tools[0].input_schema, {
    type: 'object',
    properties: {
      timeoutMs: { type: 'integer', description: 'Timeout in milliseconds' },
      options: {
        anyOf: [
          { type: 'object', properties: { attempts: { type: 'integer' } } },
          { type: 'number', minimum: 0, maximum: 1 }
        ]
      }
    }
  })
  assert.equal(normalized.tools[1].name, 'web_fetch')
  assert.equal(normalized.model, payload.model)
  assert.deepEqual(payload.tools[0].input_schema.properties.timeoutMs, {
    type: 'integer',
    minimum: 1,
    maximum: 300000,
    description: 'Timeout in milliseconds'
  })
})

test('ignores payloads without an Anthropic tool list', () => {
  const payloadWithoutTools = { model: 'claude-opus-5-5' }
  assert.equal(normalizeAnthropicToolSchemas(payloadWithoutTools), payloadWithoutTools)
  assert.equal(normalizeAnthropicToolSchemas(null), null)
})

test('normalizes Anthropic requests with OAuth or API key, but not other providers', () => {
  let handler: ((event: { payload: unknown }, ctx: ExtensionContext) => unknown) | undefined
  const pi: ExtensionAPI = {
    registerTool() {},
    on(event, callback) {
      if (event === 'before_provider_request') handler = callback as typeof handler
      return () => {}
    }
  }
  anthropicToolSchemaExtension(pi)
  assert.ok(handler)

  const context = (provider: string, isOAuth: boolean): ExtensionContext => ({
    model: { provider },
    modelRegistry: { isUsingOAuth: () => isOAuth }
  })

  assert.equal(handler({ payload }, context('openai-codex', true)), undefined)
  assert.equal(handler({ payload }, { ...context('anthropic', true), model: undefined }), undefined)
  assert.deepEqual(handler({ payload }, context('anthropic', true)), normalizeAnthropicToolSchemas(payload))
  assert.deepEqual(handler({ payload }, context('anthropic', false)), normalizeAnthropicToolSchemas(payload))
})

type OnPayload = (payload: unknown, model: { provider?: string }) => unknown

/** Fake model runtime: records options and runs `onPayload` the way a provider would. */
function fakeRuntime() {
  const sent: unknown[] = []
  const runtime = {
    async streamSimple(model: { provider?: string }, _context: unknown, options?: { onPayload?: OnPayload }) {
      const next = await options?.onPayload?.(payload, model)
      sent.push(next ?? payload)
      return options
    }
  }
  return { runtime, sent }
}

test('normalizes Anthropic requests made directly through the model runtime', async () => {
  const { runtime, sent } = fakeRuntime()
  normalizeRuntimeAnthropicRequests(runtime)

  await runtime.streamSimple({ provider: 'anthropic' }, {}, {})
  await runtime.streamSimple({ provider: 'openai-codex' }, {}, {})

  assert.deepEqual(sent, [normalizeAnthropicToolSchemas(payload), payload])
})

test('runtime normalization composes with an existing onPayload hook and wraps once', async () => {
  const { runtime, sent } = fakeRuntime()
  normalizeRuntimeAnthropicRequests(runtime)
  normalizeRuntimeAnthropicRequests(runtime)

  const tagged = { ...payload, metadata: { tagged: true } }
  const calls: unknown[] = []
  await runtime.streamSimple(
    { provider: 'anthropic' },
    {},
    {
      onPayload: (next: unknown) => {
        calls.push(next)
        return tagged
      }
    }
  )

  assert.equal(calls.length, 1)
  assert.deepEqual(sent, [normalizeAnthropicToolSchemas(tagged)])
})

test('session_start wraps the model registry runtime; unknown registry shapes are ignored', async () => {
  let onSessionStart: ((event: unknown, ctx: ExtensionContext) => unknown) | undefined
  const pi: ExtensionAPI = {
    registerTool() {},
    on(event, callback) {
      if (event === 'session_start') onSessionStart = callback as typeof onSessionStart
      return () => {}
    }
  }
  anthropicToolSchemaExtension(pi)
  assert.ok(onSessionStart)

  const { runtime, sent } = fakeRuntime()
  onSessionStart({}, { modelRegistry: { isUsingOAuth: () => true, runtime } })
  onSessionStart({}, { modelRegistry: { isUsingOAuth: () => true } })
  await runtime.streamSimple({ provider: 'anthropic' }, {}, {})

  assert.deepEqual(sent, [normalizeAnthropicToolSchemas(payload)])
})
