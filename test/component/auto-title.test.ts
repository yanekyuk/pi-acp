import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

const generateTestTitle = async () => 'Responsive Navigation'

test('PiAcpAgent: auto-titles new session in background on first prompt', async t => {
  const previousAutoTitle = process.env.PI_ACP_AUTO_TITLE
  process.env.PI_ACP_AUTO_TITLE = 'true'
  t.after(() => {
    if (previousAutoTitle === undefined) delete process.env.PI_ACP_AUTO_TITLE
    else process.env.PI_ACP_AUTO_TITLE = previousAutoTitle
  })

  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any

  let setSessionNameValue: string | null = null
  proc.setSessionName = async (name: string) => {
    setSessionNameValue = name
  }
  proc.getMessages = async () => ({
    messages: [{ role: 'user', content: 'Create a responsive navigation bar' }]
  })

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc,
    conn: asAgentConn(conn)
  })

  const agent = new PiAcpAgent(asAgentConn(conn), { titleGenerator: generateTestTitle })
  ;(agent as any).sessions = {
    maybeGet: () => session,
    get: () => session,
    getOrCreate: () => session
  }

  // Simulate prompt run
  const promptPromise = agent.prompt({
    sessionId: 's1',
    prompt: [{ type: 'text', text: 'Create a responsive navigation bar' }]
  } as any)

  // Turn settles
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })

  const res = await promptPromise
  assert.equal(res.stopReason, 'end_turn')

  // Background auto-titling starts after the prompt settles.
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('auto-title did not complete')), 1_000)
    const poll = () => {
      if (session.getIsTitled()) {
        clearTimeout(timeout)
        resolve()
        return
      }
      setTimeout(poll, 0)
    }
    poll()
  })

  assert.equal(setSessionNameValue, 'Responsive Navigation')

  const infoUpdate = conn.updates.find(
    u => (u as any).update?.sessionUpdate === 'session_info_update' && (u as any).update?.title
  )
  assert.ok(infoUpdate)
  assert.equal((infoUpdate as any).update.title, setSessionNameValue)
})

test('PiAcpAgent: does not auto-title if session already has a title', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any

  let setSessionNameCalls = 0
  proc.setSessionName = async () => {
    setSessionNameCalls++
  }

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc,
    conn: asAgentConn(conn)
  })
  session.setTitle('Already Named Session')

  const agent = new PiAcpAgent(asAgentConn(conn), { titleGenerator: generateTestTitle })
  ;(agent as any).sessions = {
    maybeGet: () => session,
    get: () => session,
    getOrCreate: () => session
  }

  const promptPromise = agent.prompt({
    sessionId: 's1',
    prompt: [{ type: 'text', text: 'Another query' }]
  } as any)

  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })

  await promptPromise

  assert.equal(setSessionNameCalls, 0)
  assert.equal(session.getTitle(), 'Already Named Session')
})

test('PiAcpAgent: does not auto-title when autoTitle is disabled via env', async t => {
  const previousAutoTitle = process.env.PI_ACP_AUTO_TITLE
  t.after(() => {
    if (previousAutoTitle === undefined) delete process.env.PI_ACP_AUTO_TITLE
    else process.env.PI_ACP_AUTO_TITLE = previousAutoTitle
  })

  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any

  let setSessionNameCalls = 0
  proc.setSessionName = async () => {
    setSessionNameCalls++
  }

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc,
    conn: asAgentConn(conn)
  })

  const agent = new PiAcpAgent(asAgentConn(conn), { titleGenerator: generateTestTitle })
  ;(agent as any).sessions = {
    maybeGet: () => session,
    get: () => session,
    getOrCreate: () => session
  }

  process.env.PI_ACP_AUTO_TITLE = 'false'
  const promptPromise = agent.prompt({
    sessionId: 's1',
    prompt: [{ type: 'text', text: 'Do some work' }]
  } as any)

  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })

  await promptPromise

  assert.equal(setSessionNameCalls, 0)
  assert.equal(session.getIsTitled(), false)
})

test('PiAcpSession: extension UI setTitle updates session title and emits session_info_update', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn)
  })

  proc.emit({
    type: 'extension_ui_request',
    id: 'req-title',
    method: 'setTitle',
    title: 'Title From Extension'
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(session.getTitle(), 'Title From Extension')
  assert.equal(session.getIsTitled(), true)

  const infoUpdate = conn.updates.find(
    u =>
      (u as any).update?.sessionUpdate === 'session_info_update' && (u as any).update?.title === 'Title From Extension'
  )
  assert.ok(infoUpdate)
})
