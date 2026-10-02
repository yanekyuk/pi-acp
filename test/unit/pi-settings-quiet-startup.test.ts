import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { getQuietStartup } from '../../src/acp/pi-settings.js'

test('getQuietStartup: project setting overrides global for all three display modes', () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-quiet-setting-'))
  const project = join(dir, 'project')
  mkdirSync(join(project, '.pi'), { recursive: true })
  process.env.PI_CODING_AGENT_DIR = dir

  try {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ quietStartup: true }))
    assert.equal(getQuietStartup(project), true)

    writeFileSync(join(project, '.pi', 'settings.json'), JSON.stringify({ quietStartup: 'header' }))
    assert.equal(getQuietStartup(project), 'header')

    writeFileSync(join(project, '.pi', 'settings.json'), JSON.stringify({ quietStartup: false }))
    assert.equal(getQuietStartup(project), false)
  } finally {
    if (previousAgentDir == null) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir
    rmSync(dir, { recursive: true, force: true })
  }
})
