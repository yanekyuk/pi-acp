import assert from 'node:assert/strict'
import test from 'node:test'
import type { Component, CustomUIFactory, ExtensionUIContext } from '@earendil-works/pi-coding-agent'
import {
  installCustomSelectBridge,
  showCustomAsSelect,
  type PickerClasses
} from '../../src/pi-extension/custom-select-bridge.js'

type Item = { value: string; label: string; description?: string }

class FakeText {
  constructor(public text: string) {}
  render(): string[] {
    return [this.text]
  }
}

class FakeSelectList {
  filteredItems: Item[]
  onSelect?: (item: Item) => void
  onCancel?: () => void
  constructor(items: Item[]) {
    this.filteredItems = items
  }
  render(): string[] {
    return this.filteredItems.map(item => item.label)
  }
}

const CLASSES: PickerClasses = { SelectList: FakeSelectList, Text: FakeText }

const ITEMS: Item[] = [
  { value: 'anthropic:opus', label: 'Opus  (anthropic) ✓' },
  { value: 'openai:gpt', label: 'GPT  (openai)', description: 'fast' },
  { value: '__none__', label: 'No advisor' }
]

/** Mirrors rpiv-advisor: the SelectList lives in a closure behind a render/handleInput wrapper. */
function advisorLikePicker(): { factory: CustomUIFactory<string | null>; disposed: () => boolean } {
  let disposed = false
  const factory: CustomUIFactory<string | null> = (_tui, _theme, _kb, done) => {
    const list = new FakeSelectList(ITEMS)
    list.onSelect = item => done(item.value)
    list.onCancel = () => done(null)
    const parts = [new FakeText(''), new FakeText('\x1b[1mAdvisor Tool\x1b[22m'), new FakeText('Prose…'), list]
    return {
      render: (width: number) => parts.flatMap(part => part.render()).map(line => line.slice(0, width)),
      dispose: () => {
        disposed = true
      }
    }
  }
  return { factory, disposed: () => disposed }
}

function fakeUi(answer: (options: string[]) => string | undefined) {
  const calls: Array<{ title: string; options: string[] }> = []
  const ui = {
    theme: {},
    select: async (title: string, options: string[]) => {
      calls.push({ title, options })
      return answer(options)
    }
  }
  return { ui, calls }
}

test('custom select bridge: asks through select() and resolves with the picked item value', async () => {
  const picker = advisorLikePicker()
  const { ui, calls } = fakeUi(options => options[1])

  const result = await showCustomAsSelect(ui, picker.factory, CLASSES)

  assert.equal(result, 'openai:gpt')
  assert.deepEqual(calls, [
    { title: 'Advisor Tool', options: ['Opus  (anthropic) ✓', 'GPT  (openai) — fast', 'No advisor'] }
  ])
  assert.equal(picker.disposed(), true)
})

test('custom select bridge: restores the observed render methods', async () => {
  const renderList = FakeSelectList.prototype.render
  const renderText = FakeText.prototype.render
  await showCustomAsSelect(fakeUi(() => undefined).ui, advisorLikePicker().factory, CLASSES)

  assert.equal(FakeSelectList.prototype.render, renderList)
  assert.equal(FakeText.prototype.render, renderText)
})

test('custom select bridge: a cancelled select runs the list cancel handler', async () => {
  const { ui } = fakeUi(() => undefined)

  assert.equal(await showCustomAsSelect(ui, advisorLikePicker().factory, CLASSES), null)
})

test('custom select bridge: components without a select list keep the RPC no-op result', async () => {
  let disposed = false
  const overlay: Component = {
    render: () => new FakeText('Overlay only').render(),
    dispose: () => {
      disposed = true
    }
  }
  const { ui, calls } = fakeUi(() => 'x')

  assert.equal(await showCustomAsSelect(ui, () => overlay, CLASSES), undefined)
  assert.equal(calls.length, 0)
  assert.equal(disposed, true)
})

test('custom select bridge: factories that need a real terminal fall back to undefined', async () => {
  const { ui } = fakeUi(() => 'x')
  const factory: CustomUIFactory<string> = () => {
    throw new Error('terminal required')
  }

  assert.equal(await showCustomAsSelect(ui, factory, CLASSES), undefined)
})

test('custom select bridge: install replaces ctx.ui.custom on the shared UI context', async () => {
  const { ui: base } = fakeUi(options => options[0])
  const ui = { ...base, custom: async () => undefined } as unknown as ExtensionUIContext
  installCustomSelectBridge(ui, CLASSES)

  assert.equal(await ui.custom(advisorLikePicker().factory), 'anthropic:opus')
})
