import test from 'node:test'
import assert from 'node:assert/strict'
import { toAvailableCommandsFromPiGetCommands } from '../../src/acp/pi-commands.js'

const data = {
  commands: [
    { name: 'x', description: 'X', source: 'extension' },
    { name: 'btw', description: 'Side question (TUI overlay)', source: 'extension' },
    { name: 'skill:foo', description: 'Foo', source: 'skill', location: 'user' },
    { name: 'y', source: 'prompt', location: 'project' }
  ]
}

test('toAvailableCommandsFromPiGetCommands: includes extension commands by default and filters skill commands', () => {
  const all = toAvailableCommandsFromPiGetCommands(data, { enableSkillCommands: true })
  assert.deepEqual(all.commands, [
    { name: 'x', description: 'X' },
    { name: 'skill:foo', description: 'Foo' },
    { name: 'y', description: '(prompt:project)' }
  ])
  assert.deepEqual(all.extensionCommandNames, ['x'])

  const noSkills = toAvailableCommandsFromPiGetCommands(data, { enableSkillCommands: false }).commands
  assert.deepEqual(noSkills, [
    { name: 'x', description: 'X' },
    { name: 'y', description: '(prompt:project)' }
  ])
})

test('toAvailableCommandsFromPiGetCommands: can hide extension commands', () => {
  const hidden = toAvailableCommandsFromPiGetCommands(data, {
    enableSkillCommands: true,
    includeExtensionCommands: false
  })
  assert.deepEqual(hidden.commands, [
    { name: 'skill:foo', description: 'Foo' },
    { name: 'y', description: '(prompt:project)' }
  ])
  assert.deepEqual(hidden.extensionCommandNames, [])
})

test('toAvailableCommandsFromPiGetCommands: never offers TUI-only extension commands like /btw', () => {
  const { commands, extensionCommandNames } = toAvailableCommandsFromPiGetCommands(data)
  assert.ok(!commands.some(c => c.name === 'btw'))
  assert.ok(!extensionCommandNames.includes('btw'))
})
