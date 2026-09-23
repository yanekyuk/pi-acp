import type { Plan, PlanEntry, PlanEntryStatus } from '@agentclientprotocol/sdk'

/**
 * Translate a `todo` tool result (from @juicesharp/rpiv-todo) into an ACP plan.
 *
 * The todo tool returns its full task list in `details.tasks` after every action, which
 * matches ACP's "send the complete plan on each update" semantics exactly.
 */

export const TODO_TOOL_NAME = 'todo'

type TodoTask = {
  id?: unknown
  subject?: unknown
  status?: unknown
  activeForm?: unknown
  blockedBy?: unknown
}

const PLAN_STATUSES: ReadonlySet<PlanEntryStatus> = new Set(['pending', 'in_progress', 'completed'])

function toPlanEntry(task: TodoTask): PlanEntry | null {
  const status = typeof task.status === 'string' ? task.status : ''
  if (!PLAN_STATUSES.has(status as PlanEntryStatus)) return null // e.g. "deleted" tombstones

  const subject = typeof task.subject === 'string' ? task.subject.trim() : ''
  if (!subject) return null

  const activeForm = typeof task.activeForm === 'string' ? task.activeForm.trim() : ''
  const content = status === 'in_progress' && activeForm ? `${subject} — ${activeForm}` : subject

  const meta: Record<string, unknown> = {}
  if (typeof task.id === 'number') meta.id = task.id
  if (Array.isArray(task.blockedBy) && task.blockedBy.length) meta.blockedBy = task.blockedBy

  return {
    content,
    status: status as PlanEntryStatus,
    priority: 'medium',
    ...(Object.keys(meta).length ? { _meta: { piAcp: meta } } : {})
  }
}

/**
 * Returns an ACP plan when `result` carries a todo task snapshot, otherwise null.
 * An empty task list yields an empty plan (the client clears its plan view).
 */
export function todoResultToPlan(result: unknown): Plan | null {
  const details = (result as { details?: unknown } | null | undefined)?.details
  const tasks = (details as { tasks?: unknown } | null | undefined)?.tasks
  if (!Array.isArray(tasks)) return null

  const entries: PlanEntry[] = []
  for (const task of tasks) {
    const entry = toPlanEntry((task ?? {}) as TodoTask)
    if (entry) entries.push(entry)
  }

  return { entries }
}
