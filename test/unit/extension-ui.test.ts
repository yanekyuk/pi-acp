import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildSelectElicitation,
  elicitationSelectedOption,
  formatSelectPrompt,
  parseSelectOption,
  selectOptionLabel
} from '../../src/acp/translate/extension-ui.js'

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

test('select options split into a title and optional description', () => {
  assert.deepEqual(parseSelectOption('Agent — Set up a profile'), { title: 'Agent', description: 'Set up a profile' })
  assert.deepEqual(parseSelectOption('Matches – Review'), { title: 'Matches', description: 'Review' })
  assert.deepEqual(parseSelectOption('Agent - account'), { title: 'Agent - account' })
})

test('select elicitation keys choices by index and maps answers back to pi options', () => {
  const options = ['Same', 'Same', 'Other — with details']
  const request = buildSelectElicitation({ message: 'Pick one' }, options)
  assert.equal(request.message, 'Pick one')
  assert.deepEqual((request.requestedSchema.properties as any).value.oneOf, [
    { const: '0', title: 'Same' },
    { const: '1', title: 'Same' },
    { const: '2', title: 'Other', description: 'with details' }
  ])

  assert.equal(elicitationSelectedOption({ value: '2' }, options), 'Other — with details')
  assert.equal(elicitationSelectedOption({ value: '3' }, options), null)
  assert.equal(elicitationSelectedOption({ value: '-1' }, options), null)
  assert.equal(elicitationSelectedOption({ value: 'Same' }, options), null)
  assert.equal(elicitationSelectedOption(undefined, options), null)
})
