import test from 'node:test'
import assert from 'node:assert/strict'
import { connect, type Socket } from 'node:net'
import { PiFsBridge } from '../../src/pi-rpc/fs-bridge.js'
import {
  FS_BRIDGE_READ_ENV,
  FS_BRIDGE_SOCKET_ENV,
  readJsonLines,
  writeJsonLine,
  type FsBridgeRequest,
  type FsBridgeResponse
} from '../../src/pi-rpc/fs-bridge-protocol.js'

async function connectClient(bridge: PiFsBridge): Promise<{
  socket: Socket
  request: (req: FsBridgeRequest) => Promise<FsBridgeResponse>
}> {
  const socket = connect(bridge.socketPath)
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })

  const pending = new Map<string, (res: FsBridgeResponse) => void>()
  readJsonLines(socket, message => {
    const res = message as FsBridgeResponse
    pending.get(res.id)?.(res)
    pending.delete(res.id)
  })

  return {
    socket,
    request: req =>
      new Promise(resolve => {
        pending.set(req.id, resolve)
        writeJsonLine(socket, req)
      })
  }
}

test('PiFsBridge: forwards writeTextFile and readTextFile to the bound handler', async () => {
  const bridge = await PiFsBridge.listen({ readTextFile: true, writeTextFile: true })
  const writes: Array<{ path: string; content: string }> = []
  bridge.setHandler({
    readTextFile: async path => `content of ${path}`,
    writeTextFile: async (path, content) => {
      writes.push({ path, content })
    }
  })

  const client = await connectClient(bridge)
  try {
    const write = await client.request({ id: '1', method: 'writeTextFile', path: '/p/a.txt', content: 'hello' })
    assert.deepEqual(write, { id: '1', ok: true })
    assert.deepEqual(writes, [{ path: '/p/a.txt', content: 'hello' }])

    const read = await client.request({ id: '2', method: 'readTextFile', path: '/p/b.txt' })
    assert.deepEqual(read, { id: '2', ok: true, content: 'content of /p/b.txt' })
  } finally {
    client.socket.destroy()
    bridge.close()
  }
})

test('PiFsBridge: reports handler errors and unsupported reads as ok:false', async () => {
  const bridge = await PiFsBridge.listen({ readTextFile: false, writeTextFile: true })
  const client = await connectClient(bridge)
  try {
    const unbound = await client.request({ id: '1', method: 'writeTextFile', path: '/p', content: '' })
    assert.equal(unbound.ok, false)

    bridge.setHandler({
      writeTextFile: async () => {
        throw new Error('outside project')
      }
    })

    const failed = await client.request({ id: '2', method: 'writeTextFile', path: '/p', content: '' })
    assert.deepEqual(failed, { id: '2', ok: false, error: 'outside project' })

    const read = await client.request({ id: '3', method: 'readTextFile', path: '/p' })
    assert.equal(read.ok, false)
    assert.match((read as { error: string }).error, /read_text_file/)
  } finally {
    client.socket.destroy()
    bridge.close()
  }
})

test(
  'PiFsBridge: falls back to a short Unix socket path when TMPDIR is too long',
  { skip: process.platform === 'win32' },
  async t => {
    const previousTmpdir = process.env.TMPDIR
    process.env.TMPDIR = `/tmp/${'nested-'.repeat(20)}`
    t.after(() => {
      if (previousTmpdir === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = previousTmpdir
    })

    const bridge = await PiFsBridge.listen({ readTextFile: true, writeTextFile: true })
    try {
      assert.match(bridge.socketPath, /^\/tmp\/pi-acp-fs-/)
    } finally {
      bridge.close()
    }
  }
)

test('PiFsBridge: childEnv advertises the socket and read capability', async () => {
  const bridge = await PiFsBridge.listen({ readTextFile: true, writeTextFile: true })
  try {
    assert.deepEqual(bridge.childEnv(), { [FS_BRIDGE_SOCKET_ENV]: bridge.socketPath, [FS_BRIDGE_READ_ENV]: '1' })
  } finally {
    bridge.close()
  }

  const noRead = await PiFsBridge.listen({ readTextFile: false, writeTextFile: true })
  try {
    assert.equal(noRead.childEnv()[FS_BRIDGE_READ_ENV], '0')
  } finally {
    noRead.close()
  }
})
