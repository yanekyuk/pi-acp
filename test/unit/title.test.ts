import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  buildTitlePrompt,
  cleanConventionalTitle,
  cleanTitle,
  deriveConventionalTitle,
  deriveFallbackTitle,
  deriveInitialTitle,
  generateTitle
} from '../../src/acp/title.js'

test('cleanTitle: removes ANSI escapes and parses clean title', () => {
  const raw = '\u001b[32mESLint Setup for React\u001b[39m'
  assert.equal(cleanTitle(raw), 'ESLint Setup for React')
})

test('cleanTitle: strips markdown formatting, headers, and prefixes', () => {
  assert.equal(cleanTitle('### **Title: Fix Database Timeout**'), 'Fix Database Timeout')
  assert.equal(cleanTitle('Subject: Refactor Auth Service.'), 'Refactor Auth Service')
  assert.equal(cleanTitle('1. Implement User Login'), 'Implement User Login')
  assert.equal(cleanTitle('- Add Unit Tests'), 'Add Unit Tests')
  assert.equal(cleanTitle('"Configure TypeScript in Monorepo"'), 'Configure TypeScript in Monorepo')
  assert.equal(cleanTitle('“Setup CI/CD Pipeline”'), 'Setup CI/CD Pipeline')
})

test('cleanTitle: takes first non-empty line and collapses whitespace', () => {
  const multiLine = '\n\n  Optimize SQL Queries   \n\nHere are some details...'
  assert.equal(cleanTitle(multiLine), 'Optimize SQL Queries')
})

test('cleanTitle: returns null for empty or whitespace-only input', () => {
  assert.equal(cleanTitle(''), null)
  assert.equal(cleanTitle('   \n  \t '), null)
})

test('cleanTitle: truncates long title at word boundary', () => {
  const long =
    'This is an extremely long title that exceeds the maximum length limit of eighty characters by a substantial margin'
  const cleaned = cleanTitle(long)
  assert.ok(cleaned)
  assert.ok(cleaned.length <= 80)
  assert.ok(!cleaned.endsWith(' '))
})

test('deriveInitialTitle: uses a cleaned first line from the user message', () => {
  assert.equal(
    deriveInitialTitle('Can you please configure Jest with Babel?'),
    'Can you please configure Jest with Babel?'
  )
  assert.equal(deriveInitialTitle('### Fix the login flow\nAdditional details'), 'Fix the login flow')
  assert.equal(deriveInitialTitle('   '), 'New Session')
})

test('deriveFallbackTitle: extracts clean title and strips conversational prefixes', () => {
  assert.equal(deriveFallbackTitle('Can you please help me configure Jest with Babel?'), 'Configure Jest with Babel?')
  assert.equal(deriveFallbackTitle('How do I setup Tailwind CSS in Next.js?'), 'Setup Tailwind CSS in Next.js?')
  assert.equal(deriveFallbackTitle('I need to fix memory leak in worker pool'), 'Fix memory leak in worker pool')
})

test('deriveFallbackTitle: skips code block fences to find meaningful text', () => {
  const message = '```typescript\nconst a = 1\n```\nFix this compile error in TypeScript'
  assert.equal(deriveFallbackTitle(message), 'Fix this compile error in TypeScript')
})

test('deriveFallbackTitle: returns "New Session" for empty or whitespace messages', () => {
  assert.equal(deriveFallbackTitle(''), 'New Session')
  assert.equal(deriveFallbackTitle('   \n  '), 'New Session')
})

test('deriveConventionalTitle: creates a branch-style fallback', () => {
  assert.equal(deriveConventionalTitle('Can you please fix the CSS layout?'), 'fix/the-css-layout')
  assert.equal(deriveConventionalTitle('Add session title generation'), 'feat/add-session-title-generation')
  assert.equal(deriveConventionalTitle('Update dependency configuration'), 'chore/update-dependency-configuration')
})

test('cleanConventionalTitle: normalizes model output to branch style', () => {
  assert.equal(cleanConventionalTitle('Fix: Prevent Session Race.'), 'fix/prevent-session-race')
  assert.equal(cleanConventionalTitle('feat/add smart titles'), 'feat/add-smart-titles')
  assert.equal(cleanConventionalTitle('Generated Title From AI'), 'feat/generated-title-from-ai')
})

test('buildTitlePrompt: requests a branch-style title from the full conversation', () => {
  const prompt = buildTitlePrompt({
    userMessage: 'Help me migrate from Vue 2 to Vue 3',
    conversation: [
      { role: 'user', text: 'Help me migrate from Vue 2 to Vue 3' },
      { role: 'assistant', text: 'Here is a step-by-step migration guide' },
      { role: 'user', text: 'Only update the router for now' }
    ]
  })
  assert.match(prompt, /conventional Git branch/)
  assert.match(prompt, /<type>\/<short-kebab-case-description>/)
  assert.match(prompt, /User: Help me migrate from Vue 2 to Vue 3/)
  assert.match(prompt, /Assistant: Here is a step-by-step migration guide/)
  assert.match(prompt, /User: Only update the router for now/)
})

test('generateTitle: sends the title prompt over stdin and uses successful output', async () => {
  let spawnedArgs: string[] = []
  let spawnedStdio: unknown
  let stdinText = ''

  const mockSpawn = ((_cmd: string, args: string[], options: { stdio?: unknown }) => {
    spawnedArgs = args
    spawnedStdio = options.stdio

    const child = new EventEmitter() as any
    child.stdin = new EventEmitter()
    child.stdin.end = (text: string) => {
      stdinText = text
    }
    child.stdout = new EventEmitter()
    child.kill = () => {}

    setTimeout(() => {
      child.stdout.emit('data', 'Generated Title From AI\n')
      child.emit('close', 0)
    }, 10)

    return child
  }) as any

  const title = await generateTitle({
    userMessage: 'Test prompt',
    spawnProcess: mockSpawn
  })

  assert.equal(title, 'feat/generated-title-from-ai')
  assert.deepEqual(spawnedStdio, ['pipe', 'pipe', 'pipe'])
  assert.match(stdinText, /User: Test prompt/)
  assert.ok(!spawnedArgs.includes(stdinText))
})

test('generateTitle: falls back to a conventional title on non-zero exit code', async () => {
  const mockSpawn = ((_cmd: string, _args: string[]) => {
    const child = new EventEmitter() as any
    child.stdout = new EventEmitter()
    child.kill = () => {}

    setTimeout(() => {
      child.stdout.emit('data', 'Some error message\n')
      child.emit('close', 1)
    }, 10)

    return child
  }) as any

  const title = await generateTitle({
    userMessage: 'Can you please fix the CSS layout on the landing page?',
    spawnProcess: mockSpawn
  })

  assert.equal(title, 'fix/the-css-layout-on-the-landing-page')
})

test('generateTitle: falls back when spawning throws synchronously', async () => {
  const mockSpawn = (() => {
    throw new Error('spawn failed')
  }) as any

  const title = await generateTitle({
    userMessage: 'Investigate flaky integration tests',
    spawnProcess: mockSpawn
  })

  assert.equal(title, 'test/investigate-flaky-integration-tests')
})

test('generateTitle: falls back to a conventional title on spawn error', async () => {
  const mockSpawn = ((_cmd: string, _args: string[]) => {
    const child = new EventEmitter() as any
    child.stdout = new EventEmitter()
    child.kill = () => {}

    setTimeout(() => {
      child.emit('error', new Error('spawn ENOENT'))
    }, 10)

    return child
  }) as any

  const title = await generateTitle({
    userMessage: 'Setup Redis connection pooling',
    spawnProcess: mockSpawn
  })

  assert.equal(title, 'feat/setup-redis-connection-pooling')
})
