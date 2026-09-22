/**
 * Adapter-side FS bridge.
 *
 * Zed (and other ACP clients) only track "files edited by this session" for writes
 * that go through the client's `fs/write_text_file` method. pi's built-in edit/write
 * tools write straight to disk, so we load a pi extension (src/pi-extension/acp-fs.ts)
 * that overrides those tools and forwards file operations here over a local socket.
 * This class owns the socket server and forwards each request to the ACP connection.
 */
import { existsSync, unlinkSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  FS_BRIDGE_READ_ENV,
  FS_BRIDGE_SOCKET_ENV,
  dispatchFsBridgeRequest,
  isFsBridgeRequest,
  readJsonLines,
  writeJsonLine,
  type FsBridgeHandler
} from './fs-bridge-protocol.js'

export type FsBridgeCapabilities = {
  readTextFile: boolean
  writeTextFile: boolean
}

export class PiFsBridge {
  private handler: FsBridgeHandler | null = null
  private readonly sockets = new Set<Socket>()

  private constructor(
    private readonly server: Server,
    readonly socketPath: string,
    readonly capabilities: FsBridgeCapabilities
  ) {
    server.on('connection', socket => this.acceptConnection(socket))
  }

  static async listen(capabilities: FsBridgeCapabilities): Promise<PiFsBridge> {
    const socketPath = newSocketPath()
    const server = createServer()

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, () => {
        server.off('error', reject)
        resolve()
      })
    })

    return new PiFsBridge(server, socketPath, capabilities)
  }

  /** Environment variables the pi subprocess needs to reach this bridge. */
  childEnv(): Record<string, string> {
    return {
      [FS_BRIDGE_SOCKET_ENV]: this.socketPath,
      [FS_BRIDGE_READ_ENV]: this.capabilities.readTextFile ? '1' : '0'
    }
  }

  /** Bind the ACP session that file operations are forwarded to. */
  setHandler(handler: FsBridgeHandler): void {
    this.handler = handler
  }

  close(): void {
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    this.server.close()
    if (process.platform !== 'win32' && existsSync(this.socketPath)) {
      try {
        unlinkSync(this.socketPath)
      } catch {
        // ignore
      }
    }
  }

  private acceptConnection(socket: Socket): void {
    this.sockets.add(socket)
    socket.on('close', () => this.sockets.delete(socket))
    socket.on('error', () => {
      // The pi subprocess went away; nothing to do.
    })

    readJsonLines(socket, message => {
      if (!isFsBridgeRequest(message)) return
      void dispatchFsBridgeRequest(this.handler, message).then(response => {
        if (!socket.destroyed) writeJsonLine(socket, response)
      })
    })
  }
}

/**
 * Path to the pi extension that routes read/edit/write through the bridge.
 * Resolves to the bundled file next to dist/index.js, or the TypeScript source
 * when running from src via tsx (pi loads extensions through jiti, so .ts works).
 */
export function resolveFsBridgeExtensionPath(): string {
  const candidates = [
    new URL('./acp-fs-extension.js', import.meta.url),
    new URL('../pi-extension/acp-fs.ts', import.meta.url)
  ]
  for (const candidate of candidates) {
    const path = fileURLToPath(candidate)
    if (existsSync(path)) return path
  }
  throw new Error('pi-acp: FS bridge extension not found (is the package built?)')
}

function newSocketPath(): string {
  const name = `pi-acp-fs-${process.pid}-${crypto.randomUUID().slice(0, 8)}`
  if (process.platform === 'win32') return `\\\\.\\pipe\\${name}`
  return join(tmpdir(), `${name}.sock`)
}
