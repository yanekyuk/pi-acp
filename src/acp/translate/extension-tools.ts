import type { ToolKind } from '@agentclientprotocol/sdk'

/**
 * Presentation mapping for pi tools (built-in and well-known extension tools) to ACP.
 *
 * Known extension tools:
 *   - pi-mcp-adapter:              mcp, mcpScript
 *   - @juicesharp/rpiv-advisor:    advisor
 *   - @juicesharp/rpiv-ask-user-question: ask_user_question
 *   - @juicesharp/rpiv-todo:       todo
 *   - @juicesharp/rpiv-web-tools:  web_search, web_fetch
 *   - pi-subagents:                subagent, bg_wait, subagent_supervisor
 *   - @narumitw/pi-goal:           goal_complete, goal_blocked, goal_wait
 */

const TOOL_KINDS: Record<string, ToolKind> = {
  read: 'read',
  write: 'edit',
  edit: 'edit',
  bash: 'execute',
  grep: 'search',
  find: 'search',
  ls: 'search',
  advisor: 'think',
  web_search: 'search',
  web_fetch: 'fetch',
  mcp: 'other',
  mcpScript: 'execute',
  subagent: 'other',
  bg_wait: 'other',
  subagent_supervisor: 'other',
  todo: 'think',
  ask_user_question: 'other',
  goal_complete: 'think',
  goal_blocked: 'think',
  goal_wait: 'think'
}

export function toToolKind(toolName: string): ToolKind {
  return TOOL_KINDS[toolName] ?? 'other'
}

const MAX_TITLE_LENGTH = 100

function shorten(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > MAX_TITLE_LENGTH ? `${oneLine.slice(0, MAX_TITLE_LENGTH - 1)}…` : oneLine
}

function str(args: Record<string, unknown> | null, key: string): string | null {
  const value = args?.[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function num(args: Record<string, unknown> | null, key: string): number | null {
  const value = args?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asRecord(args: unknown): Record<string, unknown> | null {
  return args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : null
}

function mcpTitle(args: Record<string, unknown> | null): string {
  const tool = str(args, 'tool')
  if (tool) return `MCP: ${tool}`

  const action = str(args, 'action')
  if (action === 'install') return `MCP install: ${str(args, 'url') ?? ''}`.trim()
  if (action) return `MCP ${action}`

  const search = str(args, 'search')
  if (search) return `MCP search: ${search}`

  const describe = str(args, 'describe')
  if (describe) return `MCP describe: ${describe}`

  const connect = str(args, 'connect')
  if (connect) return `MCP connect: ${connect}`

  const server = str(args, 'server')
  if (server) return `MCP server: ${server}`

  return 'MCP status'
}

function subagentTitle(args: Record<string, unknown> | null): string {
  const action = str(args, 'action')
  if (action) return `Subagent ${action}`

  const asyncSuffix = args?.async === true ? ' (async)' : ''
  const agent = str(args, 'agent')
  if (agent) return `Subagent: ${agent}${asyncSuffix}`

  const workflow = str(args, 'workflow')
  if (workflow) return `Subagent workflow: ${workflow}${asyncSuffix}`

  if (str(args, 'workflowScript') || str(args, 'workflowScriptPath')) return `Subagent workflow${asyncSuffix}`
  return 'Subagent'
}

function todoTitle(args: Record<string, unknown> | null): string {
  const action = str(args, 'action') ?? 'update'
  const subject = str(args, 'subject')
  const id = num(args, 'id')
  const status = str(args, 'status')

  const target = subject ?? (id !== null ? `#${id}` : null)
  const parts = [`Todo ${action}`]
  if (target) parts.push(target)
  if (status && action === 'update') parts.push(`→ ${status}`)
  return parts.join(' ')
}

function askUserQuestionTitle(args: Record<string, unknown> | null): string {
  const questions = args?.questions
  if (!Array.isArray(questions) || questions.length === 0) return 'Ask user'
  if (questions.length === 1) {
    const first = asRecord(questions[0])
    const question = str(first, 'question')
    return question ? `Ask user: ${question}` : 'Ask user'
  }
  return `Ask user (${questions.length} questions)`
}

/**
 * Human-readable ACP tool call title for a pi tool call.
 * Falls back to the raw tool name for unknown tools.
 */
export function toToolTitle(toolName: string, rawArgs: unknown): string {
  const args = asRecord(rawArgs)

  switch (toolName) {
    case 'advisor':
      return 'Consult advisor'
    case 'web_search': {
      const query = str(args, 'query')
      return query ? shorten(`Search: ${query}`) : 'Web search'
    }
    case 'web_fetch': {
      const url = str(args, 'url')
      return url ? shorten(`Fetch ${url}`) : 'Web fetch'
    }
    case 'mcp':
      return shorten(mcpTitle(args))
    case 'mcpScript':
      return 'MCP script'
    case 'subagent':
      return shorten(subagentTitle(args))
    case 'bg_wait':
      return 'Wait for background work'
    case 'subagent_supervisor': {
      const action = str(args, 'action')
      return action ? `Supervisor ${action}` : 'Supervisor channel'
    }
    case 'todo':
      return shorten(todoTitle(args))
    case 'ask_user_question':
      return shorten(askUserQuestionTitle(args))
    case 'goal_complete':
      return 'Goal complete'
    case 'goal_blocked':
      return 'Goal blocked'
    case 'goal_wait':
      return 'Goal wait'
    default:
      return toolName
  }
}
