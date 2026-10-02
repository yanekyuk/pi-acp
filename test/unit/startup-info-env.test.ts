import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

class FakeSessions {
  constructor(private readonly session: any) {}
  async create(_params: any) {
    return this.session
  }
}

async function startupInfoWithSetting(quietStartup: boolean | 'header') {
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-quietstartup-'))
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ quietStartup }), 'utf-8')
  process.env.PI_CODING_AGENT_DIR = dir

  // Agent schedules startup info and available commands after creating the session.
  const realSetTimeout = globalThis.setTimeout
  const timeouts: Array<unknown> = []
  ;(globalThis as any).setTimeout = (fn: unknown, _ms?: number) => {
    timeouts.push(fn)
    return 0 as any
  }

  try {
    const conn = new FakeAgentSideConnection()
    let setStartupInfoCalled = false
    const session = {
      sessionId: 's1',
      cwd: process.cwd(),
      proc: {
        async getAvailableModels() {
          return { models: [{ provider: 'test', id: 'model', name: 'model' }] }
        },
        async getState() {
          return {
            thinkingLevel: 'medium',
            model: { provider: 'test', id: 'model' }
          }
        }
      },
      setStartupInfo(_text: string) {
        setStartupInfoCalled = true
      },
      sendStartupInfoIfPending() {}
    }

    const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
    ;(agent as any).sessions = new FakeSessions(session) as any

    const res = await agent.newSession({ cwd: process.cwd(), mcpServers: [] } as any)
    return {
      startupInfo: (res?._meta?.piAcp?.startupInfo ?? null) as string | null,
      setStartupInfoCalled,
      scheduledCallbacks: timeouts.length
    }
  } finally {
    ;(globalThis as any).setTimeout = realSetTimeout
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir
    rmSync(dir, { recursive: true, force: true })
  }
}

test('PiAcpAgent: quietStartup=true hides startup info but retains an update notice', async () => {
  const { startupInfo, setStartupInfoCalled, scheduledCallbacks } = await startupInfoWithSetting(true)

  // The live npm check may or may not find an update.
  if (startupInfo) {
    assert.match(startupInfo, /New version available/)
    assert.equal(setStartupInfoCalled, true)
    assert.equal(scheduledCallbacks, 2)
  } else {
    assert.equal(setStartupInfoCalled, false)
    assert.equal(scheduledCallbacks, 1)
  }
})

test('PiAcpAgent: quietStartup="header" keeps the version, not resource sections', async () => {
  const { startupInfo, setStartupInfoCalled, scheduledCallbacks } = await startupInfoWithSetting('header')

  assert.ok(startupInfo)
  assert.match(startupInfo, /^pi v\d+/)
  assert.doesNotMatch(startupInfo, /## (Context|Skills|Prompts|Extensions)/)
  assert.equal(setStartupInfoCalled, true)
  assert.equal(scheduledCallbacks, 2)
})
