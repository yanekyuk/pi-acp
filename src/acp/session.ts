import type {
  AgentSideConnection,
  ContentBlock,
  McpServer,
  PermissionOption,
  SessionUpdate,
  ToolCallContent,
  ToolCallLocation
} from '@agentclientprotocol/sdk'
import { RequestError } from '@agentclientprotocol/sdk'
import { readFileSync } from 'node:fs'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import { PiRpcProcess, PiRpcSpawnError, type PiRpcEvent } from '../pi-rpc/process.js'
import type { FsBridgeCapabilities } from '../pi-rpc/fs-bridge.js'
import { maybeAuthRequiredError } from './auth-required.js'
import { SessionStore } from './session-store.js'
import { expandSlashCommand, type FileSlashCommand } from './slash-commands.js'
import {
  bashCommand,
  bashExitCode,
  bashOutputDelta,
  bashResultText,
  bashTerminalContent,
  bashTerminalExitMeta,
  bashTerminalInfoMeta,
  bashTerminalOutputMeta,
  isBashTool
} from './translate/bash.js'
import { toolResultToContent, toolResultToRawOutput } from './translate/pi-tools.js'
import { toToolKind, toToolTitle } from './translate/extension-tools.js'
import { TODO_TOOL_NAME, todoResultToPlan } from './translate/plan.js'
import { sessionStatsToUsageUpdate } from './translate/usage.js'
import {
  buildSelectElicitation,
  buildTextElicitation,
  elicitationSelectedOption,
  elicitationTextValue,
  formatChatInputPrompt,
  formatSelectPrompt,
  parseExtensionCommandName,
  selectOptionLabel,
  uiRequestPrompt,
  type TextInputMethod
} from './translate/extension-ui.js'

/** Client-side ACP capabilities that change how pi extension UI requests are rendered. */
export type ClientUiCapabilities = {
  /** Client advertised `clientCapabilities.elicitation.form`. */
  elicitationForm: boolean
}

type SessionCreateParams = {
  cwd: string
  mcpServers: McpServer[]
  conn: AgentSideConnection
  fileCommands?: import('./slash-commands.js').FileSlashCommand[]
  piCommand?: string
  clientFs?: FsBridgeCapabilities
  clientUi?: ClientUiCapabilities
}

export type StopReason = 'end_turn' | 'cancelled' | 'error'

type PendingTurn = {
  resolve: (reason: StopReason) => void
  reject: (err: unknown) => void
}

type QueuedTurn = {
  message: string
  images: unknown[]
  /** The prompt is a pi extension slash command; pi may execute it without starting an agent run. */
  isExtensionCommand: boolean
  resolve: (reason: StopReason) => void
  reject: (err: unknown) => void
}

/**
 * A pi `input`/`editor` UI request that is waiting for the user's next chat message
 * (fallback for clients without ACP elicitation support).
 */
type PendingChatInput = {
  id: string
  method: TextInputMethod
}

type PermissionResponse = Awaited<ReturnType<AgentSideConnection['requestPermission']>>

const CONFIRM_PERMISSION_OPTIONS: PermissionOption[] = [
  { optionId: 'yes', name: 'Yes', kind: 'allow_once' },
  { optionId: 'no', name: 'No', kind: 'reject_once' }
]
const EXTENSION_UI_RAW_INPUT_KEYS = ['title', 'message', 'options', 'placeholder', 'prefill'] as const
const CHOICE_OPTION_PREFIX = 'choice-'

// Pi answers a `prompt` RPC for an extension command only after the command handler returns.
// If the handler kicked off an agent run (e.g. via pi.sendUserMessage), `agent_start` arrives
// shortly after; give it a brief window before closing the ACP turn.
const EXTENSION_COMMAND_SETTLE_GRACE_MS = 50

// Fire-and-forget pi UI methods: no `extension_ui_response` is expected.
const FIRE_AND_FORGET_UI_METHODS = new Set(['notify', 'setStatus', 'setWidget', 'setTitle', 'set_editor_text'])

function findUniqueLineNumber(text: string, needle: string): number | undefined {
  if (!needle) return undefined

  const first = text.indexOf(needle)
  if (first < 0) return undefined

  const second = text.indexOf(needle, first + needle.length)
  if (second >= 0) return undefined

  let line = 1
  for (let i = 0; i < first; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1
  }
  return line
}

function getToolPath(args: unknown): string | undefined {
  const record = args as { path?: unknown; file_path?: unknown } | null | undefined
  if (typeof record?.path === 'string') return record.path
  if (typeof record?.file_path === 'string') return record.file_path
  return undefined
}

// Match pi's current edit schema: { path, edits: [{ oldText, newText }] }, with
// legacy top-level oldText/newText still accepted. Pi also normalizes stringified edits.
// https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/tools/edit.ts
function getParsedEdits(args: unknown): Array<{ oldText: string; newText: string }> {
  const record = args as { oldText?: unknown; newText?: unknown; edits?: unknown } | null | undefined
  const parsed: Array<{ oldText: string; newText: string }> = []

  if (typeof record?.oldText === 'string' && typeof record?.newText === 'string') {
    parsed.push({ oldText: record.oldText, newText: record.newText })
  }

  let edits = record?.edits
  if (typeof edits === 'string') {
    try {
      edits = JSON.parse(edits) as unknown
    } catch {
      edits = undefined
    }
  }

  if (Array.isArray(edits)) {
    for (const edit of edits) {
      const item = edit as { oldText?: unknown; newText?: unknown } | null | undefined
      if (typeof item?.oldText === 'string' && typeof item?.newText === 'string') {
        parsed.push({ oldText: item.oldText, newText: item.newText })
      }
    }
  }

  return parsed
}

function getEditOldTexts(args: unknown): string[] {
  const record = args as { oldText?: unknown; edits?: unknown } | null | undefined
  const oldTexts = getParsedEdits(args).map(edit => edit.oldText)

  if (typeof record?.oldText === 'string' && !oldTexts.includes(record.oldText)) oldTexts.push(record.oldText)

  let edits = record?.edits
  if (typeof edits === 'string') {
    try {
      edits = JSON.parse(edits) as unknown
    } catch {
      edits = undefined
    }
  }

  if (Array.isArray(edits)) {
    for (const edit of edits) {
      const oldText = (edit as { oldText?: unknown } | null | undefined)?.oldText
      if (typeof oldText === 'string' && !oldTexts.includes(oldText)) oldTexts.push(oldText)
    }
  }

  return oldTexts
}

function toToolCallLocations(args: unknown, cwd: string, line?: number): ToolCallLocation[] | undefined {
  const path = getToolPath(args)
  if (!path) return undefined

  const resolvedPath = isAbsolute(path) ? path : resolvePath(cwd, path)
  return [{ path: resolvedPath, ...(typeof line === 'number' ? { line } : {}) }]
}

function assistantMessageId(message: unknown): string {
  const record = message as { id?: unknown; messageId?: unknown; responseId?: unknown } | null
  for (const candidate of [record?.id, record?.messageId, record?.responseId]) {
    if (typeof candidate === 'string' && candidate) return candidate
  }

  return crypto.randomUUID()
}

export class SessionManager {
  private sessions = new Map<string, PiAcpSession>()
  private readonly store = new SessionStore()

  /** Dispose all sessions and their underlying pi subprocesses. */
  disposeAll(): void {
    for (const [id] of this.sessions) this.close(id)
  }

  /** Get a registered session if it exists (no throw). */
  maybeGet(sessionId: string): PiAcpSession | undefined {
    return this.sessions.get(sessionId)
  }

  /**
   * Dispose a session's underlying pi process and remove it from the manager.
   * Used when clients explicitly reload a session and we want a fresh pi subprocess.
   */
  close(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    try {
      s.proc.dispose?.()
    } catch {
      // ignore
    }
    this.sessions.delete(sessionId)
  }

  async create(params: SessionCreateParams): Promise<PiAcpSession> {
    // Let pi manage session persistence in its default location (~/.pi/agent/sessions/...)
    // so sessions are visible to the regular `pi` CLI.
    let proc: PiRpcProcess
    try {
      proc = await PiRpcProcess.spawn({
        cwd: params.cwd,
        piCommand: params.piCommand,
        clientFs: params.clientFs
      })
    } catch (e) {
      if (e instanceof PiRpcSpawnError) {
        throw RequestError.internalError({ code: e.code }, e.message)
      }
      throw e
    }

    let state: any = null
    try {
      state = (await proc.getState()) as any
    } catch {
      state = null
    }

    const sessionId = typeof state?.sessionId === 'string' ? state.sessionId : crypto.randomUUID()
    const sessionFile = typeof state?.sessionFile === 'string' ? state.sessionFile : null

    if (sessionFile) {
      this.store.upsert({ sessionId, cwd: params.cwd, sessionFile })
    }

    const session = new PiAcpSession({
      sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      proc,
      conn: params.conn,
      fileCommands: params.fileCommands ?? [],
      clientUi: params.clientUi
    })

    this.sessions.set(sessionId, session)
    return session
  }

  get(sessionId: string): PiAcpSession {
    const s = this.sessions.get(sessionId)
    if (!s) throw RequestError.invalidParams(`Unknown sessionId: ${sessionId}`)
    return s
  }

  /**
   * Used by session/load: create a session object bound to an existing sessionId/proc
   * if it isn't already registered.
   */
  getOrCreate(sessionId: string, params: SessionCreateParams & { proc: PiRpcProcess }): PiAcpSession {
    const existing = this.sessions.get(sessionId)
    if (existing) return existing

    const session = new PiAcpSession({
      sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      proc: params.proc,
      conn: params.conn,
      fileCommands: params.fileCommands ?? [],
      clientUi: params.clientUi
    })

    this.sessions.set(sessionId, session)
    return session
  }
}

export class PiAcpSession {
  readonly sessionId: string
  readonly cwd: string
  readonly mcpServers: McpServer[]

  private startupInfo: string | null = null
  private startupInfoSent = false

  readonly proc: PiRpcProcess
  private readonly conn: AgentSideConnection
  private readonly fileCommands: FileSlashCommand[]
  private readonly clientUi: ClientUiCapabilities

  // Slash commands registered by pi extensions (from pi's `get_commands`). Pi executes these
  // inside the `prompt` RPC, usually without starting an agent run.
  private extensionCommands = new Set<string>()

  // Used to map abort semantics to ACP stopReason.
  // Applies to the currently running turn.
  private cancelRequested = false

  // Current in-flight turn (if any). Additional prompts are queued.
  private pendingTurn: PendingTurn | null = null
  private readonly turnQueue: QueuedTurn[] = []
  // Whether pi emitted `agent_start` since the current turn began.
  private agentRunObserved = false

  // A pi text input request waiting for the user's next chat message.
  private pendingChatInput: PendingChatInput | null = null
  // Track tool call statuses and ensure they are monotonic (pending -> in_progress -> completed).
  // Some pi events can arrive out of order (e.g. late toolcall_* deltas after execution starts),
  // and clients may hide progress if we ever downgrade back to `pending`.
  private currentToolCalls = new Map<string, 'pending' | 'in_progress'>()
  // Tool name per in-flight tool call, for events that omit it.
  private toolCallNames = new Map<string, string>()

  // ACP message identity for the current pi assistant message stream.
  private currentAssistantMessageId: string | null = null

  // pi can emit multiple `turn_end` and `agent_end` events for a single user prompt
  // when retry, compaction, or queued continuations run. The session-level prompt
  // completes only when `agent_settled` is emitted.
  private inAgentLoop = false

  // For ACP diff support: capture file contents before edit/write mutations,
  // then emit ToolCallContent {type:"diff"}. Compatible structured edit/write
  // events may need to be implemented in pi in the future.
  private fileSnapshots = new Map<string, { path: string; oldText: string | null }>()
  private fileMutationToolCallIds = new Set<string>()
  private bashToolCallIds = new Set<string>()
  private bashOutputSnapshots = new Map<string, string>()

  private title: string | null = null
  private isTitled = false
  private isTitling = false
  private lastUserMessage: string | null = null

  // Ensure `session/update` notifications are sent in order and can be awaited
  // before completing a `session/prompt` request.
  private lastEmit: Promise<void> = Promise.resolve()
  // Serialize the stats read as well as delivery so a slower, older refresh cannot
  // overwrite usage from a newer lifecycle event.
  private lastUsageRefresh: Promise<void> = Promise.resolve()

  constructor(opts: {
    sessionId: string
    cwd: string
    mcpServers: McpServer[]
    proc: PiRpcProcess
    conn: AgentSideConnection
    fileCommands?: FileSlashCommand[]
    clientUi?: ClientUiCapabilities
  }) {
    this.sessionId = opts.sessionId
    this.cwd = opts.cwd
    this.mcpServers = opts.mcpServers
    this.proc = opts.proc
    this.conn = opts.conn
    this.fileCommands = opts.fileCommands ?? []
    this.clientUi = opts.clientUi ?? { elicitationForm: false }

    this.proc.onEvent(ev => this.handlePiEvent(ev))
    this.bindFsBridge()
  }

  /** Register the slash commands pi extensions expose, so prompts like `/mcp status` end the turn correctly. */
  setExtensionCommands(names: Iterable<string>): void {
    this.extensionCommands = new Set(names)
  }

  /**
   * Route pi's file reads/writes through the ACP client (fs/read_text_file, fs/write_text_file).
   * Clients like Zed only track "edited files" for writes that go through these methods.
   */
  private bindFsBridge(): void {
    const bridge = this.proc.fsBridge
    if (!bridge) return

    bridge.setHandler({
      readTextFile: bridge.capabilities.readTextFile
        ? async path => (await this.conn.readTextFile({ sessionId: this.sessionId, path })).content
        : undefined,
      writeTextFile: async (path, content) => {
        await this.conn.writeTextFile({ sessionId: this.sessionId, path, content })
      }
    })
  }

  setStartupInfo(text: string) {
    this.startupInfo = text
    this.startupInfoSent = false
  }

  getTitle(): string | null {
    return this.title
  }

  getIsTitled(): boolean {
    return this.isTitled
  }

  getIsTitling(): boolean {
    return this.isTitling
  }

  setIsTitling(value: boolean): void {
    this.isTitling = value
  }

  setTitle(title: string): void {
    this.title = title
    this.isTitled = true
  }

  getLastUserMessage(): string | null {
    return this.lastUserMessage
  }

  /**
   * Best-effort attempt to send startup info outside of a prompt turn.
   * Some clients (e.g. Zed) may only render agent messages once the UI is ready;
   * callers can invoke this shortly after session/new returns.
   */
  sendStartupInfoIfPending(): void {
    if (this.startupInfoSent || !this.startupInfo) return
    this.startupInfoSent = true

    this.emitSyntheticAgentMessage({ type: 'text', text: this.startupInfo })
  }

  async prompt(message: string, images: unknown[] = []): Promise<StopReason> {
    // A pi extension asked for text input and we told the user to reply in chat:
    // this message is the answer, not a new prompt.
    if (this.pendingChatInput && images.length === 0) {
      await this.answerPendingChatInput(message)
      return 'end_turn'
    }

    this.lastUserMessage = message

    // pi RPC mode disables slash command expansion, so we do it here.
    const expandedMessage = expandSlashCommand(message, this.fileCommands)
    const isExtensionCommand = this.isExtensionCommand(message)

    const turnPromise = new Promise<StopReason>((resolve, reject) => {
      const queued: QueuedTurn = { message: expandedMessage, images, isExtensionCommand, resolve, reject }

      // If a turn is already running, enqueue.
      if (this.pendingTurn) {
        this.turnQueue.push(queued)

        // Best-effort: notify client that a prompt was queued.
        // This doesn't work in Zed yet, needs to be revisited
        this.emitSyntheticAgentMessage({
          type: 'text',
          text: `Queued message (position ${this.turnQueue.length}).`
        })

        // Also publish queue depth via session info metadata.
        // This also not visible in the client
        this.emit({
          sessionUpdate: 'session_info_update',
          _meta: { piAcp: { queueDepth: this.turnQueue.length, running: true } }
        })

        return
      }

      // No turn is running; start immediately.
      this.startTurn(queued)
    })

    return turnPromise
  }

  async cancel(): Promise<void> {
    // Cancel current and clear any queued prompts.
    this.cancelRequested = true

    await this.cancelPendingChatInput()

    if (this.turnQueue.length) {
      const queued = this.turnQueue.splice(0, this.turnQueue.length)
      for (const t of queued) t.resolve('cancelled')

      this.emitSyntheticAgentMessage({ type: 'text', text: 'Cleared queued prompts.' })
      this.emit({
        sessionUpdate: 'session_info_update',
        _meta: { piAcp: { queueDepth: 0, running: Boolean(this.pendingTurn) } }
      })
    }

    // Abort the currently running turn (if any). If nothing is running, this is a no-op.
    await this.proc.abort()
  }

  wasCancelRequested(): boolean {
    return this.cancelRequested
  }

  emitUsageUpdate(fallbackUsed?: number): Promise<void> {
    this.lastUsageRefresh = this.lastUsageRefresh.then(async () => {
      try {
        const stats = await this.proc.getSessionStats()
        const usage = sessionStatsToUsageUpdate(stats, fallbackUsed)
        if (!usage) return

        this.emit({ sessionUpdate: 'usage_update', ...usage })
        await this.flushEmits()
      } catch {
        // Usage is advisory and must not fail session lifecycle or prompt requests.
      }
    })

    return this.lastUsageRefresh
  }

  private emitSyntheticAgentMessage(
    content: ContentBlock,
    meta?: Record<string, unknown>,
    messageId = crypto.randomUUID()
  ): string {
    this.emit({
      sessionUpdate: 'agent_message_chunk',
      messageId,
      content,
      ...(meta ? { _meta: meta } : {})
    })
    return messageId
  }

  private emit(update: SessionUpdate): void {
    // Serialize update delivery.
    this.lastEmit = this.lastEmit
      .then(() =>
        this.conn.sessionUpdate({
          sessionId: this.sessionId,
          update
        })
      )
      .catch(() => {
        // Ignore notification errors (client may have gone away). We still want
        // prompt completion.
      })
  }

  private async flushEmits(): Promise<void> {
    await this.lastEmit
  }

  private emitBashToolCall(params: {
    sessionUpdate: 'tool_call' | 'tool_call_update'
    toolCallId: string
    toolName: string
    args: unknown
    status: 'pending' | 'in_progress'
    locations?: ToolCallLocation[]
    includeTerminal: boolean
  }): void {
    this.bashToolCallIds.add(params.toolCallId)
    this.emit({
      sessionUpdate: params.sessionUpdate,
      toolCallId: params.toolCallId,
      name: params.toolName,
      title: bashCommand(params.args) ?? params.toolName,
      kind: 'execute',
      status: params.status,
      locations: params.locations,
      ...(params.includeTerminal ? { content: bashTerminalContent(params.toolCallId) } : {}),
      ...(params.includeTerminal ? { _meta: bashTerminalInfoMeta(params.toolCallId, this.cwd) } : {})
    })
  }

  private emitBashOutputUpdate(params: {
    toolCallId: string
    status: 'in_progress' | 'completed' | 'failed'
    result: unknown
    isError?: boolean
  }): void {
    const text = bashResultText(params.result)
    const previous = this.bashOutputSnapshots.get(params.toolCallId) ?? ''
    const delta = bashOutputDelta(previous, text)
    this.bashOutputSnapshots.set(params.toolCallId, text)

    this.emit({
      sessionUpdate: 'tool_call_update',
      toolCallId: params.toolCallId,
      status: params.status,
      _meta: {
        ...(delta ? bashTerminalOutputMeta(params.toolCallId, delta) : {}),
        ...(params.status === 'completed' || params.status === 'failed'
          ? bashTerminalExitMeta(params.toolCallId, bashExitCode(params.result, Boolean(params.isError)))
          : {})
      }
    })
  }

  /** Mirror the rpiv-todo task list into the ACP plan view. */
  private emitPlanIfTodoResult(toolName: string, result: unknown): void {
    if (toolName !== TODO_TOOL_NAME) return

    const plan = todoResultToPlan(result)
    if (!plan) return

    this.emit({ sessionUpdate: 'plan', ...plan })
  }

  private cleanupToolCall(toolCallId: string): void {
    this.currentToolCalls.delete(toolCallId)
    this.toolCallNames.delete(toolCallId)
    this.fileSnapshots.delete(toolCallId)
    this.fileMutationToolCallIds.delete(toolCallId)
    this.bashToolCallIds.delete(toolCallId)
    this.bashOutputSnapshots.delete(toolCallId)
  }

  private isExtensionCommand(message: string): boolean {
    const name = parseExtensionCommandName(message)
    return name !== null && this.extensionCommands.has(name)
  }

  private startTurn(t: QueuedTurn): void {
    this.cancelRequested = false
    this.inAgentLoop = false
    this.agentRunObserved = false

    const turn: PendingTurn = { resolve: t.resolve, reject: t.reject }
    this.pendingTurn = turn

    // Publish queue depth (0 because we're starting the turn now).
    this.emit({
      sessionUpdate: 'session_info_update',
      _meta: { piAcp: { queueDepth: this.turnQueue.length, running: true } }
    })

    // Kick off pi, but completion is determined by pi events, not the RPC response.
    // The prompt RPC only acknowledges acceptance; retry, compaction, or queued
    // continuations may emit multiple `agent_end` events before `agent_settled`.
    this.proc.prompt(t.message, t.images).then(
      () => {
        if (!t.isExtensionCommand) return

        // Extension commands run inside the `prompt` RPC. Unless the handler started an
        // agent run, pi never emits `agent_settled`, so the turn ends with the response.
        setTimeout(() => {
          if (this.pendingTurn !== turn || this.agentRunObserved) return
          this.finishTurn(this.cancelRequested ? 'cancelled' : 'end_turn')
        }, EXTENSION_COMMAND_SETTLE_GRACE_MS)
      },
      err => {
        // If the subprocess errors before we get `agent_settled`, treat as error unless cancelled.
        // Also ensure we flush any already-enqueued updates first.
        void this.flushEmits().finally(() => {
          // If this looks like an auth/config issue, surface AUTH_REQUIRED so clients can offer terminal login.
          const authErr = maybeAuthRequiredError(err)
          if (authErr) {
            this.pendingTurn?.reject(authErr)
          } else {
            const reason: StopReason = this.cancelRequested ? 'cancelled' : 'error'
            this.pendingTurn?.resolve(reason)
          }

          this.pendingTurn = null
          this.inAgentLoop = false

          // If the prompt failed, do not automatically proceed—pi may be unhealthy.
          // But we still clear the queueDepth metadata.
          this.emit({
            sessionUpdate: 'session_info_update',
            _meta: { piAcp: { queueDepth: this.turnQueue.length, running: false } }
          })
        })
      }
    )
  }

  /**
   * Complete the current ACP turn after all pending updates are delivered,
   * then start the next queued prompt (if any).
   */
  private finishTurn(reason: StopReason): void {
    void this.flushEmits().finally(() => {
      this.pendingTurn?.resolve(reason)
      this.pendingTurn = null
      this.inAgentLoop = false

      const next = this.turnQueue.shift()
      if (next) {
        this.emitSyntheticAgentMessage({
          type: 'text',
          text: `Starting queued message. (${this.turnQueue.length} remaining)`
        })
        this.startTurn(next)
      } else {
        this.emit({
          sessionUpdate: 'session_info_update',
          _meta: { piAcp: { queueDepth: 0, running: false } }
        })
      }
    })
  }

  private handlePiEvent(ev: PiRpcEvent) {
    const type = String((ev as any).type ?? '')

    // Any model/tool activity proves pi started an agent run for this turn, even if
    // `agent_start` was missed (matters for extension-command turns). Custom messages
    // appended by extensions (pi.sendMessage) are emitted outside a run and don't count.
    if (
      type === 'agent_start' ||
      type === 'turn_start' ||
      type === 'message_update' ||
      (type === 'message_start' && (ev as any).message?.role !== 'custom')
    ) {
      this.agentRunObserved = true
    }

    switch (type) {
      case 'message_start': {
        const message = (ev as any).message
        if (message?.role === 'assistant') {
          this.currentAssistantMessageId = assistantMessageId(message)
        }
        break
      }

      case 'message_update': {
        const ame = (ev as any).assistantMessageEvent
        const messageId = this.currentAssistantMessageId ?? assistantMessageId(ame?.partial)
        this.currentAssistantMessageId = messageId

        // Stream assistant text.
        if (ame?.type === 'text_delta' && typeof ame.delta === 'string') {
          this.emit({
            sessionUpdate: 'agent_message_chunk',
            messageId,
            content: { type: 'text', text: ame.delta } satisfies ContentBlock
          })
          break
        }

        if (ame?.type === 'thinking_delta' && typeof ame.delta === 'string') {
          this.emit({
            sessionUpdate: 'agent_thought_chunk',
            messageId,
            content: { type: 'text', text: ame.delta } satisfies ContentBlock
          })
          break
        }

        // Surface tool calls ASAP so clients (e.g. Zed) can show a tool-in-use/loading UI
        // while the model is still streaming tool call args.
        if (ame?.type === 'toolcall_start' || ame?.type === 'toolcall_delta' || ame?.type === 'toolcall_end') {
          const toolCall =
            // pi sometimes includes the tool call directly on the event
            (ame as any)?.toolCall ??
            // ...and always includes it in the partial assistant message at contentIndex
            (ame as any)?.partial?.content?.[(ame as any)?.contentIndex ?? 0]

          const toolCallId = String((toolCall as any)?.id ?? '')
          const toolName = String((toolCall as any)?.name ?? 'tool')

          if (toolCallId) {
            this.toolCallNames.set(toolCallId, toolName)
            const rawInput =
              (toolCall as any)?.arguments && typeof (toolCall as any).arguments === 'object'
                ? (toolCall as any).arguments
                : (() => {
                    const s = String((toolCall as any)?.partialArgs ?? '')
                    if (!s) return undefined
                    try {
                      return JSON.parse(s)
                    } catch {
                      return { partialArgs: s }
                    }
                  })()

            const locations = toToolCallLocations(rawInput, this.cwd)
            const existingStatus = this.currentToolCalls.get(toolCallId)
            // IMPORTANT: never downgrade status (e.g. if we already marked in_progress via tool_execution_start).
            const status = existingStatus ?? 'pending'

            if (isBashTool(toolName)) {
              if (!existingStatus) this.currentToolCalls.set(toolCallId, 'pending')
              this.emitBashToolCall({
                sessionUpdate: existingStatus ? 'tool_call_update' : 'tool_call',
                toolCallId,
                toolName,
                args: rawInput,
                status,
                locations,
                includeTerminal: !existingStatus
              })
            } else if (!existingStatus) {
              this.currentToolCalls.set(toolCallId, 'pending')
              this.emit({
                sessionUpdate: 'tool_call',
                toolCallId,
                name: toolName,
                title: toToolTitle(toolName, rawInput),
                kind: toToolKind(toolName),
                status,
                locations,
                rawInput
              })
            } else {
              // Best-effort: keep rawInput (and the derived title) updated while args are streaming.
              // Keep the existing status (pending or in_progress).
              this.emit({
                sessionUpdate: 'tool_call_update',
                toolCallId,
                title: toToolTitle(toolName, rawInput),
                status,
                locations,
                rawInput
              })
            }
          }

          break
        }

        // Ignore other delta/event types for now.
        break
      }

      case 'tool_execution_start': {
        const toolCallId = String((ev as any).toolCallId ?? crypto.randomUUID())
        const toolName = String((ev as any).toolName ?? 'tool')
        const args = (ev as any).args
        let line: number | undefined

        this.toolCallNames.set(toolCallId, toolName)

        if (isBashTool(toolName)) {
          const locations = toToolCallLocations(args, this.cwd)
          const existingStatus = this.currentToolCalls.get(toolCallId)
          this.currentToolCalls.set(toolCallId, 'in_progress')
          this.emitBashToolCall({
            sessionUpdate: existingStatus ? 'tool_call_update' : 'tool_call',
            toolCallId,
            toolName,
            args,
            status: 'in_progress',
            locations,
            includeTerminal: !existingStatus
          })
          break
        }

        // Capture pre-mutation file contents so we can emit a structured ACP diff.
        const isFileMutation = toolName === 'edit' || toolName === 'write'
        let snapshotOldText: string | null | undefined
        if (isFileMutation) {
          this.fileMutationToolCallIds.add(toolCallId)
          const p = getToolPath(args)
          if (p) {
            try {
              const abs = isAbsolute(p) ? p : resolvePath(this.cwd, p)
              snapshotOldText = readFileSync(abs, 'utf8')
              this.fileSnapshots.set(toolCallId, { path: p, oldText: snapshotOldText })

              if (toolName === 'edit') {
                for (const needle of getEditOldTexts(args)) {
                  line = findUniqueLineNumber(snapshotOldText, needle)
                  if (typeof line === 'number') break
                }
              }
            } catch {
              snapshotOldText = null
              this.fileSnapshots.set(toolCallId, { path: p, oldText: null })
            }
          }
        }

        const locations = toToolCallLocations(args, this.cwd, line)

        // If we already surfaced the tool call while the model streamed it, just transition.
        if (!this.currentToolCalls.has(toolCallId)) {
          this.currentToolCalls.set(toolCallId, 'in_progress')
          this.emit({
            sessionUpdate: 'tool_call',
            toolCallId,
            name: toolName,
            title: toToolTitle(toolName, args),
            kind: toToolKind(toolName),
            status: 'in_progress',
            locations,
            rawInput: args
          })
        } else {
          this.currentToolCalls.set(toolCallId, 'in_progress')
          this.emit({
            sessionUpdate: 'tool_call_update',
            toolCallId,
            title: toToolTitle(toolName, args),
            status: 'in_progress',
            locations,
            rawInput: args
          })
        }

        break
      }

      case 'tool_execution_update': {
        const toolCallId = String((ev as any).toolCallId ?? '')
        if (!toolCallId) break

        const partial = (ev as any).partialResult
        if (this.bashToolCallIds.has(toolCallId)) {
          this.emitBashOutputUpdate({ toolCallId, status: 'in_progress', result: partial })
          break
        }

        const content = this.fileMutationToolCallIds.has(toolCallId) ? [] : toolResultToContent(partial)

        this.emit({
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: 'in_progress',
          content: content.length > 0 ? content : undefined,
          ...(this.fileMutationToolCallIds.has(toolCallId) ? {} : { rawOutput: toolResultToRawOutput(partial) })
        })
        break
      }

      case 'tool_execution_end': {
        const toolCallId = String((ev as any).toolCallId ?? '')
        if (!toolCallId) break

        const result = (ev as any).result
        const isError = Boolean((ev as any).isError)
        if (this.bashToolCallIds.has(toolCallId)) {
          this.emitBashOutputUpdate({
            toolCallId,
            status: isError ? 'failed' : 'completed',
            result,
            isError
          })
          this.cleanupToolCall(toolCallId)
          break
        }

        const snapshot = this.fileSnapshots.get(toolCallId)
        let content: ToolCallContent[] | undefined
        let hasStructuredDiff = false

        if (!isError && snapshot) {
          try {
            const abs = isAbsolute(snapshot.path) ? snapshot.path : resolvePath(this.cwd, snapshot.path)
            const newText = readFileSync(abs, 'utf8')
            if (snapshot.oldText === null || newText !== snapshot.oldText) {
              hasStructuredDiff = true
              content = [
                {
                  type: 'diff',
                  path: abs,
                  oldText: snapshot.oldText,
                  newText
                }
              ]
            }
          } catch {
            // ignore; fall back to text only
          }
        }

        if (!content && !hasStructuredDiff) {
          const translatedContent = toolResultToContent(result)
          if (translatedContent.length > 0) content = translatedContent
        }

        this.emit({
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: isError ? 'failed' : 'completed',
          content,
          ...(hasStructuredDiff ? {} : { rawOutput: toolResultToRawOutput(result) })
        })

        const toolName = String((ev as any).toolName ?? this.toolCallNames.get(toolCallId) ?? '')
        this.emitPlanIfTodoResult(toolName, result)
        this.cleanupToolCall(toolCallId)
        break
      }

      case 'extension_ui_request': {
        void this.handleExtensionUiRequest(ev).catch(() => {
          const id = stringProp(ev, 'id')
          if (!id) {
            return
          }

          void this.proc.sendExtensionUiResponse({ id, cancelled: true }).catch(() => {})
        })
        break
      }

      case 'auto_retry_start': {
        this.emitSyntheticAgentMessage({ type: 'text', text: formatAutoRetryMessage(ev) })
        break
      }

      case 'auto_retry_end': {
        this.emitSyntheticAgentMessage({ type: 'text', text: 'Retry finished, resuming.' })
        break
      }

      case 'auto_compaction_start': {
        this.emitSyntheticAgentMessage({
          type: 'text',
          text: 'Context nearing limit, running automatic compaction...'
        })
        break
      }

      case 'auto_compaction_end': {
        this.emitSyntheticAgentMessage({
          type: 'text',
          text: 'Automatic compaction finished; context was summarized to continue the session.'
        })
        const estimatedTokensAfter = Number((ev as any).result?.estimatedTokensAfter)
        void this.emitUsageUpdate(Number.isFinite(estimatedTokensAfter) ? estimatedTokensAfter : undefined)
        break
      }

      case 'agent_start': {
        this.inAgentLoop = true
        break
      }

      case 'turn_end': {
        // pi uses `turn_end` for sub-steps (e.g. tool_use) and will often start another turn.
        // Do NOT resolve the ACP `session/prompt` here; wait for `agent_settled`.
        break
      }

      case 'agent_end': {
        // One low-level run ended. Pi may still retry, compact, or process a queued
        // continuation, so keep the ACP turn open until `agent_settled`.
        this.inAgentLoop = false
        break
      }

      case 'agent_settled': {
        // Include final context/cost state before resolving the ACP prompt turn.
        void this.emitUsageUpdate().finally(() => {
          this.finishTurn(this.cancelRequested ? 'cancelled' : 'end_turn')
        })
        break
      }

      case 'message_end': {
        const message = (ev as any).message
        if (message?.role === 'assistant') {
          this.currentAssistantMessageId = null
          break
        }

        // Extensions (e.g. pi-subagents run notices) inject `custom` messages via pi.sendMessage().
        if (message?.role !== 'custom' || message?.display === false) break

        const text = customMessageText(message.content)
        if (!text) break

        this.emitSyntheticAgentMessage(
          { type: 'text', text },
          { piAcp: { customMessage: { customType: String(message.customType ?? '') } } }
        )
        break
      }

      case 'extension_error': {
        const extensionPath = String((ev as any).extensionPath ?? 'extension')
        const error = String((ev as any).error ?? 'unknown error')
        this.emitSyntheticAgentMessage(
          { type: 'text', text: `Pi extension error (${extensionPath}): ${error}` },
          { piAcp: { notify: { level: 'error' } } }
        )
        break
      }

      default:
        break
    }
  }

  private async handleExtensionUiRequest(ev: PiRpcEvent): Promise<void> {
    const id = stringProp(ev, 'id')
    const method = stringProp(ev, 'method')
    if (!id) {
      return
    }

    if (method === 'select') {
      await this.handleExtensionSelect(ev, id)
      return
    }

    if (method === 'confirm') {
      await this.handleExtensionConfirm(ev, id)
      return
    }

    if (method === 'input' || method === 'editor') {
      await this.handleExtensionTextInput(ev, id, method)
      return
    }

    if (method === 'notify') {
      this.emitSyntheticAgentMessage(
        { type: 'text', text: stringProp(ev, 'message') ?? 'Pi notification' },
        { piAcp: { notify: { level: stringProp(ev, 'notifyType') ?? 'info' } } }
      )
      return
    }

    if (method === 'setTitle') {
      const title = stringProp(ev, 'title')
      if (title) {
        this.setTitle(title)
        this.emit({
          sessionUpdate: 'session_info_update',
          title,
          updatedAt: new Date().toISOString()
        })
      }
      return
    }

    if (method === 'setStatus') {
      // Footer status entries (e.g. pi-goal "goal: turn 2/10", pi-mcp-adapter server state).
      // ACP has no status bar; publish via metadata so capable clients can render it.
      const statusKey = stringProp(ev, 'statusKey') ?? 'status'
      const statusText = stringProp(ev, 'statusText')
      this.emit({
        sessionUpdate: 'session_info_update',
        _meta: { piAcp: { status: { key: statusKey, text: statusText } } }
      })
      return
    }

    if (method && FIRE_AND_FORGET_UI_METHODS.has(method)) {
      // setWidget / set_editor_text: terminal-only affordances with no ACP equivalent.
      return
    }

    await this.proc.sendExtensionUiResponse({ id, cancelled: true })
  }

  /**
   * Pi `input`/`editor` dialogs: prefer ACP elicitation (structured form) when the client
   * supports it; otherwise ask the user to answer with their next chat message.
   */
  private async handleExtensionTextInput(ev: PiRpcEvent, id: string, method: TextInputMethod): Promise<void> {
    if (this.clientUi.elicitationForm) {
      await this.elicitTextInput(ev, id, method)
      return
    }

    await this.requestChatInput(ev, id, method)
  }

  private async elicitTextInput(ev: PiRpcEvent, id: string, method: TextInputMethod): Promise<void> {
    let response: Awaited<ReturnType<AgentSideConnection['createElicitation']>>
    try {
      response = await this.conn.createElicitation({
        ...buildTextElicitation(ev, method),
        sessionId: this.sessionId
      })
    } catch {
      // Client rejected elicitation; fall back to the chat reply flow.
      await this.requestChatInput(ev, id, method)
      return
    }

    const value = response.action === 'accept' ? elicitationTextValue(response.content) : null
    await this.proc.sendExtensionUiResponse(value === null ? { id, cancelled: true } : { id, value })
  }

  private async requestChatInput(ev: PiRpcEvent, id: string, method: TextInputMethod): Promise<void> {
    // Only one text input can be outstanding; a newer request supersedes the older one.
    // Swap synchronously so back-to-back requests cannot both claim the slot.
    const superseded = this.pendingChatInput
    this.pendingChatInput = { id, method }
    if (superseded) await this.proc.sendExtensionUiResponse({ id: superseded.id, cancelled: true }).catch(() => {})

    this.emitSyntheticAgentMessage(
      { type: 'text', text: formatChatInputPrompt(ev, method) },
      { piAcp: { inputRequest: { id, method } } }
    )
  }

  private async answerPendingChatInput(value: string): Promise<void> {
    const pending = this.pendingChatInput
    if (!pending) return
    this.pendingChatInput = null

    // The client already renders the user's message; just hand the value to pi.
    await this.proc.sendExtensionUiResponse({ id: pending.id, value })
  }

  private async cancelPendingChatInput(): Promise<void> {
    const pending = this.pendingChatInput
    if (!pending) return
    this.pendingChatInput = null
    await this.proc.sendExtensionUiResponse({ id: pending.id, cancelled: true }).catch(() => {})
  }

  private async handleExtensionSelect(ev: PiRpcEvent, id: string): Promise<void> {
    const rawOptions = ev.options
    const options = Array.isArray(rawOptions) ? rawOptions.map(option => String(option)) : []
    if (!options.length) {
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return
    }

    if (this.clientUi.elicitationForm) {
      await this.elicitSelect(ev, id, options)
      return
    }

    await this.requestSelectPermission(ev, id, options)
  }

  /** Form elicitation renders each choice as a wrapping row with its full description. */
  private async elicitSelect(ev: PiRpcEvent, id: string, options: string[]): Promise<void> {
    let response: Awaited<ReturnType<AgentSideConnection['createElicitation']>>
    try {
      response = await this.conn.createElicitation({
        ...buildSelectElicitation(ev, options),
        sessionId: this.sessionId
      })
    } catch {
      // Client rejected elicitation; fall back to permission buttons.
      await this.requestSelectPermission(ev, id, options)
      return
    }

    const value = response.action === 'accept' ? elicitationSelectedOption(response.content, options) : null
    await this.proc.sendExtensionUiResponse(value === null ? { id, cancelled: true } : { id, value })
  }

  /** Permission buttons cannot wrap, so they carry short labels and the prompt lists full options. */
  private async requestSelectPermission(ev: PiRpcEvent, id: string, options: string[]): Promise<void> {
    const permissionOptions: PermissionOption[] = options.map((option, index) => ({
      optionId: `${CHOICE_OPTION_PREFIX}${index}`,
      name: selectOptionLabel(option),
      kind: 'allow_once'
    }))

    const selected = await this.requestExtensionPermission(id, ev, permissionOptions)
    if (selected === null) {
      return
    }

    const selectedOptionId = selected.outcome.outcome === 'selected' ? selected.outcome.optionId : null
    const index = selectedOptionId === null ? null : optionIndex(selectedOptionId)
    const value = index === null ? null : (options.at(index) ?? null)
    await this.proc.sendExtensionUiResponse(value === null ? { id, cancelled: true } : { id, value })
  }

  private async handleExtensionConfirm(ev: PiRpcEvent, id: string): Promise<void> {
    const selected = await this.requestExtensionPermission(id, ev, CONFIRM_PERMISSION_OPTIONS)
    if (selected === null) {
      return
    }

    if (selected.outcome.outcome === 'cancelled') {
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return
    }

    await this.proc.sendExtensionUiResponse({ id, confirmed: selected.outcome.optionId === 'yes' })
  }

  private async requestExtensionPermission(
    id: string,
    ev: PiRpcEvent,
    options: PermissionOption[]
  ): Promise<PermissionResponse | null> {
    try {
      return await this.conn.requestPermission({
        sessionId: this.sessionId,
        toolCall: extensionUiToolCall(id, ev),
        options
      })
    } catch {
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return null
    }
  }
}

function extensionUiToolCall(id: string, ev: PiRpcEvent) {
  const method = stringProp(ev, 'method') ?? 'ui'
  const prompt = extensionUiPrompt(ev)
  const rawInput: Record<string, unknown> = { method }

  for (const key of EXTENSION_UI_RAW_INPUT_KEYS) {
    if (Object.hasOwn(ev, key)) rawInput[key] = ev[key]
  }

  return {
    toolCallId: `pi-ui-${id}`,
    title: extensionUiToolTitle(method),
    name: method,
    kind: 'other' as const,
    status: 'pending' as const,
    content: prompt
      ? ([{ type: 'content', content: { type: 'text', text: prompt } }] satisfies ToolCallContent[])
      : undefined,
    rawInput
  }
}

function extensionUiToolTitle(method: string): string {
  if (method === 'select') return 'Choose an option'
  if (method === 'confirm') return 'Confirm'
  return `Pi ${method}`
}

function extensionUiPrompt(ev: PiRpcEvent): string {
  const prompt = uiRequestPrompt(ev)
  if (stringProp(ev, 'method') !== 'select' || !Array.isArray(ev.options)) return prompt

  return formatSelectPrompt(
    prompt,
    ev.options.map(option => String(option))
  )
}

function stringProp(source: Record<string, unknown>, key: string): string | null {
  const value = source[key]
  return typeof value === 'string' ? value : null
}

function optionIndex(optionId: string): number | null {
  if (!optionId.startsWith(CHOICE_OPTION_PREFIX)) {
    return null
  }

  const rawIndex = optionId.slice(CHOICE_OPTION_PREFIX.length)
  if (!rawIndex) {
    return null
  }

  const index = Number(rawIndex)
  return Number.isSafeInteger(index) && index >= 0 && String(index) === rawIndex ? index : null
}

function formatAutoRetryMessage(ev: PiRpcEvent): string {
  const attempt = Number((ev as any).attempt)
  const maxAttempts = Number((ev as any).maxAttempts)
  const delayMs = Number((ev as any).delayMs)

  if (!Number.isFinite(attempt) || !Number.isFinite(maxAttempts) || !Number.isFinite(delayMs)) {
    return 'Retrying...'
  }

  let delaySeconds = Math.round(delayMs / 1000)
  if (delayMs > 0 && delaySeconds === 0) delaySeconds = 1

  return `Retrying (attempt ${attempt}/${maxAttempts}, waiting ${delaySeconds}s)...`
}

/** Text of a pi `custom` message (string or text content blocks). */
function customMessageText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''

  return content
    .map(block => (block?.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join('')
    .trim()
}
