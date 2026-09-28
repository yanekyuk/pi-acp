import test from 'node:test'
import assert from 'node:assert/strict'
import {
  extractToolTarget,
  formatDuration,
  formatSubagentTitle,
  formatTokens,
  isSubagentTool,
  resolveChildStatus,
  resolveWorkflowStatus,
  subagentCompletionToContent,
  subagentProgressToContent
} from '../../src/acp/translate/subagent.js'

test('isSubagentTool identifies subagent tool', () => {
  assert.equal(isSubagentTool('subagent'), true)
  assert.equal(isSubagentTool('Subagent'), true)
  assert.equal(isSubagentTool('SUBAGENT'), true)
  assert.equal(isSubagentTool('bash'), false)
  assert.equal(isSubagentTool('todo'), false)
  assert.equal(isSubagentTool(undefined), false)
  assert.equal(isSubagentTool(null), false)
})

test('formatDuration formats ms across boundaries', () => {
  assert.equal(formatDuration(undefined), null)
  assert.equal(formatDuration(-1), null)
  assert.equal(formatDuration(250), '250ms')
  assert.equal(formatDuration(1500), '1.5s')
  assert.equal(formatDuration(59999), '1m')
  assert.equal(formatDuration(65000), '1m 5s')
  assert.equal(formatDuration(130000), '2m 10s')
})

test('formatTokens formats token counts with units', () => {
  assert.equal(formatTokens(undefined), null)
  assert.equal(formatTokens(0), null)
  assert.equal(formatTokens(500), '500 tok')
  assert.equal(formatTokens(1500), '1.5k tok')
  assert.equal(formatTokens(2500000), '2.50M tok')
})

test('extractToolTarget extracts representative targets', () => {
  assert.equal(extractToolTarget('read', { path: 'src/index.ts' }), 'src/index.ts')
  assert.equal(extractToolTarget('write', { filePath: 'test/file.ts' }), 'test/file.ts')
  assert.equal(extractToolTarget('bash', { command: 'npm test\necho done' }), 'npm test')
  assert.equal(extractToolTarget('grep', { pattern: 'export', path: 'src/' }), '"export" src/')
  assert.equal(extractToolTarget('web_search', { query: 'acp spec' }), '"acp spec"')
  assert.equal(extractToolTarget('web_fetch', { url: 'https://example.com' }), 'https://example.com')
  assert.equal(extractToolTarget('unknown', {}), null)
  assert.equal(extractToolTarget('read', null), null)
})

test('formatSubagentTitle: formats running and completed titles', () => {
  // Running with current tool
  assert.equal(
    formatSubagentTitle({
      args: { agent: 'scout' },
      partialResult: {
        details: {
          progress: [
            { agent: 'scout', status: 'running', currentTool: 'read', currentToolArgs: { path: 'src/auth.ts' } }
          ]
        }
      },
      status: 'in_progress'
    }),
    'Subagent: scout (running · read src/auth.ts)'
  )

  // Running with tool count and duration
  assert.equal(
    formatSubagentTitle({
      args: { agent: 'scout' },
      partialResult: {
        details: {
          progress: [{ agent: 'scout', status: 'running', toolCount: 3, durationMs: 4200 }]
        }
      },
      status: 'in_progress'
    }),
    'Subagent: scout (running · 3 tools · 4.2s)'
  )

  // Completed with summary
  assert.equal(
    formatSubagentTitle({
      args: { agent: 'scout' },
      result: {
        details: {
          results: [{ agent: 'scout', exitCode: 0, progressSummary: { toolCount: 4, durationMs: 5800 } }]
        }
      },
      status: 'completed'
    }),
    'Subagent: scout (completed · 4 tools · 5.8s)'
  )

  // Failed
  assert.equal(
    formatSubagentTitle({
      args: { agent: 'scout' },
      result: {
        details: {
          results: [{ agent: 'scout', durationMs: 2300, exitCode: 1 }]
        }
      },
      status: 'failed'
    }),
    'Subagent: scout (failed · 2.3s)'
  )

  // Action status
  assert.equal(
    formatSubagentTitle({
      args: { action: 'status' }
    }),
    'Subagent status'
  )

  // Async launch in progress (before receipt)
  assert.equal(
    formatSubagentTitle({
      args: { agent: 'worker', async: true },
      status: 'in_progress'
    }),
    'Subagent: worker (launching)'
  )

  // Async launch completed (receipt returned, child running in background)
  assert.equal(
    formatSubagentTitle({
      args: { agent: 'worker', async: true },
      result: { details: { asyncId: 'run-xyz' } },
      status: 'completed'
    }),
    'Subagent: worker (launched in background · run-xyz)'
  )

  // Failed async launch
  assert.equal(
    formatSubagentTitle({
      args: { agent: 'worker', async: true },
      status: 'failed'
    }),
    'Subagent: worker (launch failed)'
  )

  // Interrupted / paused child outcome
  assert.equal(
    formatSubagentTitle({
      args: { agent: 'scout' },
      result: { details: { results: [{ agent: 'scout', interrupted: true }] } },
      status: 'completed'
    }),
    'Subagent: scout (paused)'
  )

  // Stopped child outcome
  assert.equal(
    formatSubagentTitle({
      args: { agent: 'scout' },
      result: { details: { results: [{ agent: 'scout', stopped: true }] } },
      status: 'completed'
    }),
    'Subagent: scout (stopped)'
  )

  // Foreground runId with running child is not an async launch receipt
  assert.equal(
    formatSubagentTitle({
      result: { details: { runId: 'r1', results: [{ agent: 'worker', status: 'running' }] } },
      status: 'completed'
    }),
    'Subagent: worker (running)'
  )

  // asyncId with stopped child is stopped, not a launch receipt
  assert.equal(
    formatSubagentTitle({
      result: { details: { asyncId: 'r2', results: [{ agent: 'worker', stopped: true }] } },
      status: 'completed'
    }),
    'Subagent: worker (stopped)'
  )

  // Management mode without args.action
  assert.equal(
    formatSubagentTitle({
      result: { details: { mode: 'management' } }
    }),
    'Subagent management'
  )

  // Completed child's stale tool is not claimed as currently running
  assert.equal(
    formatSubagentTitle({
      args: { agent: 'scout' },
      partialResult: {
        details: {
          progress: [
            { agent: 'scout', status: 'completed', currentTool: 'read', currentToolArgs: { path: 'file.txt' } }
          ]
        }
      },
      status: 'in_progress'
    }),
    'Subagent: scout (completed)'
  )
})

test('subagentProgressToContent: renders rich compact card during execution', () => {
  const content = subagentProgressToContent({
    args: { agent: 'scout', task: 'Inspect auth boundaries' },
    partialResult: {
      content: [{ type: 'text', text: '(running...)' }],
      details: {
        mode: 'single',
        progress: [
          {
            agent: 'scout',
            status: 'running',
            task: '[prompt redacted]',
            durationMs: 4200,
            toolCount: 3,
            tokens: 1200,
            currentTool: 'read',
            currentToolArgs: { path: 'src/auth/service.ts' },
            recentTools: [{ tool: 'grep' }, { tool: 'read' }],
            recentOutput: ['Found 4 entry points: validateToken, createSession']
          }
        ]
      }
    }
  })

  assert.equal(content.length, 1)
  const text = (content[0] as any).content.text
  assert.match(text, /\*\*Subagent: scout\*\* · running \(3 tools · 1\.2k tok · 4\.2s\)/)
  assert.match(text, /\*\*Task\*\*: Inspect auth boundaries/)
  assert.match(text, /- \*\*Current tool\*\*: `read` `src\/auth\/service\.ts`/)
  assert.match(text, /- \*\*Recent\*\*: `grep` → `read`/)
  assert.match(text, /\*\*Output preview\*\*:\n> Found 4 entry points: validateToken, createSession/)
})

test('subagentProgressToContent: renders multi-step chain progress', () => {
  const content = subagentProgressToContent({
    args: { workflow: 'review' },
    partialResult: {
      details: {
        mode: 'chain',
        progress: [
          { agent: 'scout', status: 'completed', toolCount: 2, durationMs: 1500 },
          { agent: 'worker', status: 'running', currentTool: 'edit', currentToolArgs: { path: 'src/fix.ts' } }
        ]
      }
    }
  })

  assert.equal(content.length, 1)
  const text = (content[0] as any).content.text
  assert.match(text, /\*\*Subagent workflow: review\*\* · running/)
  assert.match(text, /\*\*Steps\*\*:/)
  assert.match(text, /1\. \*\*scout\*\*: ✓ completed \(2 tools · 1\.5s\)/)
  assert.match(text, /2\. \*\*worker\*\*: ⟳ running/)
})

test('subagentCompletionToContent: renders completed card with final response text', () => {
  const content = subagentCompletionToContent({
    args: { agent: 'scout', task: 'Inspect auth' },
    result: {
      content: [{ type: 'text', text: 'Analysis complete: all endpoints are authenticated.' }],
      details: {
        mode: 'single',
        results: [
          {
            agent: 'scout',
            exitCode: 0,
            progressSummary: { toolCount: 4, tokens: 2500, durationMs: 6200 }
          }
        ]
      }
    },
    isError: false
  })

  assert.equal(content.length, 1)
  const text = (content[0] as any).content.text
  assert.match(text, /\*\*Subagent: scout\*\* · completed \(4 tools · 2\.5k tok · 6\.2s\)/)
  assert.match(text, /---/)
  assert.match(text, /Analysis complete: all endpoints are authenticated\./)
})

test('subagentCompletionToContent: renders failed card with error message', () => {
  const content = subagentCompletionToContent({
    args: { agent: 'scout' },
    result: {
      content: [{ type: 'text', text: 'Failed to find config file.' }],
      details: {
        mode: 'single',
        results: [
          {
            agent: 'scout',
            exitCode: 1,
            durationMs: 1800
          }
        ]
      }
    },
    isError: true
  })

  assert.equal(content.length, 1)
  const text = (content[0] as any).content.text
  assert.match(text, /\*\*Subagent: scout\*\* · failed \(1\.8s\)/)
  assert.match(text, /Failed to find config file\./)
})

test('resolveChildStatus: requires explicit completion evidence and honors explicit status over exitCode', () => {
  assert.equal(resolveChildStatus({ progressSummary: { durationMs: 100 } }), 'unknown')
  assert.equal(resolveChildStatus({ status: 'pending', exitCode: 0 }), 'pending')
  assert.equal(resolveChildStatus({ progress: { status: 'running' }, exitCode: 0 }), 'running')
  assert.equal(resolveChildStatus({ exitCode: 0 }), 'completed')
  assert.equal(resolveChildStatus({ status: 'completed' }), 'completed')
  assert.equal(resolveChildStatus({ progress: { status: 'running' } }), 'running')
  assert.equal(resolveChildStatus({ stopped: true }), 'stopped')
  assert.equal(resolveChildStatus({ interrupted: true }), 'paused')
  assert.equal(resolveChildStatus(null), 'unknown')
})

test('resolveWorkflowStatus: completion requires every child completed', () => {
  assert.equal(resolveWorkflowStatus([{ status: 'completed' }, { status: 'pending' }]), 'pending')
  assert.equal(resolveWorkflowStatus([{ status: 'completed' }, {}]), 'unknown')
  assert.equal(resolveWorkflowStatus([{ status: 'completed' }, { status: 'failed' }]), 'failed')
  assert.equal(resolveWorkflowStatus([{ status: 'completed' }, { status: 'completed' }]), 'completed')
})

test('subagentCompletionToContent: renders background launch receipt with text and image', () => {
  const content = subagentCompletionToContent({
    args: { agent: 'scout', async: true },
    result: {
      content: [
        { type: 'text', text: 'Started run' },
        { type: 'image', data: 'cG5n', mimeType: 'image/png' }
      ],
      details: {
        asyncId: 'run-99'
      }
    },
    isError: false
  })

  assert.equal(content.length, 2)
  const textBlock = (content[0] as any).content
  const imageBlock = (content[1] as any).content
  assert.match(textBlock.text, /\*\*Subagent: scout\*\* · launched in background \(run `run-99`\)/)
  assert.match(textBlock.text, /Started run/)
  assert.equal(imageBlock.type, 'image')
})

test('subagentCompletionToContent: failed async launch with ID preserves error and never claims launch', () => {
  const content = subagentCompletionToContent({
    args: { agent: 'scout', async: true },
    result: {
      content: [{ type: 'text', text: 'Execution error in worker' }],
      details: { asyncId: 'run-err' }
    },
    isError: true
  })

  assert.equal(content.length, 1)
  const text = (content[0] as any).content.text
  assert.match(text, /Execution error in worker/)
  assert.doesNotMatch(text, /launched in background/)
})

test('subagentCompletionToContent: preserves error message on failed async launch', () => {
  const content = subagentCompletionToContent({
    args: { agent: 'scout', async: true },
    result: {
      content: [{ type: 'text', text: 'Spawn failed: out of memory' }]
    },
    isError: true
  })

  assert.equal(content.length, 1)
  const text = (content[0] as any).content.text
  assert.match(text, /Spawn failed: out of memory/)
  assert.doesNotMatch(text, /launched in background/)
})

test('subagentCompletionToContent: preserves management action output directly', () => {
  const content = subagentCompletionToContent({
    args: { action: 'status' },
    result: {
      content: [{ type: 'text', text: 'Active runs: none' }],
      details: { mode: 'management' }
    },
    isError: false
  })

  assert.equal(content.length, 1)
  const text = (content[0] as any).content.text
  assert.equal(text, 'Active runs: none')
  assert.doesNotMatch(text, /\*\*Subagent:.*· completed/)
})

test('subagentCompletionToContent: preserves images and resource links in completed result', () => {
  const content = subagentCompletionToContent({
    args: { agent: 'scout' },
    result: {
      content: [
        { type: 'text', text: 'Diagram created' },
        { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }
      ],
      details: {
        mode: 'single',
        results: [{ agent: 'scout', exitCode: 0 }]
      }
    },
    isError: false
  })

  assert.equal(content.length, 2)
  const textBlock = (content[0] as any).content
  const imageBlock = (content[1] as any).content
  assert.equal(textBlock.type, 'text')
  assert.match(textBlock.text, /\*\*Subagent: scout\*\* · completed/)
  assert.match(textBlock.text, /Diagram created/)
  assert.equal(imageBlock.type, 'image')
  assert.equal(imageBlock.mimeType, 'image/png')
})

test('subagentProgressToContent: tracks active running step when previous step is completed', () => {
  const content = subagentProgressToContent({
    args: { workflow: 'deploy' },
    partialResult: {
      details: {
        mode: 'chain',
        progress: [
          { agent: 'builder', status: 'completed', durationMs: 2000, toolCount: 3 },
          {
            agent: 'tester',
            status: 'running',
            durationMs: 1500,
            currentTool: 'bash',
            currentToolArgs: { command: 'npm test' }
          }
        ]
      }
    }
  })

  assert.equal(content.length, 1)
  const text = (content[0] as any).content.text
  assert.match(text, /1\. \*\*builder\*\*: ✓ completed \(3 tools · 2\.0s\)/)
  assert.match(text, /2\. \*\*tester\*\*: ⟳ running/)
  assert.match(text, /- \*\*Current tool\*\*: `bash` `npm test`/)
})

test('subagentProgressToContent: preserves legitimate JSON in preview', () => {
  const content = subagentProgressToContent({
    args: { agent: 'scout' },
    partialResult: {
      content: [{ type: 'text', text: '(running...)' }],
      details: {
        mode: 'single',
        progress: [
          {
            agent: 'scout',
            status: 'running',
            recentOutput: ['{"status": "ok", "items": 42}']
          }
        ]
      }
    }
  })

  assert.equal(content.length, 1)
  const text = (content[0] as any).content.text
  assert.match(text, /> \{"status": "ok", "items": 42\}/)
})

test('subagentProgressToContent: gracefully falls back unchanged on malformed/null arrays', () => {
  const partial = {
    content: [{ type: 'text', text: 'raw output fallback' }],
    details: {
      progress: [null, undefined, 42, 'invalid']
    }
  }
  const content = subagentProgressToContent({
    args: null,
    partialResult: partial
  })

  assert.equal(content.length, 1)
  const text = (content[0] as any).content.text
  assert.equal(text, 'raw output fallback')
})
