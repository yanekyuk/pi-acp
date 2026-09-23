import test from 'node:test'
import assert from 'node:assert/strict'
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
