import test from 'node:test'
import assert from 'node:assert/strict'
import { parse, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'

class FakeStore {
  get(_sessionId: string) {
    return { sessionId: 's1', cwd: '/tmp/project', sessionFile: '/tmp/s.jsonl', updatedAt: new Date().toISOString() }
  }
  upsert() {}
}

test('PiAcpAgent: loadSession replays toolResult as tool_call + tool_call_update', async () => {
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => {
    return {
      onEvent: () => () => {},
      getMessages: async () => ({
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'toolCall',
                id: 'call_1',
                name: 'bash',
                arguments: { command: 'echo hello' }
              }
            ]
          },
          {
            role: 'toolResult',
            toolCallId: 'call_1',
            toolName: 'bash',
            content: [{ type: 'text', text: 'hello from bash' }],
            isError: false
          }
        ]
      }),
      getAvailableModels: async () => ({ models: [] }),
      getState: async () => ({ thinkingLevel: 'medium' })
    } as any
  }

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))
    ;(agent as any).store = new FakeStore()

    await agent.loadSession({ sessionId: 's1', cwd: '/tmp/project', mcpServers: [] } as any)

    const updates = conn.updates.map(u => (u as any).update)

    const toolCall = updates.find(u => u?.sessionUpdate === 'tool_call')
    assert.ok(toolCall)
    assert.equal(toolCall.toolCallId, 'call_1')
    assert.equal(toolCall.name, 'bash')
    assert.equal(toolCall.title, 'echo hello')
    assert.equal(toolCall.kind, 'execute')
    assert.deepEqual(toolCall.content, [{ type: 'terminal', terminalId: 'call_1' }])
    assert.deepEqual(toolCall._meta, { terminal_info: { terminal_id: 'call_1', cwd: '/tmp/project' } })
    assert.equal(toolCall.rawOutput, undefined)

    const toolCallUpdate = updates.find(u => u?.sessionUpdate === 'tool_call_update')
    assert.ok(toolCallUpdate)
    assert.equal(toolCallUpdate.toolCallId, 'call_1')
    assert.equal(toolCallUpdate.status, 'completed')
    assert.deepEqual(toolCallUpdate._meta, {
      terminal_output: { terminal_id: 'call_1', data: 'hello from bash' },
      terminal_exit: { terminal_id: 'call_1', exit_code: 0, signal: null }
    })
    assert.equal(toolCallUpdate.rawOutput, undefined)
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})

test('PiAcpAgent: loadSession restores browser images and artifact links', async () => {
  const originalSpawn = PiRpcProcess.spawn
  const imagePath = resolve(parse(process.cwd()).root, 'tmp', 'restored.png')
  const imageUri = pathToFileURL(imagePath).href
  ;(PiRpcProcess as any).spawn = async () => {
    return {
      onEvent: () => () => {},
      getMessages: async () => ({
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'toolCall',
                id: 'browser_1',
                name: 'agent_browser',
                arguments: { args: ['screenshot', imagePath] }
              }
            ]
          },
          {
            role: 'toolResult',
            toolCallId: 'browser_1',
            toolName: 'agent_browser',
            content: [
              { type: 'text', text: 'Saved image' },
              { type: 'image', data: 'cG5n', mimeType: 'image/png' }
            ],
            details: {
              imagePath,
              artifacts: [
                {
                  absolutePath: imagePath,
                  path: imagePath,
                  exists: true,
                  status: 'saved',
                  kind: 'image',
                  mediaType: 'image/png'
                }
              ]
            },
            isError: false
          },
          {
            role: 'assistant',
            content: [
              {
                type: 'toolCall',
                id: 'browser_1',
                name: 'agent_browser',
                arguments: { args: ['open', 'https://example.com'] }
              }
            ]
          }
        ]
      }),
      getAvailableModels: async () => ({ models: [] }),
      getState: async () => ({ thinkingLevel: 'medium' })
    } as any
  }

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))
    ;(agent as any).store = new FakeStore()

    await agent.loadSession({ sessionId: 's1', cwd: '/tmp/project', mcpServers: [] } as any)

    const updates = conn.updates.map(u => (u as any).update)
    const toolCall = updates.find(u => u?.sessionUpdate === 'tool_call')
    assert.equal(toolCall.title, `Browser: screenshot ${imagePath}`)
    assert.equal(toolCall.kind, 'fetch')
    assert.deepEqual(toolCall.rawInput, { args: ['screenshot', imagePath] })
    assert.equal(toolCall.rawOutput.content[1].data, '[base64 image omitted; forwarded as ACP image content]')
    assert.equal(toolCall.rawOutput.details.imagePath, imagePath)

    const toolCallUpdate = updates.find(u => u?.sessionUpdate === 'tool_call_update')
    assert.deepEqual(toolCallUpdate.content, [
      { type: 'content', content: { type: 'text', text: 'Saved image' } },
      {
        type: 'content',
        content: {
          type: 'image',
          data: 'cG5n',
          mimeType: 'image/png',
          uri: imageUri
        }
      },
      {
        type: 'content',
        content: {
          type: 'resource_link',
          uri: imageUri,
          name: 'restored.png',
          title: imagePath,
          description: 'Saved image artifact',
          mimeType: 'image/png'
        }
      }
    ])
    assert.equal(toolCallUpdate.rawOutput.content[1].data, '[base64 image omitted; forwarded as ACP image content]')
    assert.equal(toolCallUpdate.rawOutput.details.imagePath, imagePath)
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})

test('PiAcpAgent: loadSession falls back from malformed historical arguments to result arguments', async () => {
  const originalSpawn = PiRpcProcess.spawn
  const imagePath = resolve(parse(process.cwd()).root, 'tmp', 'fallback.png')
  ;(PiRpcProcess as any).spawn = async () => {
    return {
      onEvent: () => () => {},
      getMessages: async () => ({
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'toolCall',
                id: 'browser_fallback',
                name: 'agent_browser',
                arguments: ['malformed']
              }
            ]
          },
          {
            role: 'toolResult',
            toolCallId: 'browser_fallback',
            toolName: 'agent_browser',
            args: { args: ['screenshot', imagePath] },
            content: [{ type: 'text', text: 'Saved image' }],
            isError: false
          }
        ]
      }),
      getAvailableModels: async () => ({ models: [] }),
      getState: async () => ({ thinkingLevel: 'medium' })
    } as any
  }

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))
    ;(agent as any).store = new FakeStore()

    await agent.loadSession({ sessionId: 's1', cwd: '/tmp/project', mcpServers: [] } as any)

    const toolCall = conn.updates.map(u => (u as any).update).find(u => u?.sessionUpdate === 'tool_call')
    assert.equal(toolCall.title, `Browser: screenshot ${imagePath}`)
    assert.deepEqual(toolCall.rawInput, { args: ['screenshot', imagePath] })
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})
