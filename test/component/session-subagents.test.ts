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

test('PiAcpSession: subagent progress updates dynamic title and rich card content', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  createSession(conn, proc)

  // Subagent starts
  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't1',
    toolName: 'subagent',
    args: { agent: 'scout', task: 'Audit authentication endpoints' }
  })
  await tick()

  // Initial call update emitted
  const start = conn.updates.at(-1)?.update as any
  assert.equal(start.sessionUpdate, 'tool_call')
  assert.equal(start.title, 'Subagent: scout')
  assert.equal(start.status, 'in_progress')

  // Tool execution update 1: reading a file
  proc.emit({
    type: 'tool_execution_update',
    toolCallId: 't1',
    toolName: 'subagent',
    args: { agent: 'scout', task: 'Audit authentication endpoints' },
    partialResult: {
      content: [{ type: 'text', text: '(running...)' }],
      details: {
        mode: 'single',
        progress: [
          {
            agent: 'scout',
            status: 'running',
            durationMs: 1200,
            toolCount: 1,
            tokens: 450,
            currentTool: 'read',
            currentToolArgs: { path: 'src/auth/service.ts' }
          }
        ]
      }
    }
  })
  await tick()

  const update1 = conn.updates.at(-1)?.update as any
  assert.equal(update1.sessionUpdate, 'tool_call_update')
  assert.equal(update1.title, 'Subagent: scout (running · read src/auth/service.ts)')
  assert.equal(update1.status, 'in_progress')
  const card1Text = update1.content?.[0]?.content?.text
  assert.match(card1Text, /\*\*Subagent: scout\*\* · running \(1 tool · 450 tok · 1\.2s\)/)
  assert.match(card1Text, /\*\*Task\*\*: Audit authentication endpoints/)
  assert.match(card1Text, /- \*\*Current tool\*\*: `read` `src\/auth\/service\.ts`/)

  // Subagent completes
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 't1',
    toolName: 'subagent',
    isError: false,
    result: {
      content: [{ type: 'text', text: 'All endpoints are correctly protected by token auth.' }],
      details: {
        mode: 'single',
        results: [
          {
            agent: 'scout',
            exitCode: 0,
            progressSummary: { toolCount: 3, tokens: 1800, durationMs: 4500 }
          }
        ]
      }
    }
  })
  await tick()

  const finish = conn.updates.at(-1)?.update as any
  assert.equal(finish.sessionUpdate, 'tool_call_update')
  assert.equal(finish.status, 'completed')
  assert.equal(finish.title, 'Subagent: scout (completed · 3 tools · 4.5s)')
  const finishText = finish.content?.[0]?.content?.text
  assert.match(finishText, /\*\*Subagent: scout\*\* · completed \(3 tools · 1\.8k tok · 4\.5s\)/)
  assert.match(finishText, /All endpoints are correctly protected by token auth\./)
})

test('PiAcpSession: subagent failure formats error card with failed title', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  createSession(conn, proc)

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't2',
    toolName: 'subagent',
    args: { agent: 'worker', task: 'Run build tests' }
  })
  await tick()

  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 't2',
    toolName: 'subagent',
    isError: true,
    result: {
      content: [{ type: 'text', text: 'Compilation failed with 2 errors in src/main.ts.' }],
      details: {
        mode: 'single',
        results: [
          {
            agent: 'worker',
            exitCode: 1,
            durationMs: 3100
          }
        ]
      }
    }
  })
  await tick()

  const finish = conn.updates.at(-1)?.update as any
  assert.equal(finish.sessionUpdate, 'tool_call_update')
  assert.equal(finish.status, 'failed')
  assert.equal(finish.title, 'Subagent: worker (failed · 3.1s)')
  const finishText = finish.content?.[0]?.content?.text
  assert.match(finishText, /\*\*Subagent: worker\*\* · failed \(3\.1s\)/)
  assert.match(finishText, /Compilation failed with 2 errors in src\/main\.ts\./)
})

test('PiAcpSession: async subagent launch emits receipt in tool_call_update', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  createSession(conn, proc)

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't3',
    toolName: 'subagent',
    args: { agent: 'scanner', async: true, task: 'Deep scan codebase' }
  })
  await tick()

  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 't3',
    toolName: 'subagent',
    isError: false,
    result: {
      content: [{ type: 'text', text: 'Started run 12345' }],
      details: {
        asyncId: 'run-12345',
        runId: 'run-12345'
      }
    }
  })
  await tick()

  const finish = conn.updates.at(-1)?.update as any
  assert.equal(finish.sessionUpdate, 'tool_call_update')
  assert.equal(finish.status, 'completed')
  assert.equal(finish.title, 'Subagent: scanner (launched in background · run-12345)')
  const finishText = finish.content?.[0]?.content?.text
  assert.match(finishText, /\*\*Subagent: scanner\*\* · launched in background \(run `run-12345`\)/)
  assert.match(finishText, /subagent\(\{ action: "status", id: "run-12345" \}\)/)
})

test('PiAcpSession: chain workflow tracks multi-step progress', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  createSession(conn, proc)

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't4',
    toolName: 'subagent',
    args: { workflow: 'pr-review' }
  })
  await tick()

  proc.emit({
    type: 'tool_execution_update',
    toolCallId: 't4',
    toolName: 'subagent',
    args: { workflow: 'pr-review' },
    partialResult: {
      details: {
        mode: 'chain',
        progress: [
          { agent: 'scout', status: 'completed', durationMs: 1500, toolCount: 2 },
          {
            agent: 'reviewer',
            status: 'running',
            durationMs: 2200,
            currentTool: 'read',
            currentToolArgs: { path: 'src/app.ts' }
          }
        ]
      }
    }
  })
  await tick()

  const update = conn.updates.at(-1)?.update as any
  assert.equal(update.sessionUpdate, 'tool_call_update')
  const text = update.content?.[0]?.content?.text
  assert.match(text, /\*\*Subagent workflow: pr-review\*\* · running/)
  assert.match(text, /\*\*Steps\*\*:/)
  assert.match(text, /1\. \*\*scout\*\*: ✓ completed \(2 tools · 1\.5s\)/)
  assert.match(text, /2\. \*\*reviewer\*\*: ⟳ running/)
})
