import test from 'node:test'
import assert from 'node:assert/strict'
import { formatSelectPrompt, selectOptionLabel } from '../../src/acp/translate/extension-ui.js'

test('select options without descriptions stay unchanged', () => {
  assert.equal(selectOptionLabel('Agent - account'), 'Agent - account')
  assert.equal(formatSelectPrompt('Pick one', ['Alpha', 'Beta']), 'Pick one')
})

test('select descriptions appear in the wrapping prompt, not the action labels', () => {
  const options = ['Agent — Set up a profile', 'Matches – Review suggested matches', 'Type something.']
  assert.deepEqual(options.map(selectOptionLabel), ['Agent', 'Matches', 'Type something.'])
  assert.equal(
    formatSelectPrompt('Choose a journey', options),
    'Choose a journey\n\nOptions:\n- Agent — Set up a profile\n- Matches – Review suggested matches\n- Type something.'
  )
})
