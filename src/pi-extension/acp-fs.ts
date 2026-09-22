/**
 * pi extension loaded by pi-acp (`pi --mode rpc -e <this file>`).
 *
 * Overrides pi's built-in `read`, `edit` and `write` tools so file contents flow
 * through the ACP client's `fs/read_text_file` / `fs/write_text_file` methods
 * instead of touching the disk directly. That is what lets editors like Zed
 * track "files edited by this session" (Keep/Reject), see unsaved buffer
 * contents, and follow the agent's location.
 *
 * The extension talks to the adapter over the FS bridge socket advertised in
 * PI_ACP_FS_SOCKET (see src/pi-rpc/fs-bridge.ts). Any client-side failure falls
 * back to the local filesystem: clients typically reject paths outside the
 * open project, and pi should still be able to work with those.
 */
import {
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type EditOperations,
  type ExtensionAPI,
  type ReadOperations,
  type WriteOperations
} from '@earendil-works/pi-coding-agent'
import { constants } from 'node:fs'
import { access, mkdir, open, readFile, writeFile } from 'node:fs/promises'
import { connect, type Socket } from 'node:net'
import {
  FS_BRIDGE_READ_ENV,
  FS_BRIDGE_SOCKET_ENV,
  isFsBridgeResponse,
  readJsonLines,
  writeJsonLine,
  type FsBridgeRequest,
  type FsBridgeResponse
} from '../pi-rpc/fs-bridge-protocol.js'

type PendingRequest = {
  resolve: (response: FsBridgeResponse) => void
  reject: (err: Error) => void
}

class FsBridgeClient {
  private socket: Socket | null = null
  private connecting: Promise<Socket> | null = null
  private readonly pending = new Map<string, PendingRequest>()

  constructor(private readonly socketPath: string) {}

  async readTextFile(path: string): Promise<string> {
    const response = await this.request({ id: crypto.randomUUID(), method: 'readTextFile', path })
    return response.content ?? ''
  }

  async writeTextFile(path: string, content: string): Promise<void> {
    await this.request({ id: crypto.randomUUID(), method: 'writeTextFile', path, content })
  }

  private async request(request: FsBridgeRequest): Promise<FsBridgeResponse & { ok: true }> {
    const socket = await this.ensureConnected()
    const response = await new Promise<FsBridgeResponse>((resolve, reject) => {
      this.pending.set(request.id, { resolve, reject })
      writeJsonLine(socket, request)
    })
    if (!response.ok) throw new Error(response.error)
    return response
  }

  private ensureConnected(): Promise<Socket> {
    if (this.socket && !this.socket.destroyed) return Promise.resolve(this.socket)
    if (this.connecting) return this.connecting

    this.connecting = new Promise<Socket>((resolve, reject) => {
      const socket = connect(this.socketPath)
      socket.once('connect', () => {
        this.socket = socket
        this.connecting = null
        resolve(socket)
      })
      socket.once('error', err => {
        this.connecting = null
        this.rejectAllPending(err)
        reject(err)
      })
      socket.on('close', () => {
        if (this.socket === socket) this.socket = null
        this.rejectAllPending(new Error('FS bridge connection closed'))
      })
      readJsonLines(socket, message => {
        if (!isFsBridgeResponse(message)) return
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)
        pending.resolve(message)
      })
    })
    return this.connecting
  }

  private rejectAllPending(err: Error): void {
    for (const [, pending] of this.pending) pending.reject(err)
    this.pending.clear()
  }
}

// pi's read tool asks detectImageMimeType() before readFile(); remember the answer so
// image bytes are read from disk instead of being mangled by a text read.
function createClientReadOperations(client: FsBridgeClient): ReadOperations {
  const imagePaths = new Set<string>()
  return {
    access: path => access(path, constants.R_OK),
    detectImageMimeType: async path => {
      const mimeType = await detectImageMimeType(path)
      if (mimeType) imagePaths.add(path)
      else imagePaths.delete(path)
      return mimeType
    },
    readFile: path => (imagePaths.has(path) ? readFile(path) : readTextViaClient(client, path))
  }
}

function createClientEditOperations(client: FsBridgeClient, readViaClient: boolean): EditOperations {
  return {
    access: path => access(path, constants.R_OK | constants.W_OK),
    readFile: path => (readViaClient ? readTextViaClient(client, path) : readFile(path)),
    writeFile: (path, content) => writeTextViaClient(client, path, content)
  }
}

function createClientWriteOperations(client: FsBridgeClient): WriteOperations {
  return {
    mkdir: dir => mkdir(dir, { recursive: true }).then(() => undefined),
    writeFile: (path, content) => writeTextViaClient(client, path, content)
  }
}

async function readTextViaClient(client: FsBridgeClient, path: string): Promise<Buffer> {
  try {
    return Buffer.from(await client.readTextFile(path), 'utf8')
  } catch {
    return readFile(path)
  }
}

async function writeTextViaClient(client: FsBridgeClient, path: string, content: string): Promise<void> {
  try {
    await client.writeTextFile(path, content)
  } catch {
    await writeFile(path, content, 'utf8')
  }
}

const IMAGE_SIGNATURES: Array<{ mimeType: string; matches: (head: Buffer) => boolean }> = [
  { mimeType: 'image/png', matches: head => head.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])) },
  { mimeType: 'image/jpeg', matches: head => head.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) },
  { mimeType: 'image/gif', matches: head => head.subarray(0, 4).toString('latin1') === 'GIF8' },
  {
    mimeType: 'image/webp',
    matches: head =>
      head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP'
  },
  { mimeType: 'image/bmp', matches: head => head.subarray(0, 2).toString('latin1') === 'BM' }
]

async function detectImageMimeType(path: string): Promise<string | undefined> {
  let head: Buffer
  try {
    const handle = await open(path, 'r')
    try {
      const buffer = Buffer.alloc(12)
      const { bytesRead } = await handle.read(buffer, 0, 12, 0)
      head = buffer.subarray(0, bytesRead)
    } finally {
      await handle.close()
    }
  } catch {
    return undefined
  }
  return IMAGE_SIGNATURES.find(signature => signature.matches(head))?.mimeType
}

export default function acpFsExtension(pi: ExtensionAPI): void {
  const socketPath = process.env[FS_BRIDGE_SOCKET_ENV]
  if (!socketPath) return

  const client = new FsBridgeClient(socketPath)
  const readViaClient = process.env[FS_BRIDGE_READ_ENV] === '1'
  const cwd = process.cwd()

  // Same name as the built-ins, so these replace them. The definitions keep pi's
  // schema, renderers and prompt guidelines; only the file operations change.
  pi.registerTool(createEditToolDefinition(cwd, { operations: createClientEditOperations(client, readViaClient) }))
  pi.registerTool(createWriteToolDefinition(cwd, { operations: createClientWriteOperations(client) }))
  if (readViaClient) {
    pi.registerTool(createReadToolDefinition(cwd, { operations: createClientReadOperations(client) }))
  }
}
