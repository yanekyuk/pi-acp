/**
 * Wire protocol shared by the adapter-side FS bridge server (fs-bridge.ts) and the
 * pi extension that runs inside the pi subprocess (src/pi-extension/acp-fs.ts).
 *
 * Transport: newline-delimited JSON over a local socket (unix domain socket or
 * Windows named pipe). One request produces exactly one response with the same id.
 *
 * Why a side channel: pi's RPC stdout is reserved for pi's own protocol and its
 * extension UI sub-protocol only covers dialogs/notifications, so tool operations
 * cannot ride on it.
 */
import * as readline from 'node:readline'
import type { Socket } from 'node:net'

export const FS_BRIDGE_SOCKET_ENV = 'PI_ACP_FS_SOCKET'
/** Set to "1" when the ACP client supports fs/read_text_file. */
export const FS_BRIDGE_READ_ENV = 'PI_ACP_FS_READ'

export type FsBridgeRequest =
  | { id: string; method: 'readTextFile'; path: string }
  | { id: string; method: 'writeTextFile'; path: string; content: string }

export type FsBridgeResponse = { id: string; ok: true; content?: string } | { id: string; ok: false; error: string }

export type FsBridgeHandler = {
  readTextFile?: (path: string) => Promise<string>
  writeTextFile: (path: string, content: string) => Promise<void>
}

export class FsBridgeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FsBridgeError'
  }
}

export function writeJsonLine(socket: Socket, message: unknown): void {
  socket.write(`${JSON.stringify(message)}\n`)
}

export function readJsonLines(socket: Socket, onMessage: (message: unknown) => void): void {
  const rl = readline.createInterface({ input: socket })
  rl.on('line', line => {
    if (!line.trim()) return
    try {
      onMessage(JSON.parse(line))
    } catch {
      // Ignore malformed lines; the peer only ever sends JSON.
    }
  })
}

export async function dispatchFsBridgeRequest(
  handler: FsBridgeHandler | null,
  request: FsBridgeRequest
): Promise<FsBridgeResponse> {
  try {
    if (!handler) throw new FsBridgeError('FS bridge has no handler bound')

    if (request.method === 'readTextFile') {
      if (!handler.readTextFile) throw new FsBridgeError('client does not support fs/read_text_file')
      return { id: request.id, ok: true, content: await handler.readTextFile(request.path) }
    }

    if (request.method === 'writeTextFile') {
      await handler.writeTextFile(request.path, request.content)
      return { id: request.id, ok: true }
    }

    throw new FsBridgeError(`unknown method: ${String((request as { method?: unknown }).method)}`)
  } catch (err) {
    return { id: request.id, ok: false, error: errorMessage(err) }
  }
}

export function isFsBridgeRequest(value: unknown): value is FsBridgeRequest {
  const record = value as Partial<FsBridgeRequest> | null
  if (!record || typeof record.id !== 'string' || typeof record.path !== 'string') return false
  if (record.method === 'readTextFile') return true
  if (record.method === 'writeTextFile') return typeof (record as { content?: unknown }).content === 'string'
  return false
}

export function isFsBridgeResponse(value: unknown): value is FsBridgeResponse {
  const record = value as Partial<FsBridgeResponse> | null
  return Boolean(record && typeof record.id === 'string' && typeof record.ok === 'boolean')
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string') {
    return (err as { message: string }).message
  }
  return String(err)
}
