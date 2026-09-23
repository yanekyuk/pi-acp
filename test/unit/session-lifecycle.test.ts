import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { SessionManager } from '../../src/acp/session.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function storedSessionStore(sessionId: string, upserts: unknown[] = []) {
  return {
    get(requestedId: string) {
      return requestedId === sessionId
        ? {
            sessionId,
            cwd: '/tmp/project',
            sessionFile: '/tmp/project/session.jsonl',
            updatedAt: new Date().toISOString()
          }
        : null
    },
    upsert(entry: unknown) {
      upserts.push(entry)
    },
    delete() {}
  }
}

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

test('PiAcpAgent: closeSession cancels an in-flight restore before it can register', async () => {
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))
  const originalSpawn = PiRpcProcess.spawn
  const spawn = deferred<PiRpcProcess>()
  const proc = new FakePiRpcProcess()
  const upserts: unknown[] = []

  ;(agent as any).store = storedSessionStore('restoring-session', upserts)
  ;(PiRpcProcess as any).spawn = () => spawn.promise

  try {
    const resume = agent.resumeSession({
      sessionId: 'restoring-session',
      cwd: '/tmp/project',
      mcpServers: []
    } as any)
    const resumeRejected = assert.rejects(resume, /Session restore was cancelled/)

    let closeResolved = false
    const close = agent.closeSession({ sessionId: 'restoring-session' } as any).then(response => {
      closeResolved = true
      return response
    })
    await Promise.resolve()
    assert.equal(closeResolved, false)

    spawn.resolve(proc as any)
    assert.deepEqual(await close, {})
    await resumeRejected

    assert.equal(proc.disposeCount, 1)
    assert.equal((agent as any).sessions.maybeGet('restoring-session'), undefined)
    assert.deepEqual(upserts, [])
  } finally {
    PiRpcProcess.spawn = originalSpawn
    agent.dispose()
  }
})

test('PiAcpAgent: deleteSession cancels an in-flight restore without re-persisting it', async () => {
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))
  const originalSpawn = PiRpcProcess.spawn
  const spawn = deferred<PiRpcProcess>()
  const proc = new FakePiRpcProcess()
  const upserts: unknown[] = []
  const deletes: string[] = []
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'pi-acp-delete-restore-'))
  ;(agent as any).store = {
    ...storedSessionStore('deleting-session', upserts),
    delete(sessionId: string) {
      deletes.push(sessionId)
    }
  }
  ;(PiRpcProcess as any).spawn = () => spawn.promise

  try {
    const resume = agent.resumeSession({
      sessionId: 'deleting-session',
      cwd: '/tmp/project',
      mcpServers: []
    } as any)
    const resumeRejected = assert.rejects(resume, /Session restore was cancelled/)

    const deletion = agent.deleteSession({ sessionId: 'deleting-session' } as any)

    spawn.resolve(proc as any)
    assert.deepEqual(await deletion, {})
    await resumeRejected

    assert.equal(proc.disposeCount, 1)
    assert.deepEqual(deletes, ['deleting-session'])
    assert.deepEqual(upserts, [])
  } finally {
    PiRpcProcess.spawn = originalSpawn
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir
    agent.dispose()
  }
})

test('PiAcpAgent: dispose cancels every in-flight restore before registration', async () => {
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))
  const originalSpawn = PiRpcProcess.spawn
  const spawn = deferred<PiRpcProcess>()
  const proc = new FakePiRpcProcess()
  const upserts: unknown[] = []

  ;(agent as any).store = storedSessionStore('disposing-session', upserts)
  ;(PiRpcProcess as any).spawn = () => spawn.promise

  try {
    const resume = agent.resumeSession({
      sessionId: 'disposing-session',
      cwd: '/tmp/project',
      mcpServers: []
    } as any)
    const resumeRejected = assert.rejects(resume, /Session restore was cancelled/)

    agent.dispose()
    spawn.resolve(proc as any)
    await resumeRejected

    assert.equal(proc.disposeCount, 1)
    assert.equal((agent as any).sessions.maybeGet('disposing-session'), undefined)
    assert.deepEqual(upserts, [])
  } finally {
    PiRpcProcess.spawn = originalSpawn
    agent.dispose()
  }
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
