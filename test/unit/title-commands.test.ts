import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

const generateTestTitle = async () => 'Generated Test Title'

class FakeSessions {
  constructor(private readonly session: any) {}
  maybeGet(_id: string) {
    return this.session
  }
  get(_id: string) {
    return this.session
  }
  getOrCreate(_id: string) {
    return this.session
  }
}

test('PiAcpAgent: /title regenerate regenerates session title', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any

  let setNameCalledWith: string | null = null
  proc.setSessionName = async (name: string) => {
    setNameCalledWith = name
  }
  proc.getMessages = async () => ({
    messages: [
      { role: 'user', content: 'Configure Docker compose for Postgres' },
      { role: 'assistant', content: 'Here is the docker-compose.yml file' },
      { role: 'user', content: 'Use a health check before starting the app' }
    ]
  })

  let titled = false
  const fakeSession = {
    sessionId: 's1',
    cwd: process.cwd(),
    proc,
    fileCommands: [],
    getLastUserMessage: () => 'Configure Docker compose for Postgres',
    getIsTitled: () => titled,
    getIsTitling: () => false,
    setIsTitling: () => {},
    setTitle: () => {
      titled = true
    }
  }

  let titleGeneratorOptions: unknown
  const agent = new PiAcpAgent(asAgentConn(conn), {
    titleGenerator: async options => {
      titleGeneratorOptions = options
      return 'Generated Test Title'
    }
  })
  ;(agent as any).sessions = new FakeSessions(fakeSession) as any

  const res = await agent.prompt({
    sessionId: 's1',
    prompt: [{ type: 'text', text: '/title regenerate' }]
  } as any)

  assert.equal(res.stopReason, 'end_turn')
  assert.equal(proc.prompts.length, 0)
  assert.deepEqual((titleGeneratorOptions as any)?.conversation, [
    { role: 'user', text: 'Configure Docker compose for Postgres' },
    { role: 'assistant', text: 'Here is the docker-compose.yml file' },
    { role: 'user', text: 'Use a health check before starting the app' }
  ])
  assert.ok(setNameCalledWith)
  assert.equal(titled, true)

  const info = conn.updates.find(u => (u as any).update?.sessionUpdate === 'session_info_update')
  assert.ok(info)
  assert.equal((info as any)?.update?.title, setNameCalledWith)

  const last = conn.updates.at(-1)
  assert.match((last as any).update?.content?.text, /Session title set:/)
})

test('PiAcpAgent: /regenerate-title is an alias for regenerating title', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any

  let setNameCalledWith: string | null = null
  proc.setSessionName = async (name: string) => {
    setNameCalledWith = name
  }
  proc.getMessages = async () => ({
    messages: [{ role: 'user', content: 'Debug memory leak' }]
  })

  const fakeSession = {
    sessionId: 's1',
    cwd: process.cwd(),
    proc,
    fileCommands: [],
    getLastUserMessage: () => 'Debug memory leak',
    getIsTitled: () => false,
    getIsTitling: () => false,
    setIsTitling: () => {},
    setTitle: () => {}
  }

  const agent = new PiAcpAgent(asAgentConn(conn), { titleGenerator: generateTestTitle })
  ;(agent as any).sessions = new FakeSessions(fakeSession) as any

  const res = await agent.prompt({
    sessionId: 's1',
    prompt: [{ type: 'text', text: '/regenerate-title' }]
  } as any)

  assert.equal(res.stopReason, 'end_turn')
  assert.ok(setNameCalledWith)
  const info = conn.updates.find(u => (u as any).update?.sessionUpdate === 'session_info_update')
  assert.ok(info)
})

test('PiAcpAgent: /title with no arguments regenerates title', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any

  let setNameCalledWith: string | null = null
  proc.setSessionName = async (name: string) => {
    setNameCalledWith = name
  }
  proc.getMessages = async () => ({
    messages: [{ role: 'user', content: 'Add payment integration' }]
  })

  const fakeSession = {
    sessionId: 's1',
    cwd: process.cwd(),
    proc,
    fileCommands: [],
    getLastUserMessage: () => 'Add payment integration',
    getIsTitled: () => false,
    getIsTitling: () => false,
    setIsTitling: () => {},
    setTitle: () => {}
  }

  const agent = new PiAcpAgent(asAgentConn(conn), { titleGenerator: generateTestTitle })
  ;(agent as any).sessions = new FakeSessions(fakeSession) as any

  const res = await agent.prompt({
    sessionId: 's1',
    prompt: [{ type: 'text', text: '/title' }]
  } as any)

  assert.equal(res.stopReason, 'end_turn')
  assert.ok(setNameCalledWith)
})

test('PiAcpAgent: /title <name> sets title manually', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any

  let setNameCalledWith: string | null = null
  proc.setSessionName = async (name: string) => {
    setNameCalledWith = name
  }

  let sessionTitle: string | null = null
  const fakeSession = {
    sessionId: 's1',
    cwd: process.cwd(),
    proc,
    fileCommands: [],
    setTitle: (t: string) => {
      sessionTitle = t
    }
  }

  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = new FakeSessions(fakeSession) as any

  const res = await agent.prompt({
    sessionId: 's1',
    prompt: [{ type: 'text', text: '/title Custom Feature Name' }]
  } as any)

  assert.equal(res.stopReason, 'end_turn')
  assert.equal(setNameCalledWith, 'Custom Feature Name')
  assert.equal(sessionTitle, 'Custom Feature Name')

  const info = conn.updates.find(u => (u as any).update?.sessionUpdate === 'session_info_update')
  assert.equal((info as any)?.update?.title, 'Custom Feature Name')

  const last = conn.updates.at(-1)
  assert.match((last as any).update?.content?.text, /Session name set: Custom Feature Name/)
})

test('PiAcpAgent: extMethod session/regenerateTitle triggers title generation', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any

  let setNameCalledWith: string | null = null
  proc.setSessionName = async (name: string) => {
    setNameCalledWith = name
  }
  proc.getMessages = async () => ({
    messages: [{ role: 'user', content: 'Build authentication flow' }]
  })

  const fakeSession = {
    sessionId: 's1',
    cwd: process.cwd(),
    proc,
    fileCommands: [],
    getLastUserMessage: () => 'Build authentication flow',
    getIsTitled: () => false,
    getIsTitling: () => false,
    setIsTitling: () => {},
    setTitle: () => {}
  }

  const agent = new PiAcpAgent(asAgentConn(conn), { titleGenerator: generateTestTitle })
  ;(agent as any).sessions = new FakeSessions(fakeSession) as any

  const result = await agent.extMethod('session/regenerateTitle', { sessionId: 's1' })
  assert.equal(result.success, true)
  assert.ok(typeof result.title === 'string' && result.title.length > 0)
  assert.equal(setNameCalledWith, result.title)
})

test('PiAcpAgent: extMethod throws methodNotFound on unknown method', async () => {
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))

  await assert.rejects(async () => {
    await agent.extMethod('unknown_method', {})
  }, /Method not found/)
})
