import type { ToolCallContent } from '@agentclientprotocol/sdk'
import { toolResultToContent } from './pi-tools.js'

type UnknownRecord = Record<string, unknown>

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as UnknownRecord) : null
}

function str(record: UnknownRecord | null | undefined, key: string): string | null {
  const value = record?.[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function num(record: UnknownRecord | null | undefined, key: string): number | null {
  const value = record?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function bool(record: UnknownRecord | null | undefined, key: string): boolean {
  return record?.[key] === true
}

function shorten(text: string, maxLen: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > maxLen ? `${oneLine.slice(0, maxLen - 1)}…` : oneLine
}

export function isSubagentTool(toolName: string | null | undefined): boolean {
  return typeof toolName === 'string' && toolName.toLowerCase() === 'subagent'
}

export function formatDuration(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined || ms < 0 || !Number.isFinite(ms)) return null
  if (ms < 1000) return `${Math.round(ms)}ms`
  const totalSec = Math.round(ms / 1000)
  if (totalSec < 60) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(totalSec / 60)
  const seconds = totalSec % 60
  if (seconds === 0) return `${minutes}m`
  return `${minutes}m ${seconds}s`
}

export function formatTokens(tokens: number | null | undefined): string | null {
  if (tokens === null || tokens === undefined || tokens <= 0 || !Number.isFinite(tokens)) return null
  if (tokens < 1000) return `${tokens} tok`
  if (tokens < 1000000) return `${(tokens / 1000).toFixed(1)}k tok`
  return `${(tokens / 1000000).toFixed(2)}M tok`
}

export function extractToolTarget(toolName: string, rawArgs: unknown): string | null {
  const args = asRecord(rawArgs)
  if (!args) return null

  if (toolName === 'read' || toolName === 'write' || toolName === 'edit') {
    const p = str(args, 'path') ?? str(args, 'filePath') ?? str(args, 'file')
    return p ? shorten(p, 45) : null
  }

  if (toolName === 'bash') {
    const cmd = str(args, 'command') ?? str(args, 'cmd')
    return cmd ? shorten(cmd.split('\n')[0] ?? '', 40) : null
  }

  if (toolName === 'grep' || toolName === 'find') {
    const pattern = str(args, 'pattern') ?? str(args, 'query')
    const p = str(args, 'path')
    if (pattern && p) return shorten(`"${pattern}" ${p}`, 40)
    if (pattern) return shorten(`"${pattern}"`, 40)
    if (p) return shorten(p, 40)
    return null
  }

  if (toolName === 'web_search') {
    const query = str(args, 'query')
    return query ? shorten(`"${query}"`, 40) : null
  }

  if (toolName === 'web_fetch') {
    const url = str(args, 'url')
    return url ? shorten(url, 45) : null
  }

  return null
}

function resolveWorkflowName(args: UnknownRecord | null): string | null {
  return str(args, 'workflow') ?? str(args, 'workflowScriptPath') ?? (str(args, 'workflowScript') ? 'script' : null)
}

function resolveAgentName(args: UnknownRecord | null, progress: UnknownRecord | null): string {
  const workflow = resolveWorkflowName(args)
  if (workflow) return workflow
  return str(progress, 'agent') ?? str(args, 'agent') ?? 'subagent'
}

function resolveTaskText(args: UnknownRecord | null, progress: UnknownRecord | null): string | null {
  const task = str(args, 'task') ?? str(progress, 'task')
  if (!task || task === '[prompt redacted]' || task === 'PROMPT_REDACTED') return null
  return task
}

function resolveStatsLine(params: {
  toolCount?: number | null
  tokens?: number | null
  durationMs?: number | null
}): string {
  const parts: string[] = []
  if (params.toolCount !== null && params.toolCount !== undefined && params.toolCount > 0) {
    parts.push(`${params.toolCount} ${params.toolCount === 1 ? 'tool' : 'tools'}`)
  }
  const formattedTokens = formatTokens(params.tokens)
  if (formattedTokens) parts.push(formattedTokens)
  const formattedDuration = formatDuration(params.durationMs)
  if (formattedDuration) parts.push(formattedDuration)

  return parts.join(' · ')
}

function formatStatusGlyph(status: string): string {
  switch (status.toLowerCase()) {
    case 'completed':
      return '✓'
    case 'failed':
      return '✗'
    case 'running':
      return '⟳'
    case 'paused':
    case 'interrupted':
    case 'detached':
      return '■'
    case 'stopped':
      return '⊘'
    default:
      return '•'
  }
}

function isManagement(args: UnknownRecord | null, details: UnknownRecord | null): boolean {
  return Boolean(str(args, 'action')) || Boolean(str(details, 'action')) || str(details, 'mode') === 'management'
}

export function resolveChildStatus(entry: UnknownRecord | null): string {
  if (!entry) return 'unknown'
  const progress = asRecord(entry.progress)
  const status = str(entry, 'status') ?? str(progress, 'status')

  if (status === 'stopped' || bool(entry, 'stopped') || bool(progress, 'stopped')) return 'stopped'
  if (status === 'paused' || status === 'interrupted' || bool(entry, 'interrupted') || bool(progress, 'interrupted')) {
    return 'paused'
  }
  if (status === 'detached' || bool(entry, 'detached') || bool(progress, 'detached')) return 'detached'
  if (status === 'running' || bool(entry, 'running') || bool(progress, 'running')) return 'running'
  if (status === 'pending') return 'pending'
  if (status === 'failed') return 'failed'
  if (status === 'completed') return 'completed'

  const exitCode = num(entry, 'exitCode')
  if (exitCode !== null && exitCode !== 0) return 'failed'
  if (entry.success === false || entry.failed === true) return 'failed'
  if (exitCode === 0 || entry.success === true) return 'completed'

  if (status) return status

  return 'unknown'
}

export function resolveWorkflowStatus(items: UnknownRecord[]): string {
  if (items.length === 0) return 'unknown'
  const statuses = items.map(resolveChildStatus)
  if (statuses.some(s => s === 'running')) return 'running'
  if (statuses.some(s => s === 'failed')) return 'failed'
  if (statuses.some(s => s === 'stopped')) return 'stopped'
  if (statuses.some(s => s === 'paused')) return 'paused'
  if (statuses.some(s => s === 'detached')) return 'detached'
  if (statuses.every(s => s === 'completed')) return 'completed'
  if (statuses.some(s => s === 'pending')) return 'pending'
  return 'unknown'
}

function isRecognizableProgressItem(item: unknown): item is UnknownRecord {
  const r = asRecord(item)
  if (!r) return false
  return (
    typeof r.agent === 'string' ||
    typeof r.status === 'string' ||
    typeof r.task === 'string' ||
    typeof r.toolCount === 'number' ||
    typeof r.durationMs === 'number' ||
    typeof r.currentTool === 'string' ||
    Array.isArray(r.recentTools) ||
    Array.isArray(r.recentOutput)
  )
}

function isRecognizableResultItem(item: unknown): item is UnknownRecord {
  const r = asRecord(item)
  if (!r) return false
  return (
    typeof r.agent === 'string' ||
    typeof r.exitCode === 'number' ||
    typeof r.status === 'string' ||
    typeof r.task === 'string' ||
    r.progressSummary !== undefined
  )
}

function parseRecordList(arr: unknown): UnknownRecord[] {
  if (!Array.isArray(arr)) return []
  const list: UnknownRecord[] = []
  for (const item of arr) {
    const r = asRecord(item)
    if (r) list.push(r)
  }
  return list
}

function extractProgressList(details: UnknownRecord | null): UnknownRecord[] {
  const direct = parseRecordList(details?.progress).filter(isRecognizableProgressItem)
  if (direct.length > 0) return direct

  const fromResults: UnknownRecord[] = []
  const results = parseRecordList(details?.results)
  for (const r of results) {
    const p = asRecord(r.progress)
    if (p && isRecognizableProgressItem(p)) {
      fromResults.push(p)
    }
  }
  return fromResults
}

function getAsyncReceiptId(args: UnknownRecord | null, details: UnknownRecord | null): string | null {
  if (isManagement(args, details)) return null
  const asyncId = str(details, 'asyncId')
  if (!asyncId) return null
  const results = parseRecordList(details?.results).filter(isRecognizableResultItem)
  const hasTerminalOrActive = results.some(r => {
    const s = resolveChildStatus(r)
    return s !== 'unknown'
  })
  if (hasTerminalOrActive) return null
  return asyncId
}

const MAX_DISPLAYED_CHILD_ROWS = 6

function formatStepSummary(entries: UnknownRecord[], isChain: boolean): string {
  const lines: string[] = []
  const visible = entries.slice(0, MAX_DISPLAYED_CHILD_ROWS)

  visible.forEach((entry, idx) => {
    const agent = str(entry, 'agent') ?? str(entry, 'workflowKey') ?? `step-${idx + 1}`
    const status = resolveChildStatus(entry)
    const glyph = formatStatusGlyph(status)
    const duration = formatDuration(num(entry, 'durationMs') ?? num(asRecord(entry.progressSummary), 'durationMs'))
    const toolCount = num(entry, 'toolCount') ?? num(asRecord(entry.progressSummary), 'toolCount')
    const stats = [toolCount ? `${toolCount} tools` : null, duration].filter(Boolean).join(' · ')
    const statsSuffix = stats ? ` (${stats})` : ''

    let activitySuffix = ''
    if (status === 'running') {
      const tool = str(entry, 'currentTool') ?? str(asRecord(entry.progress), 'currentTool')
      if (tool) {
        const target = extractToolTarget(tool, entry.currentToolArgs ?? asRecord(entry.progress)?.currentToolArgs)
        activitySuffix = ` — \`${tool}\`${target ? ` \`${target}\`` : ''}`
      }
    }

    const prefix = isChain ? `${idx + 1}.` : '-'
    lines.push(`${prefix} **${agent}**: ${glyph} ${status}${activitySuffix}${statsSuffix}`)
  })

  if (entries.length > MAX_DISPLAYED_CHILD_ROWS) {
    const remaining = entries.length - MAX_DISPLAYED_CHILD_ROWS
    lines.push(`  *… (${remaining} more ${isChain ? 'steps' : 'agents'})*`)
  }

  return lines.join('\n')
}

function extractRecentOutputPreview(recentOutput: unknown, contentBlocks: unknown): string | null {
  const lines: string[] = []

  if (Array.isArray(recentOutput)) {
    for (const item of recentOutput) {
      if (typeof item === 'string' && item.trim()) {
        const itemLines = item
          .split('\n')
          .map(l => l.trim())
          .filter(Boolean)
        lines.push(...itemLines)
      }
    }
  }

  if (lines.length === 0 && Array.isArray(contentBlocks)) {
    for (const b of contentBlocks) {
      const block = asRecord(b)
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        const text = block.text.trim()
        if (text !== '(running...)') {
          const itemLines = text
            .split('\n')
            .map(l => l.trim())
            .filter(Boolean)
          lines.push(...itemLines)
        }
      }
    }
  }

  if (lines.length === 0) return null

  const selected = lines.slice(-3).map(l => shorten(l, 90))
  return selected.map(l => `> ${l}`).join('\n')
}

function composePreamble(preamble: string, baseContent: ToolCallContent[]): ToolCallContent[] {
  if (baseContent.length === 0) {
    return [{ type: 'content', content: { type: 'text', text: preamble } }]
  }

  let textInserted = false
  const composed: ToolCallContent[] = []

  for (const item of baseContent) {
    if (!textInserted && item.type === 'content' && item.content.type === 'text') {
      const originalText = item.content.text.trim()
      const merged = originalText ? `${preamble}\n\n---\n\n${originalText}` : preamble
      composed.push({ type: 'content', content: { type: 'text', text: merged } })
      textInserted = true
    } else {
      composed.push(item)
    }
  }

  if (!textInserted) {
    composed.unshift({ type: 'content', content: { type: 'text', text: preamble } })
  }

  return composed
}

export function formatSubagentTitle(params: {
  args?: unknown
  partialResult?: unknown
  result?: unknown
  status?: 'pending' | 'in_progress' | 'completed' | 'failed'
}): string {
  const args = asRecord(params.args)
  const res = asRecord(params.result ?? params.partialResult)
  const details = asRecord(res?.details)

  if (isManagement(args, details)) {
    const action = str(args, 'action') ?? str(details, 'action')
    const target = str(args, 'id') ?? str(args, 'agent')
    const actionName = action ?? 'management'
    return target ? `Subagent ${actionName}: ${target}` : `Subagent ${actionName}`
  }

  const progressList = extractProgressList(details)
  const resultsList = parseRecordList(details?.results).filter(isRecognizableResultItem)

  const agent = resolveAgentName(args, progressList[0] ?? resultsList[0] ?? null)
  const workflow = resolveWorkflowName(args)
  const status = params.status ?? (res ? 'completed' : 'in_progress')

  const verifiedReceiptRunId = getAsyncReceiptId(args, details)

  if (bool(args, 'async') && !verifiedReceiptRunId) {
    if (status === 'failed') {
      return `Subagent: ${agent} (launch failed)`
    }
    if (status === 'in_progress') {
      return `Subagent: ${agent} (launching)`
    }
  }

  if (verifiedReceiptRunId) {
    if (status === 'failed') {
      return `Subagent: ${agent} (launch failed)`
    }
    return `Subagent: ${agent} (launched in background · ${verifiedReceiptRunId})`
  }

  if (status === 'in_progress') {
    const runningProgress = progressList.find(p => resolveChildStatus(p) === 'running')
    const activeProgress = runningProgress ?? progressList[0] ?? null
    const activeStatus = resolveChildStatus(activeProgress)

    if (!runningProgress && activeStatus !== 'running' && progressList.length > 0) {
      const overall = resolveWorkflowStatus(progressList)
      const prefix = workflow ? `Subagent workflow: ${workflow}` : `Subagent: ${agent}`
      return `${prefix} (${overall})`
    }

    const currentTool = runningProgress ? str(runningProgress, 'currentTool') : null

    if (workflow) {
      const activeAgent = str(activeProgress, 'agent')
      if (activeAgent && currentTool) {
        return shorten(`Subagent workflow: ${workflow} (running · ${activeAgent}: ${currentTool})`, 80)
      }
      if (activeAgent) {
        return shorten(`Subagent workflow: ${workflow} (running · ${activeAgent})`, 80)
      }
      return shorten(`Subagent workflow: ${workflow} (running)`, 80)
    }

    if (currentTool) {
      const target = extractToolTarget(currentTool, runningProgress?.currentToolArgs)
      return shorten(`Subagent: ${agent} (running · ${currentTool}${target ? ` ${target}` : ''})`, 80)
    }

    const duration = formatDuration(num(activeProgress, 'durationMs'))
    const toolCount = num(activeProgress, 'toolCount')
    if (toolCount || duration) {
      const stats = [toolCount ? `${toolCount} tools` : null, duration].filter(Boolean).join(' · ')
      return shorten(`Subagent: ${agent} (running · ${stats})`, 80)
    }

    const mode = str(details, 'mode')
    if ((mode === 'parallel' || mode === 'chain') && progressList.length > 1) {
      const runningCount = progressList.filter(p => resolveChildStatus(p) === 'running').length
      return `Subagent: ${runningCount} active agents (${duration ?? 'running'})`
    }

    return `Subagent: ${agent} (running)`
  }

  if (status === 'completed') {
    const mode = str(details, 'mode')
    const isMulti = mode === 'chain' || mode === 'workflow' || mode === 'parallel' || resultsList.length > 1

    if (isMulti && resultsList.length > 0) {
      const overall = resolveWorkflowStatus(resultsList)
      const prefix = workflow ? `Subagent workflow: ${workflow}` : `Subagent: ${agent}`
      return `${prefix} (${overall})`
    }

    const firstResult = resultsList[0] ?? null
    const childStatus = resolveChildStatus(firstResult)

    if (childStatus !== 'completed') {
      return `Subagent: ${agent} (${childStatus})`
    }

    const summary = asRecord(firstResult?.progressSummary)
    const duration = formatDuration(num(summary, 'durationMs') ?? num(firstResult, 'durationMs'))
    const toolCount = num(summary, 'toolCount')
    const stats = [toolCount ? `${toolCount} tools` : null, duration].filter(Boolean).join(' · ')
    return stats ? `Subagent: ${agent} (completed · ${stats})` : `Subagent: ${agent} (completed)`
  }

  if (status === 'failed') {
    const duration = formatDuration(num(resultsList[0], 'durationMs'))
    return duration ? `Subagent: ${agent} (failed · ${duration})` : `Subagent: ${agent} (failed)`
  }

  return `Subagent: ${agent}`
}

export function subagentProgressToContent(params: { args?: unknown; partialResult?: unknown }): ToolCallContent[] {
  const args = asRecord(params.args)
  const partial = asRecord(params.partialResult)
  const details = asRecord(partial?.details)

  if (isManagement(args, details)) {
    return toolResultToContent(partial)
  }

  const progressList = extractProgressList(details)
  const resultsList = parseRecordList(details?.results).filter(isRecognizableResultItem)

  if (progressList.length === 0 && resultsList.length === 0) {
    return toolResultToContent(partial)
  }

  const primaryProgress = progressList[0] ?? null
  const runningProgress = progressList.find(p => resolveChildStatus(p) === 'running')
  const activeProgress = runningProgress ?? primaryProgress
  const agent = resolveAgentName(args, primaryProgress)
  const task = resolveTaskText(args, primaryProgress)
  const workflow = resolveWorkflowName(args)
  const mode = str(details, 'mode') ?? (workflow ? 'workflow' : 'single')
  const isMulti = mode === 'chain' || mode === 'workflow' || mode === 'parallel' || progressList.length > 1

  const blocks: string[] = []

  if (isMulti) {
    const overall = resolveWorkflowStatus(progressList)
    const totalTokens = num(asRecord(details?.totalChildUsage), 'totalTokens')
    const duration = formatDuration(num(details, 'durationMs'))
    const stats = [formatTokens(totalTokens), duration].filter(Boolean).join(' · ')
    const headerPrefix = workflow ? `**Subagent workflow: ${workflow}**` : `**Subagent: ${agent}**`
    const header = `${headerPrefix} · ${overall}${stats ? ` (${stats})` : ''}`
    blocks.push(header)
  } else {
    const childStatus = resolveChildStatus(activeProgress)
    const stats = resolveStatsLine({
      toolCount: num(activeProgress, 'toolCount'),
      tokens: num(activeProgress, 'tokens'),
      durationMs: num(activeProgress, 'durationMs')
    })
    const headerParts = [`**Subagent: ${agent}**`, `· ${childStatus}`]
    if (stats) headerParts.push(`(${stats})`)
    blocks.push(headerParts.join(' '))
  }

  if (task) {
    blocks.push(`**Task**: ${shorten(task, 140)}`)
  }

  if (isMulti && progressList.length > 0) {
    const label = mode === 'chain' || mode === 'workflow' ? '**Steps**:' : '**Agents**:'
    blocks.push(`${label}\n${formatStepSummary(progressList, mode === 'chain' || mode === 'workflow')}`)
  }

  if (runningProgress) {
    const activityLines: string[] = []
    const currentTool = str(runningProgress, 'currentTool')
    if (currentTool) {
      const target = extractToolTarget(currentTool, runningProgress.currentToolArgs)
      const targetSuffix = target ? ` \`${target}\`` : ''
      activityLines.push(`- **Current tool**: \`${currentTool}\`${targetSuffix}`)
    } else if (str(runningProgress, 'activityState') === 'thinking') {
      activityLines.push('- **Activity**: Thinking...')
    }

    const recentTools = Array.isArray(runningProgress.recentTools) ? runningProgress.recentTools : []
    if (recentTools.length > 0) {
      const recentFormatted = recentTools
        .slice(-3)
        .map(rt => {
          const t = typeof rt === 'string' ? rt : str(asRecord(rt), 'tool')
          return t ? `\`${t}\`` : null
        })
        .filter((t): t is string => t !== null)

      if (recentFormatted.length > 0) {
        activityLines.push(`- **Recent**: ${recentFormatted.join(' → ')}`)
      }
    }

    if (activityLines.length > 0) {
      blocks.push(`**Activity**:\n${activityLines.join('\n')}`)
    }
  }

  const outputPreview = extractRecentOutputPreview(activeProgress?.recentOutput, partial?.content)
  if (outputPreview) {
    blocks.push(`**Output preview**:\n${outputPreview}`)
  }

  return [{ type: 'content', content: { type: 'text', text: blocks.join('\n\n') } }]
}

export function subagentCompletionToContent(params: {
  args?: unknown
  result?: unknown
  isError?: boolean
}): ToolCallContent[] {
  const args = asRecord(params.args)
  const result = asRecord(params.result)
  const details = asRecord(result?.details)
  const isError = Boolean(params.isError)

  const baseContent = toolResultToContent(result)

  if (isManagement(args, details)) {
    return baseContent
  }

  const resultsList = parseRecordList(details?.results).filter(isRecognizableResultItem)
  const verifiedReceiptRunId = getAsyncReceiptId(args, details)

  if (verifiedReceiptRunId) {
    if (isError) {
      return baseContent
    }
    const agent = resolveAgentName(args, null)
    const preamble = [
      `**Subagent: ${agent}** · launched in background (run \`${verifiedReceiptRunId}\`)`,
      '',
      `Use \`subagent({ action: "status", id: "${verifiedReceiptRunId}" })\` or \`bg_wait\` to inspect.`
    ].join('\n')

    return composePreamble(preamble, baseContent)
  }

  if (resultsList.length === 0) {
    return baseContent
  }

  const workflow = resolveWorkflowName(args)
  const agent = resolveAgentName(args, resultsList[0] ?? null)
  const mode = str(details, 'mode') ?? (workflow ? 'workflow' : 'single')
  const isMulti = mode === 'chain' || mode === 'workflow' || mode === 'parallel' || resultsList.length > 1

  let header: string
  if (isMulti) {
    const overall = isError ? 'failed' : resolveWorkflowStatus(resultsList)
    const headerPrefix = workflow ? `**Subagent workflow: ${workflow}**` : `**Subagent: ${agent}**`
    const totalTokens = num(asRecord(details?.totalChildUsage), 'totalTokens')
    const duration = formatDuration(num(details, 'durationMs'))
    const stats = [formatTokens(totalTokens), duration].filter(Boolean).join(' · ')
    header = `${headerPrefix} · ${overall}${stats ? ` (${stats})` : ''}`
  } else {
    const firstResult = resultsList[0] ?? null
    const childStatus = isError ? 'failed' : resolveChildStatus(firstResult)
    const summary = asRecord(firstResult?.progressSummary)
    const stats = resolveStatsLine({
      toolCount: num(summary, 'toolCount'),
      tokens: num(summary, 'tokens') ?? num(asRecord(details?.totalChildUsage), 'totalTokens'),
      durationMs: num(summary, 'durationMs') ?? num(firstResult, 'durationMs')
    })
    const headerParts = [`**Subagent: ${agent}**`, `· ${childStatus}`]
    if (stats) headerParts.push(`(${stats})`)
    header = headerParts.join(' ')
  }

  const stepsBlock =
    isMulti && resultsList.length > 0
      ? `${mode === 'chain' || mode === 'workflow' ? '**Steps**:' : '**Agents**:'}\n${formatStepSummary(resultsList, mode === 'chain' || mode === 'workflow')}`
      : null

  const preamble = [header, stepsBlock].filter(Boolean).join('\n\n')
  return composePreamble(preamble, baseContent)
}
