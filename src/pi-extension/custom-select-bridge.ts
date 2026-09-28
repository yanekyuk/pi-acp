import type { CustomUIFactory, ExtensionUIContext } from '@earendil-works/pi-coding-agent'

/**
 * Pi's RPC mode resolves `ctx.ui.custom()` to `undefined` without rendering, so extension
 * pickers built from a pi-tui `SelectList` (e.g. `/advisor`) silently do nothing in ACP.
 * The bridge builds the component headlessly, asks the same question through
 * `ctx.ui.select()` (which pi-acp renders as an ACP prompt), and feeds the answer back to
 * the list's own `onSelect`/`onCancel` so the extension's `done()` runs unchanged.
 */

type SelectListItem = { value: string; label: string; description?: string }

type SelectListLike = {
  filteredItems: SelectListItem[]
  onSelect?: (item: SelectListItem) => void
  onCancel?: () => void
}

type RenderPrototype = { render(width: number): string[] }

/** pi-tui classes whose rendering reveals a picker. */
export type PickerClasses = {
  SelectList: { prototype: RenderPrototype }
  Text: { prototype: RenderPrototype }
}

const DEFAULT_TITLE = 'Choose an option'
const HEADLESS_RENDER_WIDTH = 100
const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, 'g')

/** Factories only get a render loop they never see; rendering is replaced by the select dialog. */
const HEADLESS_TUI = { requestRender() {} }
const HEADLESS_KEYBINDINGS = {}

function plainText(text: string): string {
  return text.replace(ANSI_ESCAPE, '').trim()
}

/** Temporarily wraps a prototype's `render` to observe which instances draw, in draw order. */
function observeRenders(prototype: RenderPrototype, onRender: (instance: unknown) => void): () => void {
  const render = prototype.render
  prototype.render = function (this: unknown, width: number) {
    onRender(this)
    return render.call(this, width)
  }
  return () => {
    prototype.render = render
  }
}

/**
 * Pickers usually hide their SelectList inside closures, so render the component once and
 * take the first list drawn plus the first text drawn above it as the title.
 */
function findRenderedPicker(
  component: { render(width: number): string[] },
  classes: PickerClasses
): { list: SelectListLike; title: string } | null {
  let list: SelectListLike | undefined
  let title: string | undefined
  const restoreList = observeRenders(classes.SelectList.prototype, instance => {
    list ??= instance as SelectListLike
  })
  const restoreText = observeRenders(classes.Text.prototype, instance => {
    const text = plainText(String((instance as { text?: unknown }).text ?? ''))
    if (!list && !title && text) title = text
  })

  try {
    component.render(HEADLESS_RENDER_WIDTH)
  } catch {
    return null
  } finally {
    restoreList()
    restoreText()
  }

  if (!list || !Array.isArray(list.filteredItems) || list.filteredItems.length === 0) return null
  return { list, title: title ?? DEFAULT_TITLE }
}

/** pi-acp shows `Label — description` options with the description under the label. */
export function selectOptionText(item: SelectListItem): string {
  const label = plainText(item.label || item.value)
  const description = item.description ? plainText(item.description) : ''
  return description ? `${label} — ${description}` : label
}

export async function showCustomAsSelect<T>(
  ui: Pick<ExtensionUIContext, 'select' | 'theme'>,
  factory: CustomUIFactory<T>,
  classes: PickerClasses
): Promise<T | undefined> {
  let result: T | undefined
  let finished = false
  const done = (value: T) => {
    if (finished) return
    finished = true
    result = value
  }

  let component: Awaited<ReturnType<CustomUIFactory<T>>>
  try {
    component = await factory(HEADLESS_TUI, ui.theme, HEADLESS_KEYBINDINGS, done)
  } catch {
    return undefined
  }

  try {
    if (finished) return result
    const picker = findRenderedPicker(component, classes)
    if (!picker) return undefined

    const items = picker.list.filteredItems
    const options = items.map(selectOptionText)
    const choice = await ui.select(picker.title, options)
    const item = choice === undefined ? undefined : items[options.indexOf(choice)]
    if (item) picker.list.onSelect?.(item)
    else picker.list.onCancel?.()
    return result
  } finally {
    component.dispose?.()
  }
}

export function installCustomSelectBridge(ui: ExtensionUIContext, classes: PickerClasses): void {
  const select = ui.select.bind(ui)
  const theme = ui.theme
  ui.custom = factory => showCustomAsSelect({ select, theme }, factory, classes)
}
