import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { SelectList, Text } from '@earendil-works/pi-tui'
import { installCustomSelectBridge } from './custom-select-bridge.js'

/** Lets `ctx.ui.custom()` SelectList pickers (e.g. `/advisor`) work in RPC mode; see custom-select-bridge.ts. */
export default function customSelectExtension(pi: ExtensionAPI): void {
  // Pi binds a fresh UI context before every session_start (startup, reload, session switch).
  pi.on('session_start', (_event, ctx) => {
    if (ctx.hasUI) installCustomSelectBridge(ctx.ui, { SelectList, Text })
  })
}
