import test from 'node:test'
import assert from 'node:assert/strict'
import { configurePiAgentDirectory } from '../../src/pi-rpc/agent-environment.js'

test('nested Pi launch uses the default agent directory instead of its parent directory', () => {
  const env = { PI_CODING_AGENT: 'true', PI_CODING_AGENT_DIR: '/parent/harness' }

  configurePiAgentDirectory(env)

  assert.equal('PI_CODING_AGENT_DIR' in env, false)
})

test('explicit pi-acp agent directory overrides an inherited Pi directory', () => {
  const env = {
    PI_CODING_AGENT: 'true',
    PI_CODING_AGENT_DIR: '/parent/harness',
    PI_ACP_AGENT_DIR: '/my/agent'
  }

  configurePiAgentDirectory(env)

  assert.equal(env.PI_CODING_AGENT_DIR, '/my/agent')
})

test('non-nested launch preserves a configured Pi agent directory', () => {
  const env = { PI_CODING_AGENT_DIR: '/my/agent' }

  configurePiAgentDirectory(env)

  assert.equal(env.PI_CODING_AGENT_DIR, '/my/agent')
})
