import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

function createSession(conn: FakeAgentSideConnection, proc: FakePiRpcProcess): PiAcpSession {
  return new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })
}

const tick = () => new Promise(r => setTimeout(r, 0))

test('PiAcpSession: extension tool calls get descriptive titles and ACP kinds', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  createSession(conn, proc)

  proc.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'web_search', args: { query: 'acp spec' } })
  proc.emit({ type: 'tool_execution_start', toolCallId: 't2', toolName: 'advisor', args: {} })
  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't3',
    toolName: 'subagent',
    args: { agent: 'scout', task: 'x' }
  })
  await tick()

  const calls = conn.updates.map(u => u.update as any)
  assert.deepEqual(
    calls.map(c => [c.sessionUpdate, c.title, c.kind]),
    [
      ['tool_call', 'Search: acp spec', 'search'],
      ['tool_call', 'Consult advisor', 'think'],
      ['tool_call', 'Subagent: scout', 'other']
    ]
  )
})

test('PiAcpSession: streamed tool call titles refine as args arrive', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  createSession(conn, proc)

  proc.emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'toolcall_start', toolCall: { id: 't1', name: 'web_fetch', partialArgs: '' } }
  })
  proc.emit({
    type: 'message_update',
    assistantMessageEvent: {
      type: 'toolcall_end',
      toolCall: { id: 't1', name: 'web_fetch', arguments: { url: 'https://example.com' } }
    }
  })
  await tick()

  const [start, end] = conn.updates.map(u => u.update as any)
  assert.equal(start.sessionUpdate, 'tool_call')
  assert.equal(start.title, 'Web fetch')
  assert.equal(start.kind, 'fetch')
  assert.equal(end.sessionUpdate, 'tool_call_update')
  assert.equal(end.title, 'Fetch https://example.com')
})

test('PiAcpSession: todo tool results are mirrored into ACP plan updates', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  createSession(conn, proc)

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't1',
    toolName: 'todo',
    args: { action: 'create', subject: 'A' }
  })
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 't1',
    toolName: 'todo',
    isError: false,
    result: {
      content: [{ type: 'text', text: 'Created #1: A (pending)' }],
      details: { action: 'create', nextId: 2, tasks: [{ id: 1, subject: 'A', status: 'pending' }] }
    }
  })
  await tick()

  const updates = conn.updates.map(u => u.update as any)
  assert.deepEqual(
    updates.map(u => u.sessionUpdate),
    ['tool_call', 'tool_call_update', 'plan']
  )
  assert.equal(updates[0].title, 'Todo create A')
  assert.deepEqual(updates[2], {
    sessionUpdate: 'plan',
    entries: [{ content: 'A', status: 'pending', priority: 'medium', _meta: { piAcp: { id: 1 } } }]
  })
})

test('PiAcpSession: todo plan uses the tool name recorded at start when the end event omits it', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  createSession(conn, proc)

  proc.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'todo', args: { action: 'clear' } })
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 't1',
    isError: false,
    result: { content: [{ type: 'text', text: 'Cleared 2 tasks' }], details: { action: 'clear', tasks: [] } }
  })
  await tick()

  assert.deepEqual(conn.updates.at(-1)!.update, { sessionUpdate: 'plan', entries: [] })
})

test('PiAcpSession: extension slash commands end the turn when pi answers without an agent run', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = createSession(conn, proc)
  session.setExtensionCommands(['mcp', 'goal'])

  const stopReason = await session.prompt('/mcp status')

  assert.equal(stopReason, 'end_turn')
  assert.deepEqual(proc.prompts, [{ message: '/mcp status', attachments: [] }])
})

test('PiAcpSession: extension slash commands that start an agent run wait for agent_settled', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = createSession(conn, proc)
  session.setExtensionCommands(['goal'])

  let settled = false
  const turn = session.prompt('/goal ship it').then(reason => {
    settled = true
    return reason
  })

  // The command handler kicked off a prompt: pi starts an agent run right away.
  proc.emit({ type: 'agent_start' })
  await new Promise(r => setTimeout(r, 80))
  assert.equal(settled, false)

  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await turn, 'end_turn')
})

test('PiAcpSession: extension slash commands that only append custom messages still end the turn', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = createSession(conn, proc)
  session.setExtensionCommands(['subagents-fleet'])

  const turn = session.prompt('/subagents-fleet')
  const notice = { role: 'custom', customType: 'fleet', display: true, content: '2 runs active' }
  proc.emit({ type: 'message_start', message: notice })
  proc.emit({ type: 'message_end', message: notice })

  assert.equal(await turn, 'end_turn')
  const texts = conn.updates.map(u => (u.update as any).content?.text).filter(Boolean)
  assert.deepEqual(texts, ['2 runs active'])
})

test('PiAcpSession: unknown slash commands are ordinary prompts that wait for agent_settled', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = createSession(conn, proc)
  session.setExtensionCommands(['mcp'])

  let settled = false
  const turn = session.prompt('/skill:deploy prod').then(reason => {
    settled = true
    return reason
  })

  await new Promise(r => setTimeout(r, 80))
  assert.equal(settled, false)

  proc.emit({ type: 'agent_settled' })
  assert.equal(await turn, 'end_turn')
})

test('PiAcpSession: displayed custom messages from extensions are surfaced as agent text', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  createSession(conn, proc)

  proc.emit({
    type: 'message_end',
    message: { role: 'custom', customType: 'subagent-notice', display: true, content: 'Run abc finished.' }
  })
  proc.emit({
    type: 'message_end',
    message: { role: 'custom', customType: 'hidden', display: false, content: 'secret' }
  })
  proc.emit({
    type: 'message_end',
    message: {
      role: 'custom',
      customType: 'blocks',
      display: true,
      content: [
        { type: 'text', text: 'part 1 ' },
        { type: 'text', text: 'part 2' }
      ]
    }
  })
  proc.emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'ignored' }] } })
  await tick()

  assert.deepEqual(
    conn.updates.map(u => u.update),
    [
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Run abc finished.' },
        _meta: { piAcp: { customMessage: { customType: 'subagent-notice' } } }
      },
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'part 1 part 2' },
        _meta: { piAcp: { customMessage: { customType: 'blocks' } } }
      }
    ]
  )
})

test('PiAcpSession: extension errors are surfaced as error-tagged agent text', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  createSession(conn, proc)

  proc.emit({ type: 'extension_error', extensionPath: 'command:mcp', event: 'command', error: 'boom' })
  await tick()

  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Pi extension error (command:mcp): boom' },
    _meta: { piAcp: { notify: { level: 'error' } } }
  })
})
