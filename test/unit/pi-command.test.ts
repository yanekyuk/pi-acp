import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdirSync, rmSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  defaultPiCommand,
  shouldUseShellForPiCommand,
  getPiCommand,
  findInPath,
  findPiExecutable
} from '../../src/pi-rpc/command.js'

test('defaultPiCommand: uses pi.cmd on Windows and pi elsewhere', () => {
  const originalPlatform = process.platform

  try {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    assert.equal(defaultPiCommand(), 'pi.cmd')

    Object.defineProperty(process, 'platform', { value: 'darwin' })
    assert.equal(defaultPiCommand(), 'pi')
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
  }
})

test('shouldUseShellForPiCommand: enables shell for Windows cmd launchers only', () => {
  const originalPlatform = process.platform
  Object.defineProperty(process, 'platform', { value: 'win32' })

  try {
    assert.equal(shouldUseShellForPiCommand('pi.cmd'), true)
    assert.equal(shouldUseShellForPiCommand('C:\\Users\\me\\AppData\\Roaming\\npm\\pi.CMD'), true)
    assert.equal(shouldUseShellForPiCommand('pi.bat'), true)
    assert.equal(shouldUseShellForPiCommand('pi'), false)
    assert.equal(shouldUseShellForPiCommand('C:\\tools\\pi.exe'), false)
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
  }
})

test('shouldUseShellForPiCommand: keeps shell disabled on non-Windows', () => {
  const originalPlatform = process.platform
  Object.defineProperty(process, 'platform', { value: 'darwin' })

  try {
    assert.equal(shouldUseShellForPiCommand('pi.cmd'), false)
    assert.equal(shouldUseShellForPiCommand('pi'), false)
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
  }
})

test('findInPath: locates executable file within custom PATH', () => {
  const testDir = join(tmpdir(), `test-pi-path-${Date.now()}`)
  mkdirSync(testDir, { recursive: true })
  const fakeCmd = join(testDir, 'fake-pi')
  writeFileSync(fakeCmd, '#!/bin/sh\necho ok', { mode: 0o755 })
  try {
    chmodSync(fakeCmd, 0o755)
  } catch {
    // ignore
  }

  try {
    const found = findInPath('fake-pi', testDir)
    assert.equal(found, fakeCmd)

    const notFound = findInPath('nonexistent-binary', testDir)
    assert.equal(notFound, null)
  } finally {
    rmSync(testDir, { recursive: true, force: true })
  }
})

test('getPiCommand: preserves valid executable override path', () => {
  const testDir = join(tmpdir(), `test-pi-override-${Date.now()}`)
  mkdirSync(testDir, { recursive: true })
  const fakePi = join(testDir, 'custom-pi')
  writeFileSync(fakePi, '#!/bin/sh\necho ok', { mode: 0o755 })
  try {
    chmodSync(fakePi, 0o755)
  } catch {
    // ignore
  }

  try {
    const res = getPiCommand(fakePi)
    assert.equal(res, fakePi)
  } finally {
    rmSync(testDir, { recursive: true, force: true })
  }
})

test('getPiCommand: falls back to auto-detected pi when override path does not exist', () => {
  const nonExistentPath = '/opt/homebrew/bin/pi-does-not-exist-ever'
  const detected = findPiExecutable()
  const res = getPiCommand(nonExistentPath)

  if (detected) {
    assert.equal(res, detected)
  } else {
    assert.equal(res, nonExistentPath)
  }
})

test('getPiCommand: preserves bare command when it is non-existent', () => {
  const bareCmd = 'pi-does-not-exist-12345'
  const res = getPiCommand(bareCmd)
  assert.equal(res, bareCmd)
})
