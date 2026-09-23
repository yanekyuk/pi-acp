import {
  PROTOCOL_VERSION,
  RequestError,
  type Agent as ACPAgent,
  type AgentSideConnection,
  type AuthenticateRequest,
  type CancelNotification,
  type InitializeRequest,
  type InitializeResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type NewSessionRequest,
  type PromptRequest,
  type PromptResponse,
  type SessionConfigOption,
  type SessionInfo,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
  type StopReason,
  type DeleteSessionRequest,
  type DeleteSessionResponse,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type CloseSessionRequest,
  type CloseSessionResponse,
  type ContentBlock,
  type McpServer
} from '@agentclientprotocol/sdk'
import { getAuthMethods } from './auth.js'
import { SessionManager, type ClientUiCapabilities, type PiAcpSession } from './session.js'
import { SessionStore } from './session-store.js'
import { PiRpcProcess } from '../pi-rpc/process.js'
import type { FsBridgeCapabilities } from '../pi-rpc/fs-bridge.js'
import { listPiSessions, findPiSession, readPiSessionTitle } from './pi-sessions.js'
import { normalizePiAssistantText, normalizePiMessageText } from './translate/pi-messages.js'
import { toolResultToContent, toolResultToRawOutput } from './translate/pi-tools.js'
import { toToolKind, toToolTitle } from './translate/extension-tools.js'
import {
  bashCommand,
  bashExitCode,
  bashResultText,
  bashTerminalContent,
  bashTerminalExitMeta,
  bashTerminalInfoMeta,
  bashTerminalOutputMeta,
  isBashTool
} from './translate/bash.js'
import { promptToPiMessage } from './translate/prompt.js'
import { loadSlashCommands, parseCommandArgs, toAvailableCommands } from './slash-commands.js'
import { getAgentDir, getAutoTitle, getEnableSkillCommands, getQuietStartup } from './pi-settings.js'
import { toAvailableCommandsFromPiGetCommands } from './pi-commands.js'
import { maybeAuthRequiredError } from './auth-required.js'
import { deriveInitialTitle, generateTitle, type TitleConversationMessage } from './title.js'
import { isAbsolute } from 'node:path'
import { existsSync, readFileSync, realpathSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import type { AvailableCommand } from '@agentclientprotocol/sdk'
import { join, dirname, basename } from 'node:path'
import { spawnSync } from 'node:child_process'

type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
type AdvertisedModel = {
  modelId: string
  name: string
  description?: string | null
}

type PiAcpAgentOptions = {
  titleGenerator?: typeof generateTitle
}

type SessionRestoreCancellation = {
  cancelled: boolean
}

type SessionRestore = {
  promise: Promise<PiAcpSession>
  cancellation: SessionRestoreCancellation
}

function asToolArguments(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function historicalToolCallArguments(message: unknown): Map<string, Record<string, unknown>> {
  const argumentsByToolCallId = new Map<string, Record<string, unknown>>()
  const record = message as { role?: unknown; content?: unknown }
  if (record.role !== 'assistant' || !Array.isArray(record.content)) return argumentsByToolCallId

  for (const value of record.content) {
    const block = value as { type?: unknown; id?: unknown; arguments?: unknown }
    const args = asToolArguments(block.arguments)
    if (block.type !== 'toolCall' || typeof block.id !== 'string' || !block.id.trim() || !args) continue
    argumentsByToolCallId.set(block.id, args)
  }

  return argumentsByToolCallId
}

const MODEL_CONFIG_ID = 'model'
const THOUGHT_LEVEL_CONFIG_ID = 'thought_level'

function builtinAvailableCommands(): AvailableCommand[] {
  return [
    {
      name: 'compact',
      description: 'Manually compact the session context',
      input: { hint: 'optional custom instructions' }
    },
    {
      name: 'autocompact',
      description: 'Toggle automatic context compaction',
      input: { hint: 'on|off|toggle' }
    },
    {
      name: 'export',
      description: 'Export session to an HTML file in the session cwd'
    },
    {
      name: 'session',
      description: 'Show session stats (messages, tokens, cost, session file)'
    },
    {
      name: 'name',
      description: 'Set session display name',
      input: { hint: '<name>' }
    },
    {
      name: 'title',
      description: 'Set or regenerate session title',
      input: { hint: 'regenerate | <name>' }
    },
    {
      name: 'regenerate-title',
      description: 'Regenerate session title using AI'
    },
    {
      name: 'steering',
      description: 'Get/set pi steering message delivery mode (how queued steering messages are delivered)',
      input: { hint: '(no args to show) all | one-at-a-time' }
    },
    {
      name: 'follow-up',
      description: 'Get/set pi follow-up message delivery mode (how queued follow-up messages are delivered)',
      input: { hint: '(no args to show) all | one-at-a-time' }
    },
    {
      name: 'changelog',
      description: 'Show pi changelog'
    }
  ]
}

function mergeCommands(a: AvailableCommand[], b: AvailableCommand[]): AvailableCommand[] {
  // Preserve order, de-dupe by name (first wins).
  const out: AvailableCommand[] = []
  const seen = new Set<string>()

  for (const c of [...a, ...b]) {
    if (seen.has(c.name)) continue
    seen.add(c.name)
    out.push(c)
  }

  return out
}
import { fileURLToPath } from 'node:url'

const pkg = readNearestPackageJson(import.meta.url)

export class PiAcpAgent implements ACPAgent {
  private readonly conn: AgentSideConnection
  private readonly titleGenerator: typeof generateTitle
  private readonly sessions = new SessionManager()
  private readonly store = new SessionStore()
  private readonly restoringSessions = new Map<string, SessionRestore>()
  private disposed = false

  dispose(): void {
    this.disposed = true
    for (const restore of this.restoringSessions.values()) restore.cancellation.cancelled = true
    this.sessions.disposeAll()
  }

  // Client `fs` capabilities from initialize. Drives FS bridge setup for every pi subprocess.
  private clientFs: FsBridgeCapabilities = { readTextFile: false, writeTextFile: false }

  // Client UI capabilities from initialize. Drives how pi extension dialogs are rendered.
  private clientUi: ClientUiCapabilities = { elicitationForm: false }

  constructor(conn: AgentSideConnection, options: PiAcpAgentOptions = {}) {
    this.conn = conn
    this.titleGenerator = options.titleGenerator ?? generateTitle
  }

  private cleanupFailedNewSession(sessionId: string, state?: any | null): void {
    this.sessions.close(sessionId)

    const sessionFile =
      typeof state?.sessionFile === 'string' && state.sessionFile.trim()
        ? state.sessionFile
        : this.store.get(sessionId)?.sessionFile

    if (typeof sessionFile === 'string' && sessionFile.trim()) {
      try {
        if (existsSync(sessionFile)) unlinkSync(sessionFile)
      } catch {
        // ignore cleanup failures; the auth/internal error is the primary result
      }
    }

    this.store.delete(sessionId)
  }

  private findStoredSession(sessionId: string): { cwd: string; sessionFile: string; title: string | null } | null {
    const stored = this.store.get(sessionId)
    if (stored?.cwd && stored?.sessionFile) {
      return {
        cwd: stored.cwd,
        sessionFile: stored.sessionFile,
        title: readPiSessionTitle(stored.sessionFile)
      }
    }

    const piSession = findPiSession(sessionId)
    if (!piSession) return null

    this.store.upsert({
      sessionId,
      cwd: piSession.cwd,
      sessionFile: piSession.sessionFile
    })

    return {
      cwd: piSession.cwd,
      sessionFile: piSession.sessionFile,
      title: piSession.title
    }
  }

  private async restoreSession(
    sessionId: string,
    opts?: { cwd?: string; mcpServers?: McpServer[] }
  ): Promise<PiAcpSession> {
    if (this.disposed) {
      throw RequestError.invalidParams(`Agent is disposed; cannot restore session: ${sessionId}`)
    }

    const existing = this.sessions.maybeGet(sessionId)
    if (existing) return existing

    const inFlight = this.restoringSessions.get(sessionId)
    if (inFlight) return inFlight.promise

    const cancellation: SessionRestoreCancellation = { cancelled: false }
    const restore: SessionRestore = {
      promise: this.spawnRestoredSession(sessionId, opts, cancellation),
      cancellation
    }
    this.restoringSessions.set(sessionId, restore)

    try {
      return await restore.promise
    } finally {
      if (this.restoringSessions.get(sessionId) === restore) {
        this.restoringSessions.delete(sessionId)
      }
    }
  }

  private async spawnRestoredSession(
    sessionId: string,
    opts: { cwd?: string; mcpServers?: McpServer[] } | undefined,
    cancellation: SessionRestoreCancellation
  ): Promise<PiAcpSession> {
    const stored = this.findStoredSession(sessionId)
    if (!stored) {
      throw RequestError.invalidParams(`Unknown sessionId: ${sessionId}`)
    }

    const cwd = opts?.cwd ?? stored.cwd

    let proc: PiRpcProcess
    try {
      proc = await PiRpcProcess.spawn({
        cwd,
        sessionPath: stored.sessionFile,
        piCommand: process.env.PI_ACP_PI_COMMAND,
        clientFs: this.clientFs
      })
    } catch (e: any) {
      if (e?.name === 'PiRpcSpawnError') {
        throw RequestError.internalError({ code: e?.code }, String(e?.message ?? e))
      }
      throw e
    }

    if (cancellation.cancelled || this.disposed) {
      proc.dispose()
      throw RequestError.requestCancelled({ sessionId }, `Session restore was cancelled: ${sessionId}`)
    }

    const fileCommands = loadSlashCommands(cwd)
    const session = this.sessions.getOrCreate(sessionId, {
      cwd,
      mcpServers: opts?.mcpServers ?? [],
      conn: this.conn,
      proc,
      fileCommands,
      clientUi: this.clientUi
    })

    if (stored.title) session.setTitle(stored.title)

    this.store.upsert({ sessionId, cwd, sessionFile: stored.sessionFile })

    return session
  }

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    const requested = params.protocolVersion

    this.clientFs = {
      readTextFile: params.clientCapabilities?.fs?.readTextFile === true,
      writeTextFile: params.clientCapabilities?.fs?.writeTextFile === true
    }

    this.clientUi = {
      elicitationForm: Boolean(params.clientCapabilities?.elicitation?.form)
    }

    return {
      protocolVersion: requested === PROTOCOL_VERSION ? requested : PROTOCOL_VERSION,
      agentInfo: {
        name: pkg.name ?? 'pi-acp',
        title: 'pi ACP adapter',
        version: pkg.version ?? '0.0.0'
      },
      // Zed currently uses ClientCapabilities._meta["terminal-auth"] to decide whether to show
      // the "Authenticate" banner/button. If not supported, we still return the method for the registry.
      authMethods: getAuthMethods({
        supportsTerminalAuthMeta: (params as any)?.clientCapabilities?._meta?.['terminal-auth'] === true
      }),
      agentCapabilities: {
        loadSession: true,
        mcpCapabilities: { http: false, sse: false },
        promptCapabilities: {
          image: true,
          audio: false,
          embeddedContext: process.env.PI_ACP_ENABLE_EMBEDDED_CONTEXT !== 'false'
        },
        sessionCapabilities: {
          list: {},
          delete: {},
          resume: {},
          close: {}
        }
      }
    }
  }

  async newSession(params: NewSessionRequest) {
    if (!isAbsolute(params.cwd)) {
      throw RequestError.invalidParams(`cwd must be an absolute path: ${params.cwd}`)
    }

    const fileCommands = loadSlashCommands(params.cwd)
    const enableSkillCommands = getEnableSkillCommands(params.cwd)

    // Pi doesn't support mcpServers, but we accept and store.
    const session = await this.sessions.create({
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      conn: this.conn,
      fileCommands,
      piCommand: process.env.PI_ACP_PI_COMMAND,
      clientFs: this.clientFs,
      clientUi: this.clientUi
    })

    // Fetch state + models once (parallel) to reduce startup latency.
    let state: any = null
    let availableModels: any = null
    let stateErr: unknown = null
    let availableModelsErr: unknown = null

    await Promise.all([
      session.proc
        .getState()
        .then(s => {
          state = s as any
        })
        .catch(err => {
          stateErr = err
          state = null
        }),
      session.proc
        .getAvailableModels()
        .then(m => {
          availableModels = m as any
        })
        .catch(err => {
          availableModelsErr = err
          availableModels = null
        })
    ])

    const availableModelsAuthErr = maybeAuthRequiredError(availableModelsErr)

    if (availableModelsAuthErr) {
      this.cleanupFailedNewSession(session.sessionId, state)
      throw availableModelsAuthErr
    }

    if (availableModelsErr) {
      this.cleanupFailedNewSession(session.sessionId, state)
      throw RequestError.internalError({}, String((availableModelsErr as Error)?.message ?? availableModelsErr))
    }

    // If pi has no models available after spawning, it's effectively unauthenticated.
    const rawModelsCount = Array.isArray(availableModels?.models) ? availableModels.models.length : 0

    if (rawModelsCount === 0) {
      this.cleanupFailedNewSession(session.sessionId, state)
      throw RequestError.authRequired(
        { authMethods: getAuthMethods() },
        'Configure an API key or log in with an OAuth provider.'
      )
    }

    if (stateErr && maybeAuthRequiredError(stateErr)) {
      this.cleanupFailedNewSession(session.sessionId, state)
      throw RequestError.authRequired(
        { authMethods: getAuthMethods() },
        'Configure an API key or log in with an OAuth provider.'
      )
    }

    const { configOptions, modes } = await getSessionConfiguration(session.proc, {
      state,
      availableModels
    })

    const quietStartup = getQuietStartup(params.cwd)
    const updateNotice = buildUpdateNotice()

    // If quietStartup is enabled, suppress the full "startup info" prelude, but still surface
    // the "New version available" notice (if any) since it's high-signal and actionable.
    const preludeText = quietStartup
      ? updateNotice
        ? updateNotice + '\n'
        : ''
      : buildStartupInfo({
          cwd: params.cwd,
          fileCommands,
          updateNotice
        })

    if (preludeText) session.setStartupInfo(preludeText)

    const response = {
      sessionId: session.sessionId,
      configOptions,
      modes,
      _meta: {
        piAcp: {
          startupInfo: preludeText || null
        }
      }
    }

    // Try to send it immediately after session/new returns; if the client ignores it,
    // it will still be emitted as the first chunk of the first prompt.
    if (preludeText) setTimeout(() => session.sendStartupInfoIfPending(), 0)

    // Some clients ignore notifications for an unknown sessionId, so publish
    // session-scoped state only after the session/new response is delivered.
    setTimeout(() => {
      void this.advertiseAvailableCommands(session, { enableSkillCommands, fileCommands })
      void session.emitUsageUpdate?.()
    }, 0)

    return response
  }

  /**
   * Publish the session's slash commands: pi extension commands, prompt templates, skills,
   * plus the adapter's built-in commands. Falls back to file-based prompt templates when
   * pi's `get_commands` is unavailable.
   */
  private async advertiseAvailableCommands(
    session: PiAcpSession,
    opts: { enableSkillCommands: boolean; fileCommands: ReturnType<typeof loadSlashCommands> }
  ): Promise<void> {
    let commands: AvailableCommand[]
    try {
      const pi = (await session.proc.getCommands()) as any
      const translated = toAvailableCommandsFromPiGetCommands(pi, {
        enableSkillCommands: opts.enableSkillCommands,
        includeExtensionCommands: true
      })
      commands = translated.commands
      session.setExtensionCommands?.(translated.extensionCommandNames)
    } catch {
      commands = toAvailableCommands(opts.fileCommands)
    }

    await this.conn.sessionUpdate({
      sessionId: session.sessionId,
      update: {
        sessionUpdate: 'available_commands_update',
        availableCommands: mergeCommands(commands, builtinAvailableCommands())
      }
    })
  }

  private async sendSyntheticAgentMessage(
    sessionId: string,
    content: ContentBlock,
    messageId: string = crypto.randomUUID()
  ): Promise<string> {
    await this.conn.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId,
        content
      }
    })
    return messageId
  }

  async authenticate(_params: AuthenticateRequest) {
    // Terminal Auth is handled out-of-band by re-launching the binary with `--terminal-login`.
    // If the client calls `authenticate` anyway, we can no-op successfully.
    return
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = await this.restoreSession(params.sessionId)

    const { message, images } = promptToPiMessage(params.prompt)

    // Built-in ACP slash command handling (headless-friendly subset).
    // Note: file-based slash commands are expanded inside session.prompt().
    if (images.length === 0 && message.trimStart().startsWith('/')) {
      const trimmed = message.trim()
      const space = trimmed.indexOf(' ')
      const cmd = space === -1 ? trimmed.slice(1) : trimmed.slice(1, space)
      const argsString = space === -1 ? '' : trimmed.slice(space + 1)
      const args = parseCommandArgs(argsString)

      if (cmd === 'compact') {
        const customInstructions = args.join(' ').trim() || undefined
        const res = await session.proc.compact(customInstructions)

        const r: any = res && typeof res === 'object' ? (res as any) : null
        const tokensBefore = typeof r?.tokensBefore === 'number' ? r.tokensBefore : null
        const summary = typeof r?.summary === 'string' ? r.summary : null

        const headerLines = [
          `Compaction completed.${customInstructions ? ' (custom instructions applied)' : ''}`,
          tokensBefore !== null ? `Tokens before: ${tokensBefore}` : null
        ].filter(Boolean)

        const text = headerLines.join('\n') + (summary ? `\n\n${summary}` : '')

        await this.sendSyntheticAgentMessage(session.sessionId, { type: 'text', text })
        await session.emitUsageUpdate?.(
          typeof r?.estimatedTokensAfter === 'number' ? r.estimatedTokensAfter : undefined
        )

        return { stopReason: 'end_turn' }
      }

      if (cmd === 'session') {
        const stats = (await session.proc.getSessionStats()) as any

        const lines: string[] = []
        if (stats?.sessionId) lines.push(`Session: ${stats.sessionId}`)
        if (stats?.sessionFile) lines.push(`Session file: ${stats.sessionFile}`)
        if (typeof stats?.totalMessages === 'number') lines.push(`Messages: ${stats.totalMessages}`)

        if (typeof stats?.cost === 'number') lines.push(`Cost: ${stats.cost}`)

        const t = stats?.tokens
        if (t && typeof t === 'object') {
          const parts: string[] = []
          if (typeof t.input === 'number') parts.push(`in ${t.input}`)
          if (typeof t.output === 'number') parts.push(`out ${t.output}`)
          if (typeof t.cacheRead === 'number') parts.push(`cache read ${t.cacheRead}`)
          if (typeof t.cacheWrite === 'number') parts.push(`cache write ${t.cacheWrite}`)
          if (typeof t.total === 'number') parts.push(`total ${t.total}`)
          if (parts.length) lines.push(`Tokens: ${parts.join(', ')}`)
        }

        // Fallback if stats shape changes.
        const text = lines.length ? lines.join('\n') : `Session stats:\n${JSON.stringify(stats, null, 2)}`

        await this.sendSyntheticAgentMessage(session.sessionId, { type: 'text', text })

        return { stopReason: 'end_turn' }
      }

      if (cmd === 'name' || cmd === 'title' || cmd === 'regenerate-title') {
        if (
          cmd === 'regenerate-title' ||
          (cmd === 'title' && (args.length === 0 || args[0]?.toLowerCase() === 'regenerate'))
        ) {
          await this.regenerateSessionTitle(session, { notifyInChat: true })
          return { stopReason: 'end_turn' }
        }

        const name = args.join(' ').trim()
        if (!name) {
          await this.sendSyntheticAgentMessage(session.sessionId, {
            type: 'text',
            text: 'Usage: /name <name> (or /title regenerate to generate automatically)'
          })
          return { stopReason: 'end_turn' }
        }

        try {
          await session.proc.setSessionName(name)
        } catch (e: any) {
          const msg = String(e?.message ?? e)
          const hint = /set_session_name/i.test(msg)
            ? ' This requires a newer pi version that supports `set_session_name` in RPC mode.'
            : ''

          await this.sendSyntheticAgentMessage(session.sessionId, {
            type: 'text',
            text: `Failed to set session name: ${msg}${hint}`
          })
          return { stopReason: 'end_turn' }
        }

        session.setTitle?.(name)

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'session_info_update',
            title: name,
            updatedAt: new Date().toISOString()
          }
        })

        await this.sendSyntheticAgentMessage(session.sessionId, {
          type: 'text',
          text: `Session name set: ${name}`
        })

        return { stopReason: 'end_turn' }
      }

      if (cmd === 'steering') {
        const modeRaw = String(args[0] ?? '').toLowerCase()
        const state = (await session.proc.getState()) as any
        const current = String(state?.steeringMode ?? '')

        // If no arg, just report current.
        if (!modeRaw) {
          await this.sendSyntheticAgentMessage(session.sessionId, {
            type: 'text',
            text: `Steering mode: ${current || 'unknown'}`
          })
          return { stopReason: 'end_turn' }
        }

        if (modeRaw !== 'all' && modeRaw !== 'one-at-a-time') {
          await this.sendSyntheticAgentMessage(session.sessionId, {
            type: 'text',
            text: 'Usage: /steering all | /steering one-at-a-time'
          })
          return { stopReason: 'end_turn' }
        }

        await session.proc.setSteeringMode(modeRaw as 'all' | 'one-at-a-time')

        await this.sendSyntheticAgentMessage(session.sessionId, {
          type: 'text',
          text: `Steering mode set to: ${modeRaw}`
        })

        return { stopReason: 'end_turn' }
      }

      if (cmd === 'follow-up') {
        const modeRaw = String(args[0] ?? '').toLowerCase()
        const state = (await session.proc.getState()) as any
        const current = String(state?.followUpMode ?? '')

        // If no arg, just report current.
        if (!modeRaw) {
          await this.sendSyntheticAgentMessage(session.sessionId, {
            type: 'text',
            text: `Follow-up mode: ${current || 'unknown'}`
          })
          return { stopReason: 'end_turn' }
        }

        if (modeRaw !== 'all' && modeRaw !== 'one-at-a-time') {
          await this.sendSyntheticAgentMessage(session.sessionId, {
            type: 'text',
            text: 'Usage: /follow-up all | /follow-up one-at-a-time'
          })
          return { stopReason: 'end_turn' }
        }

        await session.proc.setFollowUpMode(modeRaw as 'all' | 'one-at-a-time')

        await this.sendSyntheticAgentMessage(session.sessionId, {
          type: 'text',
          text: `Follow-up mode set to: ${modeRaw}`
        })

        return { stopReason: 'end_turn' }
      }

      if (cmd === 'changelog') {
        // Read pi's installed CHANGELOG.md. Adapter-side, no model call.
        const findChangelog = (): string | null => {
          // 1) Locate the installed pi package by resolving the `pi` executable.
          // On Node installs, `pi` typically resolves to .../@earendil-works/pi-coding-agent/dist/cli.js
          try {
            const whichCmd = process.platform === 'win32' ? 'where' : 'which'
            const which = spawnSync(whichCmd, ['pi'], { encoding: 'utf-8' })
            const piPath = String(which.stdout ?? '')
              .split(/\r?\n/)[0]
              ?.trim()

            if (piPath) {
              const resolved = realpathSync(piPath)
              const pkgRoot = dirname(dirname(resolved))
              const p = join(pkgRoot, 'CHANGELOG.md')
              if (existsSync(p)) return p
            }
          } catch {
            // ignore
          }

          // 2) Fallback: ask npm where global modules live.
          try {
            const npmRoot = spawnSync('npm', ['root', '-g'], { encoding: 'utf-8' })
            const root = String(npmRoot.stdout ?? '').trim()
            if (root) {
              const p = join(root, '@earendil-works', 'pi-coding-agent', 'CHANGELOG.md')
              if (existsSync(p)) return p
            }
          } catch {
            // ignore
          }

          return null
        }

        const changelogPath = findChangelog()
        if (!changelogPath) {
          await this.sendSyntheticAgentMessage(session.sessionId, {
            type: 'text',
            text: "Changelog not found (couldn't locate pi installation)."
          })
          return { stopReason: 'end_turn' }
        }

        let text = ''
        try {
          text = readFileSync(changelogPath, 'utf-8')
        } catch (e: any) {
          await this.sendSyntheticAgentMessage(session.sessionId, {
            type: 'text',
            text: `Failed to read changelog: ${String(e?.message ?? e)}`
          })
          return { stopReason: 'end_turn' }
        }

        // Keep it reasonably sized in chat.
        const maxChars = 20_000
        if (text.length > maxChars) text = text.slice(0, maxChars) + '\n\n...(truncated)...'

        await this.sendSyntheticAgentMessage(session.sessionId, { type: 'text', text })

        return { stopReason: 'end_turn' }
      }

      if (cmd === 'export') {
        // For now we always export into the session cwd and do not accept a user-provided path.
        // IMPORTANT: pi's export_html reads the session JSONL file. If it doesn't exist yet
        // (no messages) or is empty, pi throws and RPC mode emits an uncorrelated parse error
        // (no id), which would otherwise hang our request. So we guard here.
        const state = (await session.proc.getState()) as any
        const sessionFile = typeof state?.sessionFile === 'string' ? state.sessionFile : null
        const messageCount = typeof state?.messageCount === 'number' ? state.messageCount : 0

        if (!sessionFile || messageCount === 0 || !existsSync(sessionFile)) {
          await this.sendSyntheticAgentMessage(session.sessionId, {
            type: 'text',
            text: 'Nothing to export yet (no session messages). Send a prompt first.'
          })
          return { stopReason: 'end_turn' }
        }

        try {
          const raw = readFileSync(sessionFile, 'utf-8')
          if (raw.trim().length === 0) {
            await this.sendSyntheticAgentMessage(session.sessionId, {
              type: 'text',
              text: 'Nothing to export yet (empty session file). Send a prompt first.'
            })
            return { stopReason: 'end_turn' }
          }
        } catch {
          await this.sendSyntheticAgentMessage(session.sessionId, {
            type: 'text',
            text: "Couldn't read session file for export. Try sending a prompt first."
          })
          return { stopReason: 'end_turn' }
        }

        const safeSessionId = session.sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
        const outputPath = join(session.cwd, `pi-session-${safeSessionId}.html`)

        let resultPath = ''
        try {
          const result = await session.proc.exportHtml(outputPath)
          resultPath = result.path
        } catch (e: any) {
          await this.sendSyntheticAgentMessage(session.sessionId, {
            type: 'text',
            text: `Export failed: ${String(e?.message ?? e)}`
          })
          return { stopReason: 'end_turn' }
        }

        if (!resultPath) {
          await this.sendSyntheticAgentMessage(session.sessionId, {
            type: 'text',
            text: 'Export failed: no output path returned by pi.'
          })
          return { stopReason: 'end_turn' }
        }

        const uri = `file://${resultPath}`

        // Emit a short prefix + a resource link as chunks of one assistant message.
        const messageId = await this.sendSyntheticAgentMessage(session.sessionId, {
          type: 'text',
          text: 'Session exported: '
        })

        await this.sendSyntheticAgentMessage(
          session.sessionId,
          {
            type: 'resource_link',
            name: `pi-session-${safeSessionId}.html`,
            uri,
            mimeType: 'text/html',
            title: 'Session exported'
          },
          messageId
        )

        return { stopReason: 'end_turn' }
      }

      if (cmd === 'autocompact') {
        const mode = (args[0] ?? 'toggle').toLowerCase()
        let enabled: boolean | null = null
        if (mode === 'on' || mode === 'true' || mode === 'enable' || mode === 'enabled') enabled = true
        else if (mode === 'off' || mode === 'false' || mode === 'disable' || mode === 'disabled') enabled = false

        if (enabled === null) {
          // toggle: read current state and invert.
          const state = (await session.proc.getState()) as any
          const current = Boolean(state?.autoCompactionEnabled)
          enabled = !current
        }

        await session.proc.setAutoCompaction(enabled)

        await this.sendSyntheticAgentMessage(session.sessionId, {
          type: 'text',
          text: `Auto-compaction ${enabled ? 'enabled' : 'disabled'}.`
        })

        return { stopReason: 'end_turn' }
      }
    }

    const result = await session.prompt(message, images)

    if (
      !session.getIsTitled?.() &&
      !session.getIsTitling?.() &&
      getAutoTitle(session.cwd ?? '') &&
      !images.length &&
      message.trim() &&
      !message.trimStart().startsWith('/')
    ) {
      void this.setInitialSessionTitle(session, message).catch(() => {})
    }

    // ACP StopReason does not include "error"; if pi fails we map to end_turn for now,
    // unless we know this was a cancellation.
    const stopReason: StopReason =
      result === 'error' ? (session.wasCancelRequested() ? 'cancelled' : 'end_turn') : result

    return { stopReason }
  }

  async cancel(params: CancelNotification): Promise<void> {
    const session = this.sessions.maybeGet(params.sessionId)
    if (!session) return
    await session.cancel()
  }

  async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    const all = listPiSessions()
    const filtered = typeof params.cwd === 'string' ? all.filter(session => session.cwd === params.cwd) : all

    let start = 0
    if (params.cursor != null) {
      if (!/^(0|[1-9]\d*)$/.test(params.cursor)) {
        throw RequestError.invalidParams(`Invalid session list cursor: ${params.cursor}`)
      }

      start = Number(params.cursor)
      if (!Number.isSafeInteger(start)) {
        throw RequestError.invalidParams(`Invalid session list cursor: ${params.cursor}`)
      }
    }

    const PAGE_SIZE = 50
    const page = filtered.slice(start, start + PAGE_SIZE)

    const sessions: SessionInfo[] = page.map(s => ({
      sessionId: s.sessionId,
      cwd: s.cwd,
      title: s.title,
      updatedAt: s.updatedAt
    }))

    const nextCursor = start + PAGE_SIZE < filtered.length ? String(start + PAGE_SIZE) : null

    return { sessions, nextCursor, _meta: {} }
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    if (!isAbsolute(params.cwd)) {
      throw RequestError.invalidParams(`cwd must be an absolute path: ${params.cwd}`)
    }

    // If the client is re-loading a session that is already active, tear down the existing
    // pi subprocess so we can start fresh and re-advertise commands reliably.
    // (Some clients may call session/load when restoring from history.)
    this.sessions.close(params.sessionId)

    const stored = this.findStoredSession(params.sessionId)
    if (!stored) {
      throw RequestError.invalidParams(`Unknown sessionId: ${params.sessionId}`)
    }

    const enableSkillCommands = getEnableSkillCommands(params.cwd)
    const session = await this.restoreSession(params.sessionId, {
      cwd: params.cwd,
      mcpServers: params.mcpServers
    })
    const proc = session.proc
    const fileCommands = loadSlashCommands(params.cwd)

    // (Optional) ensure mapping stays fresh.
    this.store.upsert({
      sessionId: params.sessionId,
      cwd: params.cwd,
      sessionFile: stored.sessionFile
    })

    const existingTitle = session.getTitle()
    if (existingTitle) {
      await this.conn.sessionUpdate({
        sessionId: session.sessionId,
        update: {
          sessionUpdate: 'session_info_update',
          title: existingTitle,
          updatedAt: new Date().toISOString()
        }
      })
    }

    // Replay full conversation history.
    const data = (await proc.getMessages()) as any
    const messages = Array.isArray(data?.messages) ? data.messages : []
    const toolCallArguments = new Map<string, Record<string, unknown>>()

    for (const [messageIndex, m] of messages.entries()) {
      const role = String(m?.role ?? '')
      const messageId = replayMessageId(params.sessionId, messageIndex, m)

      for (const [toolCallId, args] of historicalToolCallArguments(m)) {
        toolCallArguments.set(toolCallId, args)
      }

      if (role === 'user') {
        const text = normalizePiMessageText(m?.content)
        if (text) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'user_message_chunk',
              messageId,
              content: { type: 'text', text }
            }
          })
        }
      }

      if (role === 'assistant') {
        const text = normalizePiAssistantText(m?.content)
        if (text) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              messageId,
              content: { type: 'text', text }
            }
          })
        }
      }

      if (role === 'toolResult') {
        const toolName = String((m as any)?.toolName ?? 'tool')
        const toolCallId = String((m as any)?.toolCallId ?? crypto.randomUUID())
        const isError = Boolean((m as any)?.isError)
        const isBash = isBashTool(toolName)
        const restoredArgs = toolCallArguments.get(toolCallId) ?? asToolArguments((m as any)?.args)

        if (isBash) {
          const text = bashResultText(m)
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId,
              name: toolName,
              title: bashCommand(restoredArgs) ?? bashCommand(m) ?? toolName,
              kind: 'execute',
              status: 'completed',
              content: bashTerminalContent(toolCallId),
              _meta: bashTerminalInfoMeta(toolCallId, params.cwd)
            }
          })

          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId,
              status: isError ? 'failed' : 'completed',
              _meta: {
                ...(text ? bashTerminalOutputMeta(toolCallId, text) : {}),
                ...bashTerminalExitMeta(toolCallId, bashExitCode(m, isError))
              }
            }
          })
          continue
        }

        const rawOutput = toolResultToRawOutput(m)

        // Create a synthetic ACP tool call to render historic tool usage.
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId,
            name: toolName,
            title: toToolTitle(toolName, restoredArgs),
            kind: toToolKind(toolName),
            status: 'completed',
            rawInput: restoredArgs ?? null,
            rawOutput
          }
        })

        const content = toolResultToContent(m)
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId,
            status: isError ? 'failed' : 'completed',
            content: content.length > 0 ? content : null,
            rawOutput
          }
        })
      }
    }

    const { configOptions, modes } = await getSessionConfiguration(proc)

    const response = {
      configOptions,
      modes,
      _meta: {
        piAcp: {
          startupInfo: null
        }
      }
    }

    // Publish session-scoped state after the response so the client knows the session exists.
    setTimeout(() => {
      void this.advertiseAvailableCommands(session, { enableSkillCommands, fileCommands })
      void session.emitUsageUpdate?.()
    }, 0)

    return response
  }

  async deleteSession(params: DeleteSessionRequest): Promise<DeleteSessionResponse> {
    const wasActive = await this.closeActiveSession(params.sessionId)
    const stored = this.store.get(params.sessionId)
    const piSession = findPiSession(params.sessionId)

    if (!wasActive && !stored && !piSession) {
      return {}
    }

    const sessionFile = stored?.sessionFile ?? piSession?.sessionFile

    if (sessionFile) {
      try {
        if (existsSync(sessionFile)) unlinkSync(sessionFile)
      } catch {
        // best-effort cleanup
      }
    }

    this.store.delete(params.sessionId)

    return {}
  }

  async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    if (!isAbsolute(params.cwd)) {
      throw RequestError.invalidParams(`cwd must be an absolute path: ${params.cwd}`)
    }

    const stored = this.findStoredSession(params.sessionId)
    if (!stored) {
      throw RequestError.invalidParams(`Unknown sessionId: ${params.sessionId}`)
    }
    if (stored.cwd !== params.cwd) {
      throw RequestError.invalidParams(`cwd does not match session ${params.sessionId}: ${params.cwd}`)
    }

    const fileCommands = loadSlashCommands(params.cwd)
    const enableSkillCommands = getEnableSkillCommands(params.cwd)
    const session = await this.restoreSession(params.sessionId, {
      cwd: params.cwd,
      mcpServers: params.mcpServers
    })
    const { configOptions, modes } = await getSessionConfiguration(session.proc)

    setTimeout(() => {
      void this.advertiseAvailableCommands(session, { enableSkillCommands, fileCommands })
      void session.emitUsageUpdate?.()
    }, 0)

    return { configOptions, modes }
  }

  async closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
    await this.closeActiveSession(params.sessionId)
    return {}
  }

  private async closeActiveSession(sessionId: string): Promise<boolean> {
    const restore = this.restoringSessions.get(sessionId)
    if (restore) {
      restore.cancellation.cancelled = true
      await restore.promise.catch(() => {})
    }

    const session = this.sessions.maybeGet(sessionId)
    if (!session) return Boolean(restore)

    try {
      await session.cancel()
    } catch {
      // Process teardown below is still required if abort fails.
    }

    this.sessions.close(sessionId)
    return true
  }

  async unstable_setSessionModel(params: { sessionId: string; modelId: string }): Promise<void> {
    const session = await this.restoreSession(params.sessionId)
    await setSessionModel(session.proc, params.modelId)
    await emitConfigOptionsUpdate(this.conn, session.sessionId, session.proc)
    await session.emitUsageUpdate?.()
  }

  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    const session = await this.restoreSession(params.sessionId)

    const mode = String(params.modeId)
    if (!isThinkingLevel(mode)) {
      throw RequestError.invalidParams(`Unknown modeId: ${mode}`)
    }

    await session.proc.setThinkingLevel(mode)

    // Let the client know the current mode changed (keeps the dropdown in sync).
    void this.conn.sessionUpdate({
      sessionId: session.sessionId,
      update: {
        sessionUpdate: 'current_mode_update',
        currentModeId: mode
      }
    })

    await emitConfigOptionsUpdate(this.conn, session.sessionId, session.proc)

    return {}
  }

  async setSessionConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
    const session = await this.restoreSession(params.sessionId)
    const configId = String(params.configId)

    if (typeof params.value !== 'string') {
      throw RequestError.invalidParams(`Expected string value for config option: ${configId}`)
    }

    if (configId === MODEL_CONFIG_ID) {
      await setSessionModel(session.proc, params.value)
    } else if (configId === THOUGHT_LEVEL_CONFIG_ID) {
      if (!isThinkingLevel(params.value)) {
        throw RequestError.invalidParams(`Unknown thinking level: ${params.value}`)
      }

      await session.proc.setThinkingLevel(params.value)
    } else {
      throw RequestError.invalidParams(`Unknown config option: ${configId}`)
    }

    const configOptions = await emitConfigOptionsUpdate(this.conn, session.sessionId, session.proc)
    if (configId === MODEL_CONFIG_ID) await session.emitUsageUpdate?.()
    return { configOptions }
  }

  async extMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (
      method === 'session/regenerateTitle' ||
      method === 'regenerateTitle' ||
      method === 'regenerate_title' ||
      method === 'title/regenerate'
    ) {
      const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : undefined
      if (!sessionId) {
        throw RequestError.invalidParams('sessionId is required')
      }
      const session = await this.restoreSession(sessionId)
      const title = await this.regenerateSessionTitle(session)
      return { success: true, title }
    }
    throw RequestError.methodNotFound(method)
  }

  async extNotification(_method: string, _params: Record<string, unknown>): Promise<void> {
    return
  }

  private async setInitialSessionTitle(session: PiAcpSession, userMessage: string): Promise<string> {
    session.setIsTitling?.(true)
    try {
      const title = deriveInitialTitle(userMessage)
      await this.applySessionTitle(session, title)
      return title
    } finally {
      session.setIsTitling?.(false)
    }
  }

  private async regenerateSessionTitle(session: PiAcpSession, opts?: { notifyInChat?: boolean }): Promise<string> {
    session.setIsTitling?.(true)
    try {
      const conversation = await this.getTitleConversation(session)
      const userMessage =
        conversation.find(message => message.role === 'user')?.text ?? session.getLastUserMessage?.() ?? ''

      let model: string | undefined
      try {
        const state = (await session.proc.getState()) as any
        const m = state?.model
        if (m && typeof m === 'object') {
          const provider = typeof m.provider === 'string' ? m.provider : ''
          const id = typeof m.id === 'string' ? m.id : typeof m.modelId === 'string' ? m.modelId : ''
          if (provider && id) model = `${provider}/${id}`
          else if (id) model = id
        }
      } catch {
        // Title generation can use the default model when session state is unavailable.
      }

      const title = await this.titleGenerator({
        userMessage,
        conversation,
        cwd: session.cwd,
        model,
        piCommand: process.env.PI_ACP_PI_COMMAND
      })

      await this.applySessionTitle(session, title, opts?.notifyInChat)
      return title
    } finally {
      session.setIsTitling?.(false)
    }
  }

  private async getTitleConversation(session: PiAcpSession): Promise<TitleConversationMessage[]> {
    try {
      const data = (await session.proc.getMessages()) as { messages?: unknown }
      if (!Array.isArray(data.messages)) return []

      const conversation: TitleConversationMessage[] = []
      for (const message of data.messages) {
        const record = message as { role?: unknown; content?: unknown }
        if (record.role !== 'user' && record.role !== 'assistant') continue

        const text = normalizePiMessageText(record.content).trim()
        if (text) conversation.push({ role: record.role, text })
      }
      return conversation
    } catch {
      return []
    }
  }

  private async applySessionTitle(session: PiAcpSession, title: string, notifyInChat = false): Promise<void> {
    session.setTitle?.(title)

    try {
      await session.proc.setSessionName(title)
    } catch {
      // Older pi versions do not support setSessionName in RPC mode.
    }

    await this.conn.sessionUpdate({
      sessionId: session.sessionId,
      update: {
        sessionUpdate: 'session_info_update',
        title,
        updatedAt: new Date().toISOString()
      }
    })

    if (notifyInChat) {
      await this.sendSyntheticAgentMessage(session.sessionId, {
        type: 'text',
        text: `Session title set: ${title}`
      })
    }
  }
}

function replayMessageId(sessionId: string, messageIndex: number, message: unknown): string {
  const record = message as { id?: unknown; messageId?: unknown; responseId?: unknown }
  for (const candidate of [record?.id, record?.messageId, record?.responseId]) {
    if (typeof candidate === 'string' && candidate) return candidate
  }

  return `${sessionId}:history:${messageIndex}`
}

function isThinkingLevel(x: string): x is ThinkingLevel {
  return x === 'off' || x === 'minimal' || x === 'low' || x === 'medium' || x === 'high' || x === 'xhigh'
}

async function getThinkingState(
  proc: PiRpcProcess,
  pre?: { state?: any | null }
): Promise<{
  availableModes: Array<{
    id: string
    name: string
    description?: string | null
  }>
  currentModeId: string
}> {
  // Ask pi for current thinking level.
  let current: ThinkingLevel = 'medium'

  const state =
    pre?.state ??
    (await (async () => {
      try {
        return (await proc.getState()) as any
      } catch {
        return null
      }
    })())

  const tl = typeof state?.thinkingLevel === 'string' ? state.thinkingLevel : null
  if (tl && isThinkingLevel(tl)) current = tl

  const available: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']

  const names: Record<ThinkingLevel, string> = {
    off: 'Off',
    minimal: 'Minimal',
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    xhigh: 'Extra High'
  }

  return {
    currentModeId: current,
    availableModes: available.map(id => ({
      id,
      name: names[id],
      description: null
    }))
  }
}

async function getSessionConfiguration(
  proc: PiRpcProcess,
  pre?: { state?: any | null; availableModels?: any | null }
): Promise<{
  configOptions: SessionConfigOption[]
  modes: {
    availableModes: Array<{
      id: string
      name: string
      description?: string | null
    }>
    currentModeId: string
  }
}> {
  const [models, modes] = await Promise.all([getModelState(proc, pre), getThinkingState(proc, { state: pre?.state })])

  return {
    configOptions: buildConfigOptions({ models, modes }),
    modes
  }
}

function buildConfigOptions(state: {
  models: {
    availableModels: AdvertisedModel[]
    currentModelId: string
  } | null
  modes: {
    availableModes: Array<{
      id: string
      name: string
      description?: string | null
    }>
    currentModeId: string
  }
}): SessionConfigOption[] {
  const configOptions: SessionConfigOption[] = [
    {
      type: 'select',
      id: THOUGHT_LEVEL_CONFIG_ID,
      category: 'thought_level',
      name: 'Thinking',
      description: 'Set the reasoning effort for this session',
      currentValue: state.modes.currentModeId,
      options: state.modes.availableModes.map(mode => ({
        value: mode.id,
        name: mode.name,
        description: mode.description ?? null
      }))
    }
  ]

  if (state.models?.availableModels.length) {
    configOptions.push({
      type: 'select',
      id: MODEL_CONFIG_ID,
      category: 'model',
      name: 'Model',
      description: 'Select the model for this session',
      currentValue: state.models.currentModelId,
      options: state.models.availableModels.map(model => ({
        value: model.modelId,
        name: model.name,
        description: model.description ?? null
      }))
    })
  }

  return configOptions
}

async function getModelState(
  proc: PiRpcProcess,
  pre?: { state?: any | null; availableModels?: any | null }
): Promise<{
  availableModels: AdvertisedModel[]
  currentModelId: string
} | null> {
  // Ask pi for available models.
  let availableModels: AdvertisedModel[] = []

  const data =
    pre?.availableModels ??
    (await (async () => {
      try {
        return (await proc.getAvailableModels()) as any
      } catch {
        return null
      }
    })())

  const models: any[] = Array.isArray(data?.models) ? data.models : []
  availableModels = models
    .map(m => {
      const provider = String(m?.provider ?? '').trim()
      const id = String(m?.id ?? '').trim()
      if (!provider || !id) return null

      const name = String(m?.name ?? id)
      return {
        modelId: `${provider}/${id}`,
        name: `${provider}/${name}`,
        description: null
      } satisfies AdvertisedModel
    })
    .filter(Boolean) as AdvertisedModel[]

  // Ask pi what model is currently active.
  let currentModelId: string | null = null

  const state =
    pre?.state ??
    (await (async () => {
      try {
        return (await proc.getState()) as any
      } catch {
        return null
      }
    })())

  const model = state?.model
  if (model && typeof model === 'object') {
    const provider = String((model as any).provider ?? '').trim()
    const id = String((model as any).id ?? '').trim()
    if (provider && id) currentModelId = `${provider}/${id}`
  }

  if (!availableModels.length && !currentModelId) return null

  // Fallback if current model is unknown: use first in list.
  if (!currentModelId) currentModelId = availableModels[0]?.modelId ?? 'default'

  return {
    availableModels,
    currentModelId: currentModelId ?? availableModels[0]?.modelId ?? 'default'
  }
}

async function emitConfigOptionsUpdate(
  conn: AgentSideConnection,
  sessionId: string,
  proc: PiRpcProcess
): Promise<SessionConfigOption[]> {
  const { configOptions } = await getSessionConfiguration(proc)

  await conn.sessionUpdate({
    sessionId,
    update: {
      sessionUpdate: 'config_option_update',
      configOptions
    }
  })

  return configOptions
}

async function setSessionModel(proc: PiRpcProcess, requestedModelId: string): Promise<void> {
  // Accept either:
  //  - "provider/model" (preferred, matches how we advertise)
  //  - "model" (fallback, resolve via available models)
  let provider: string | null = null
  let modelId: string | null = null

  if (requestedModelId.includes('/')) {
    const [candidateProvider, ...rest] = requestedModelId.split('/')
    provider = candidateProvider
    modelId = rest.join('/')
  } else {
    modelId = requestedModelId
  }

  if (!provider) {
    const data = (await proc.getAvailableModels()) as any
    const models: any[] = Array.isArray(data?.models) ? data.models : []
    const found = models.find(m => String(m?.id) === modelId)
    if (found) {
      provider = String(found.provider)
      modelId = String(found.id)
    }
  }

  if (!provider || !modelId) {
    throw RequestError.invalidParams(`Unknown modelId: ${requestedModelId}`)
  }

  await proc.setModel(provider, modelId)
}

function isSemver(v: string): boolean {
  return /^\d+\.\d+\.\d+(?:[-+].+)?$/.test(v)
}

function compareSemver(a: string, b: string): number {
  // Very small comparator for x.y.z (ignores pre-release/build beyond making them "not greater" unless base differs)
  const pa = a
    .split(/[.-]/)
    .slice(0, 3)
    .map(n => Number(n))
  const pb = b
    .split(/[.-]/)
    .slice(0, 3)
    .map(n => Number(n))
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0
    const db = pb[i] ?? 0
    if (da > db) return 1
    if (da < db) return -1
  }
  return 0
}

function buildUpdateNotice(): string | null {
  // Best-effort update check against npm registry.
  // Important: keep it fast to not slow down session/new.
  try {
    const piVersion = spawnSync('pi', ['--version'], { encoding: 'utf-8' })
    const installed = (String(piVersion.stdout ?? '').trim() || String(piVersion.stderr ?? '').trim()).replace(
      /^v/i,
      ''
    )

    if (!installed || !isSemver(installed)) return null

    const latestRes = spawnSync('npm', ['view', '@earendil-works/pi-coding-agent', 'version'], {
      encoding: 'utf-8',
      timeout: 800
    })
    const latest = String(latestRes.stdout ?? '')
      .trim()
      .replace(/^v/i, '')

    if (!latest || !isSemver(latest)) return null
    if (compareSemver(latest, installed) <= 0) return null

    return `New version available: v${latest} (installed v${installed}). Run: \`npm i -g @earendil-works/pi-coding-agent\``
  } catch {
    return null
  }
}

function buildStartupInfo(opts: {
  cwd: string
  fileCommands: ReturnType<typeof loadSlashCommands>
  updateNotice: string | null
}): string {
  void opts.fileCommands

  const md: string[] = []

  // pi version header
  try {
    const piVersion = spawnSync('pi', ['--version'], { encoding: 'utf-8' })
    const installed = (String(piVersion.stdout ?? '').trim() || String(piVersion.stderr ?? '').trim()).replace(
      /^v/i,
      ''
    )
    if (installed) {
      md.push(`pi v${installed}`)
      md.push('---')
      md.push('')
    }
  } catch {
    // ignore
  }

  const addSection = (title: string, items: string[]) => {
    const cleaned = items.map(s => s.trim()).filter(Boolean)
    if (!cleaned.length) return

    md.push(`## ${title}`)
    for (const item of cleaned) md.push(`- ${item}`)
    md.push('')
  }

  // Context
  const contextItems: string[] = []
  const contextPath = join(opts.cwd, 'AGENTS.md')
  if (existsSync(contextPath)) contextItems.push(contextPath)
  addSection('Context', contextItems)

  // Skills
  const skillsItems: string[] = []

  const pushSkillFromRoot = (root: string) => {
    try {
      // Direct .md files in root
      for (const e of readdirSync(root)) {
        const p = join(root, e)
        try {
          const st = statSync(p)
          if (st.isFile() && e.toLowerCase().endsWith('.md')) {
            skillsItems.push(p)
          }
        } catch {
          // ignore
        }
      }

      // Recursive SKILL.md under subdirectories
      const stack: string[] = [root]
      while (stack.length) {
        const dir = stack.pop()!
        let entries: string[] = []
        try {
          entries = readdirSync(dir)
        } catch {
          continue
        }

        for (const name of entries) {
          // Skip obvious noise
          if (name === 'node_modules' || name === '.git') continue
          const p = join(dir, name)
          let st
          try {
            st = statSync(p)
          } catch {
            continue
          }
          if (st.isDirectory()) {
            stack.push(p)
          } else if (st.isFile() && name === 'SKILL.md') {
            skillsItems.push(p)
          }
        }
      }
    } catch {
      // ignore
    }
  }

  // Global skills
  // Use getAgentDir() so this respects PI_CODING_AGENT_DIR overrides.
  const globalSkillsDir = join(getAgentDir(), 'skills')
  pushSkillFromRoot(globalSkillsDir)

  // Also support ~/.agents/skills (pi skill discovery)
  const legacyAgentsSkillsDir = join(process.env.HOME ?? '', '.agents', 'skills')
  pushSkillFromRoot(legacyAgentsSkillsDir)

  // Project skills (.pi/skills)
  const projectSkillsDir = join(opts.cwd, '.pi', 'skills')
  pushSkillFromRoot(projectSkillsDir)

  addSection('Skills', skillsItems)

  // Prompts
  const promptsItems: string[] = []
  const promptsDir = join(process.env.HOME ?? '', '.pi', 'agent', 'prompts')
  try {
    const prompts = readdirSync(promptsDir).filter(f => f.endsWith('.md'))
    for (const f of prompts) promptsItems.push(`/${basename(f, '.md')}`)
  } catch {
    // ignore
  }
  addSection('Prompts', promptsItems)

  // Extensions
  const extItems: string[] = []
  const extDir = join(process.env.HOME ?? '', '.pi', 'agent', 'extensions')
  try {
    const exts = readdirSync(extDir).filter(f => f.endsWith('.ts') || f.endsWith('.js'))
    for (const f of exts) extItems.push(join(extDir, f))
  } catch {
    // ignore
  }

  // Also show npm packages from pi settings (global + project)
  const settingsPaths = [join(getAgentDir(), 'settings.json'), join(opts.cwd, '.pi', 'settings.json')]
  for (const settingsPath of settingsPaths) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as any
      const pkgs: string[] = Array.isArray(settings?.packages) ? settings.packages : []
      for (const pkg of pkgs) {
        const s = String(pkg)
        if (s.startsWith('npm:')) {
          extItems.push(`${s}\n  - index.ts`)
        } else {
          extItems.push(s)
        }
      }
    } catch {
      // ignore
    }
  }

  addSection('Extensions', extItems)

  if (opts.updateNotice) {
    md.push('---')
    md.push(opts.updateNotice)
    md.push('')
  }

  // Do NOT include themes (per request).
  return md.join('\n').trim() + '\n'
}

function readNearestPackageJson(metaUrl: string): {
  name?: string
  version?: string
} {
  try {
    let dir = dirname(fileURLToPath(metaUrl))

    // Walk upwards a few levels to find the nearest package.json
    for (let i = 0; i < 6; i++) {
      const p = join(dir, 'package.json')
      if (existsSync(p)) {
        const json = JSON.parse(readFileSync(p, 'utf-8')) as any
        return { name: json?.name, version: json?.version }
      }
      dir = dirname(dir)
    }
  } catch {
    // ignore
  }
  return { name: 'pi-acp', version: '0.0.0' }
}
