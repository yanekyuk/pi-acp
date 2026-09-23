import type { AgentSideConnection } from '@agentclientprotocol/sdk'
import type { PiRpcEvent } from '../../src/pi-rpc/process.js'
import type { PiFsBridge } from '../../src/pi-rpc/fs-bridge.js'

type SessionUpdateMsg = Parameters<AgentSideConnection['sessionUpdate']>[0]

export class FakeAgentSideConnection {
  readonly updates: SessionUpdateMsg[] = []
  readonly permissionRequests: unknown[] = []
  readonly fileWrites: Array<{ sessionId: string; path: string; content: string }> = []
  readonly fileReads: Array<{ sessionId: string; path: string }> = []
  readonly elicitations: unknown[] = []
  nextPermissionResponse: { outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } } = {
    outcome: { outcome: 'selected', optionId: 'allow' }
  }
  nextElicitationResponse: ElicitationResponse = { action: 'cancel' }

  async sessionUpdate(msg: SessionUpdateMsg): Promise<void> {
    this.updates.push(msg)
  }

  async requestPermission(
    params: unknown
  ): Promise<{ outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } }> {
    this.permissionRequests.push(params)
    return this.nextPermissionResponse
  }

  async writeTextFile(params: { sessionId: string; path: string; content: string }): Promise<Record<string, never>> {
    this.fileWrites.push(params)
    return {}
  }

  async readTextFile(params: { sessionId: string; path: string }): Promise<{ content: string }> {
    this.fileReads.push(params)
    return { content: `client buffer for ${params.path}` }
  }

  async unstable_createElicitation(params: unknown): Promise<ElicitationResponse> {
    this.elicitations.push(params)
    return this.nextElicitationResponse
  }
}

type ElicitationResponse =
  | { action: 'accept'; content?: Record<string, string | number | boolean | string[]> }
  | { action: 'decline' }
  | { action: 'cancel' }

export class FakePiRpcProcess {
  private handlers: Array<(ev: PiRpcEvent) => void> = []
  fsBridge: PiFsBridge | null = null

  // spies
  readonly prompts: Array<{ message: string; attachments: unknown[] }> = []
  readonly extensionUiResponses: unknown[] = []
  abortCount = 0

  onEvent(handler: (ev: PiRpcEvent) => void): () => void {
    this.handlers.push(handler)
    return () => {
      this.handlers = this.handlers.filter(h => h !== handler)
    }
  }

  emit(ev: PiRpcEvent) {
    for (const h of this.handlers) h(ev)
  }

  async prompt(message: string, attachments: unknown[] = []): Promise<void> {
    this.prompts.push({ message, attachments })
  }

  async abort(): Promise<void> {
    this.abortCount += 1
  }

  async sendExtensionUiResponse(response: unknown): Promise<void> {
    this.extensionUiResponses.push(response)
  }

  async getState(): Promise<any> {
    return {}
  }

  async getAvailableModels(): Promise<any> {
    return { models: [{ provider: 'test', id: 'model', name: 'model' }] }
  }

  async getMessages(): Promise<any> {
    return { messages: [] }
  }
}

export function asAgentConn(conn: FakeAgentSideConnection): AgentSideConnection {
  // We only implement the method(s) used by PiAcpSession in tests.
  return conn as unknown as AgentSideConnection
}
