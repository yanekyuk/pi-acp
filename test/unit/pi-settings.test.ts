import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getAutoTitle } from '../../src/acp/pi-settings.js'

type AutoTitleEnv = {
  PI_ACP_AUTO_TITLE?: string
  PI_AUTO_TITLE?: string
}

function withAutoTitleEnv(values: AutoTitleEnv, run: () => void): void {
  const previousAcp = process.env.PI_ACP_AUTO_TITLE
  const previousLegacy = process.env.PI_AUTO_TITLE

  try {
    setEnv('PI_ACP_AUTO_TITLE', values.PI_ACP_AUTO_TITLE)
    setEnv('PI_AUTO_TITLE', values.PI_AUTO_TITLE)
    run()
  } finally {
    setEnv('PI_ACP_AUTO_TITLE', previousAcp)
    setEnv('PI_AUTO_TITLE', previousLegacy)
  }
}

function setEnv(name: keyof AutoTitleEnv, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name]
  } else {
    process.env[name] = value
  }
}

test('getAutoTitle: reads PI_ACP_AUTO_TITLE', () => {
  withAutoTitleEnv({ PI_ACP_AUTO_TITLE: 'off' }, () => {
    assert.equal(getAutoTitle(process.cwd()), false)
  })
})

test('getAutoTitle: PI_ACP_AUTO_TITLE takes precedence over the legacy alias', () => {
  withAutoTitleEnv({ PI_ACP_AUTO_TITLE: 'true', PI_AUTO_TITLE: 'false' }, () => {
    assert.equal(getAutoTitle(process.cwd()), true)
  })

  withAutoTitleEnv({ PI_ACP_AUTO_TITLE: 'false', PI_AUTO_TITLE: 'true' }, () => {
    assert.equal(getAutoTitle(process.cwd()), false)
  })
})

test('getAutoTitle: reads the project setting', t => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-auto-title-'))
  const agentDir = join(root, 'agent')
  const projectDir = join(root, 'project')
  const projectSettingsDir = join(projectDir, '.pi')
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR

  mkdirSync(agentDir, { recursive: true })
  mkdirSync(projectSettingsDir, { recursive: true })
  writeFileSync(join(projectSettingsDir, 'settings.json'), JSON.stringify({ autoTitle: false }))
  process.env.PI_CODING_AGENT_DIR = agentDir

  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir
    rmSync(root, { recursive: true, force: true })
  })

  withAutoTitleEnv({}, () => {
    assert.equal(getAutoTitle(projectDir), false)
  })
})
