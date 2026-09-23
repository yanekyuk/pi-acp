import test from 'node:test'
import assert from 'node:assert/strict'
import { toToolKind, toToolTitle } from '../../src/acp/translate/extension-tools.js'

test('toToolKind: maps pi built-ins and well-known extension tools', () => {
  assert.equal(toToolKind('read'), 'read')
  assert.equal(toToolKind('edit'), 'edit')
  assert.equal(toToolKind('write'), 'edit')
  assert.equal(toToolKind('bash'), 'execute')
  assert.equal(toToolKind('advisor'), 'think')
  assert.equal(toToolKind('web_search'), 'search')
  assert.equal(toToolKind('web_fetch'), 'fetch')
  assert.equal(toToolKind('agent_browser'), 'fetch')
  assert.equal(toToolKind('agent_browser_code'), 'execute')
  assert.equal(toToolKind('agent_browser_web_search'), 'search')
  assert.equal(toToolKind('mcpScript'), 'execute')
  assert.equal(toToolKind('todo'), 'think')
  assert.equal(toToolKind('goal_complete'), 'think')
  assert.equal(toToolKind('subagent'), 'other')
  assert.equal(toToolKind('something_unknown'), 'other')
})

test('toToolTitle: web tools', () => {
  assert.equal(toToolTitle('web_search', { query: 'pi acp' }), 'Search: pi acp')
  assert.equal(toToolTitle('web_search', {}), 'Web search')
  assert.equal(toToolTitle('web_fetch', { url: 'https://example.com' }), 'Fetch https://example.com')
})

test('toToolTitle: browser tools', () => {
  assert.equal(
    toToolTitle('agent_browser', { args: ['open', 'https://example.com'] }),
    'Browser: open https://example.com'
  )
  assert.equal(toToolTitle('agent_browser', {}), 'Browser')
  assert.equal(toToolTitle('agent_browser_code', { code: 'secret source' }), 'Browser code')
  assert.equal(toToolTitle('agent_browser_action', { action: 'click', locator: 'role' }), 'Browser click: role')
  assert.equal(toToolTitle('agent_browser_qa', { url: 'https://example.com' }), 'Browser QA: https://example.com')
  assert.equal(
    toToolTitle('agent_browser_web_search', { query: 'ACP browser support' }),
    'Browser search: ACP browser support'
  )
  assert.equal(toToolTitle('agent_browser_tools', {}), 'Browser capabilities')
})

test('toToolTitle: mcp adapter', () => {
  assert.equal(toToolTitle('mcp', { tool: 'xcodebuild_list_sims', args: {} }), 'MCP: xcodebuild_list_sims')
  assert.equal(toToolTitle('mcp', { search: 'calendar' }), 'MCP search: calendar')
  assert.equal(toToolTitle('mcp', { describe: 'foo' }), 'MCP describe: foo')
  assert.equal(toToolTitle('mcp', { action: 'install', url: 'https://x/mcp' }), 'MCP install: https://x/mcp')
  assert.equal(toToolTitle('mcp', { action: 'auth-start', server: 's' }), 'MCP auth-start')
  assert.equal(toToolTitle('mcp', { server: 'linear' }), 'MCP server: linear')
  assert.equal(toToolTitle('mcp', {}), 'MCP status')
  assert.equal(toToolTitle('mcpScript', { code: 'x' }), 'MCP script')
})

test('toToolTitle: subagents', () => {
  assert.equal(toToolTitle('subagent', { agent: 'scout', task: 'x' }), 'Subagent: scout')
  assert.equal(toToolTitle('subagent', { agent: 'scout', async: true }), 'Subagent: scout (async)')
  assert.equal(toToolTitle('subagent', { workflow: 'review', args: {} }), 'Subagent workflow: review')
  assert.equal(toToolTitle('subagent', { workflowScript: 'return 1' }), 'Subagent workflow')
  assert.equal(toToolTitle('subagent', { action: 'status', id: 'abc' }), 'Subagent status')
  assert.equal(toToolTitle('subagent', {}), 'Subagent')
  assert.equal(toToolTitle('bg_wait', {}), 'Wait for background work')
  assert.equal(toToolTitle('subagent_supervisor', { action: 'reply' }), 'Supervisor reply')
})

test('toToolTitle: todo, ask_user_question, goal, advisor', () => {
  assert.equal(toToolTitle('todo', { action: 'create', subject: 'Write tests' }), 'Todo create Write tests')
  assert.equal(toToolTitle('todo', { action: 'update', id: 3, status: 'completed' }), 'Todo update #3 → completed')
  assert.equal(toToolTitle('todo', { action: 'list' }), 'Todo list')
  assert.equal(toToolTitle('ask_user_question', { questions: [{ question: 'Which DB?' }] }), 'Ask user: Which DB?')
  assert.equal(toToolTitle('ask_user_question', { questions: [{}, {}] }), 'Ask user (2 questions)')
  assert.equal(toToolTitle('goal_complete', {}), 'Goal complete')
  assert.equal(toToolTitle('goal_blocked', {}), 'Goal blocked')
  assert.equal(toToolTitle('goal_wait', {}), 'Goal wait')
  assert.equal(toToolTitle('advisor', {}), 'Consult advisor')
})

test('toToolTitle: falls back to the tool name and tolerates partial/streaming args', () => {
  assert.equal(toToolTitle('read', { path: 'a.ts' }), 'read')
  assert.equal(toToolTitle('web_search', { partialArgs: '{"que' }), 'Web search')
  assert.equal(toToolTitle('subagent', undefined), 'Subagent')
  assert.equal(toToolTitle('web_search', { query: 'x'.repeat(200) }).length, 100)
})
