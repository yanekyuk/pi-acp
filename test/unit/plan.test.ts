import test from 'node:test'
import assert from 'node:assert/strict'
import { todoResultToPlan } from '../../src/acp/translate/plan.js'

test('todoResultToPlan: maps rpiv-todo tasks to ACP plan entries', () => {
  const plan = todoResultToPlan({
    content: [{ type: 'text', text: 'Updated #2 (pending → in_progress)' }],
    details: {
      action: 'update',
      nextId: 4,
      tasks: [
        { id: 1, subject: 'Explore codebase', status: 'completed' },
        { id: 2, subject: 'Implement feature', status: 'in_progress', activeForm: 'writing code', blockedBy: [1] },
        { id: 3, subject: 'Add tests', status: 'pending', blockedBy: [2] },
        { id: 4, subject: 'Old idea', status: 'deleted' }
      ]
    }
  })

  assert.deepEqual(plan, {
    entries: [
      { content: 'Explore codebase', status: 'completed', priority: 'medium', _meta: { piAcp: { id: 1 } } },
      {
        content: 'Implement feature — writing code',
        status: 'in_progress',
        priority: 'medium',
        _meta: { piAcp: { id: 2, blockedBy: [1] } }
      },
      { content: 'Add tests', status: 'pending', priority: 'medium', _meta: { piAcp: { id: 3, blockedBy: [2] } } }
    ]
  })
})

test('todoResultToPlan: empty task list yields an empty plan (clear)', () => {
  assert.deepEqual(todoResultToPlan({ details: { action: 'clear', tasks: [] } }), { entries: [] })
})

test('todoResultToPlan: returns null when the result has no task snapshot', () => {
  assert.equal(todoResultToPlan({ content: [{ type: 'text', text: 'x' }] }), null)
  assert.equal(todoResultToPlan({ details: { error: 'bad' } }), null)
  assert.equal(todoResultToPlan(null), null)
})
