import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getAutoTitle } from '../../src/acp/pi-settings.js'

test('getAutoTitle: project setting and adapter environment override control automatic titles', t => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-auto-title-'))
  const agentDir = join(root, 'agent')
  const projectDir = join(root, 'project')
  const projectSettingsDir = join(projectDir, '.pi')
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  const previousAutoTitle = process.env.PI_AUTO_TITLE
  const previousAcpAutoTitle = process.env.PI_ACP_AUTO_TITLE

  mkdirSync(agentDir, { recursive: true })
  mkdirSync(projectSettingsDir, { recursive: true })
  writeFileSync(join(projectSettingsDir, 'settings.json'), JSON.stringify({ autoTitle: false }))

  process.env.PI_CODING_AGENT_DIR = agentDir
  delete process.env.PI_AUTO_TITLE
  delete process.env.PI_ACP_AUTO_TITLE

  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir

    if (previousAutoTitle === undefined) delete process.env.PI_AUTO_TITLE
    else process.env.PI_AUTO_TITLE = previousAutoTitle

    if (previousAcpAutoTitle === undefined) delete process.env.PI_ACP_AUTO_TITLE
    else process.env.PI_ACP_AUTO_TITLE = previousAcpAutoTitle

    rmSync(root, { recursive: true, force: true })
  })

  assert.equal(getAutoTitle(projectDir), false)

  process.env.PI_ACP_AUTO_TITLE = 'true'
  process.env.PI_AUTO_TITLE = 'false'
  assert.equal(getAutoTitle(projectDir), true)

  process.env.PI_ACP_AUTO_TITLE = 'false'
  process.env.PI_AUTO_TITLE = 'true'
  assert.equal(getAutoTitle(projectDir), false)
})
