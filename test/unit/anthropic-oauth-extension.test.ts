import assert from 'node:assert/strict'
import test from 'node:test'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import anthropicOauthExtension, { normalizeAnthropicOauthToolSchemas } from '../../src/pi-extension/anthropic-oauth.js'

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
  const normalized = normalizeAnthropicOauthToolSchemas(payload) as typeof payload

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
  assert.equal(normalizeAnthropicOauthToolSchemas(payloadWithoutTools), payloadWithoutTools)
  assert.equal(normalizeAnthropicOauthToolSchemas(null), null)
})

test('only normalizes requests for an Anthropic OAuth model', () => {
  let handler: ((event: { payload: unknown }, ctx: ExtensionContext) => unknown) | undefined
  const pi: ExtensionAPI = {
    registerTool() {},
    on(event, callback) {
      assert.equal(event, 'before_provider_request')
      handler = callback
      return () => {}
    }
  }
  anthropicOauthExtension(pi)
  assert.ok(handler)

  const context = (provider: string, isOAuth: boolean): ExtensionContext => ({
    model: { provider },
    modelRegistry: { isUsingOAuth: () => isOAuth }
  })

  assert.equal(handler({ payload }, context('openai-codex', true)), undefined)
  assert.equal(handler({ payload }, context('anthropic', false)), undefined)
  assert.equal(handler({ payload }, { ...context('anthropic', true), model: undefined }), undefined)
  assert.deepEqual(handler({ payload }, context('anthropic', true)), normalizeAnthropicOauthToolSchemas(payload))
})
