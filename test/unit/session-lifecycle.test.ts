import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { SessionManager } from '../../src/acp/session.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

test('PiAcpAgent: initialize advertises stable resume and close capabilities', async () => {
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  const response = await agent.initialize({ protocolVersion: 1 } as any)

  assert.deepEqual(response.agentCapabilities?.sessionCapabilities?.resume, {})
  assert.deepEqual(response.agentCapabilities?.sessionCapabilities?.close, {})
})

test('PiAcpAgent: closeSession aborts and disposes only the requested live session', async () => {
  const conn = new FakeAgentSideConnection()
  const firstProc = new FakePiRpcProcess()
  const secondProc = new FakePiRpcProcess()
  const sessions = new SessionManager()

  sessions.getOrCreate('first', {
    cwd: process.cwd(),
    mcpServers: [],
    conn: asAgentConn(conn),
    proc: firstProc as any
  })
  sessions.getOrCreate('second', {
    cwd: process.cwd(),
    mcpServers: [],
    conn: asAgentConn(conn),
    proc: secondProc as any
  })

  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = sessions

  assert.deepEqual(await agent.closeSession({ sessionId: 'first' } as any), {})
  assert.equal(firstProc.abortCount, 1)
  assert.equal(firstProc.disposeCount, 1)
  assert.equal(secondProc.abortCount, 0)
  assert.equal(secondProc.disposeCount, 0)
  assert.equal(sessions.maybeGet('first'), undefined)
  assert.ok(sessions.maybeGet('second'))

  sessions.disposeAll()
})

test('PiAcpAgent: resumeSession restores state without replaying history', async () => {
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))
  const originalSpawn = PiRpcProcess.spawn
  let getMessagesCount = 0

  ;(agent as any).store = {
    get(sessionId: string) {
      return sessionId === 'stored-session'
        ? {
            sessionId,
            cwd: '/tmp/project',
            sessionFile: '/tmp/project/session.jsonl',
            updatedAt: new Date().toISOString()
          }
        : null
    },
    upsert() {},
    delete() {}
  }
  ;(PiRpcProcess as any).spawn = async () => ({
    onEvent: () => () => {},
    dispose() {},
    abort: async () => {},
    getState: async () => ({
      thinkingLevel: 'high',
      model: { provider: 'test', id: 'model' }
    }),
    getAvailableModels: async () => ({
      models: [{ provider: 'test', id: 'model', name: 'Model' }]
    }),
    getMessages: async () => {
      getMessagesCount += 1
      return { messages: [] }
    },
    getCommands: async () => ({ commands: [] }),
    getSessionStats: async () => ({
      cost: 0,
      contextUsage: { tokens: 100, contextWindow: 128_000 }
    })
  })

  try {
    const response = await agent.resumeSession({
      sessionId: 'stored-session',
      cwd: '/tmp/project',
      mcpServers: []
    } as any)

    assert.equal(getMessagesCount, 0)
    assert.equal(response.configOptions?.find(option => option.id === 'model')?.currentValue, 'test/model')
    assert.equal(response.configOptions?.find(option => option.id === 'thought_level')?.currentValue, 'high')
    assert.equal(Object.hasOwn(response, 'models'), false)
  } finally {
    PiRpcProcess.spawn = originalSpawn
    agent.dispose()
  }
})
