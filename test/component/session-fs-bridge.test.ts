import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession } from '../../src/acp/session.js'
import { PiFsBridge } from '../../src/pi-rpc/fs-bridge.js'
import { dispatchFsBridgeRequest } from '../../src/pi-rpc/fs-bridge-protocol.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

// Exercise the handler the session binds without going through the socket
// (socket transport is covered by test/unit/fs-bridge.test.ts).
function boundHandler(bridge: PiFsBridge) {
  return (bridge as unknown as { handler: Parameters<PiFsBridge['setHandler']>[0] | null }).handler
}

test('PiAcpSession: routes FS bridge requests to the ACP client fs methods with its sessionId', async () => {
  const bridge = await PiFsBridge.listen({ readTextFile: true, writeTextFile: true })
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.fsBridge = bridge

  try {
    new PiAcpSession({
      sessionId: 'session-1',
      cwd: '/p',
      mcpServers: [],
      proc: proc as any,
      conn: asAgentConn(conn),
      fileCommands: []
    })

    const handler = boundHandler(bridge)
    assert.ok(handler, 'session should bind a bridge handler')

    const write = await dispatchFsBridgeRequest(handler, {
      id: '1',
      method: 'writeTextFile',
      path: '/p/a.txt',
      content: 'new'
    })
    assert.deepEqual(write, { id: '1', ok: true })
    assert.deepEqual(conn.fileWrites, [{ sessionId: 'session-1', path: '/p/a.txt', content: 'new' }])

    const read = await dispatchFsBridgeRequest(handler, { id: '2', method: 'readTextFile', path: '/p/b.txt' })
    assert.deepEqual(read, { id: '2', ok: true, content: 'client buffer for /p/b.txt' })
    assert.deepEqual(conn.fileReads, [{ sessionId: 'session-1', path: '/p/b.txt' }])
  } finally {
    bridge.close()
  }
})

test('PiAcpSession: does not offer readTextFile when the client cannot read files', async () => {
  const bridge = await PiFsBridge.listen({ readTextFile: false, writeTextFile: true })
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.fsBridge = bridge

  try {
    new PiAcpSession({
      sessionId: 'session-2',
      cwd: '/p',
      mcpServers: [],
      proc: proc as any,
      conn: asAgentConn(conn),
      fileCommands: []
    })

    const handler = boundHandler(bridge)
    assert.ok(handler)
    assert.equal(handler.readTextFile, undefined)

    const read = await dispatchFsBridgeRequest(handler, { id: '1', method: 'readTextFile', path: '/p/b.txt' })
    assert.equal(read.ok, false)
    assert.deepEqual(conn.fileReads, [])
  } finally {
    bridge.close()
  }
})
