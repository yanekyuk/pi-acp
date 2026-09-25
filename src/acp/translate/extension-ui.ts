import type { CreateElicitationRequest } from '@agentclientprotocol/sdk'

/**
 * Translation helpers for pi's extension UI sub-protocol (`extension_ui_request`)
 * to ACP affordances.
 */

export type TextInputMethod = 'input' | 'editor'

/** Keep the concise choice on the permission button; Pi still receives the original string. */
export function selectOptionLabel(option: string): string {
  const separator = option.search(/\s+[—–]\s+/)
  return separator < 0 ? option : option.slice(0, separator)
}

/** Permission buttons do not wrap in ACP clients, so show the full choices in the wrapping body. */
export function formatSelectPrompt(prompt: string, options: string[]): string {
  if (!options.some(option => selectOptionLabel(option) !== option)) return prompt

  const lines = options.map(option => (/^\d+\.\s/.test(option) ? option : `- ${option}`))
  return [prompt, `Options:\n${lines.join('\n')}`].filter(Boolean).join('\n\n')
}

/** Property name used for the single text field in pi input/editor elicitations. */
export const ELICITATION_TEXT_FIELD = 'value'

type UiRequestFields = Record<string, unknown>

function text(ev: UiRequestFields, key: string): string {
  const value = ev[key]
  return typeof value === 'string' ? value : ''
}

/**
 * Build an ACP form elicitation for a pi `input` (single-line) or `editor` (multi-line)
 * request. The session scope is added by the caller.
 */
export function buildTextElicitation(
  ev: UiRequestFields,
  method: TextInputMethod
): Omit<Extract<CreateElicitationRequest, { mode: 'form' }>, 'sessionId' | 'requestId'> {
  const title = text(ev, 'title').trim() || (method === 'editor' ? 'Edit text' : 'Enter a value')
  const placeholder = text(ev, 'placeholder').trim()
  const prefill = text(ev, 'prefill')

  return {
    mode: 'form',
    message: title,
    requestedSchema: {
      type: 'object',
      properties: {
        [ELICITATION_TEXT_FIELD]: {
          type: 'string',
          title: method === 'editor' ? 'Text' : 'Value',
          ...(placeholder ? { description: placeholder } : {}),
          ...(prefill ? { default: prefill } : {})
        }
      },
      required: [ELICITATION_TEXT_FIELD]
    },
    _meta: { piAcp: { method } }
  }
}

/** Extract the text the user entered from an accepted elicitation, or null if absent. */
export function elicitationTextValue(content: unknown): string | null {
  if (typeof content !== 'object' || content === null || Array.isArray(content)) return null

  const value = (content as Record<string, unknown>)[ELICITATION_TEXT_FIELD]
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return null
}

/**
 * Chat message shown when the client cannot render a text input: the user answers
 * by sending their next message.
 */
export function formatChatInputPrompt(ev: UiRequestFields, method: TextInputMethod): string {
  const title = text(ev, 'title').trim() || (method === 'editor' ? 'Pi needs some text' : 'Pi needs a value')
  const placeholder = text(ev, 'placeholder').trim()
  const prefill = text(ev, 'prefill')

  const lines = [`**${title}**`]
  if (placeholder) lines.push(`_${placeholder}_`)
  if (prefill.trim()) lines.push('', 'Current text:', '```', prefill, '```')
  lines.push('', 'Reply with your answer in chat. Press stop/cancel to dismiss.')

  return lines.join('\n')
}

/** `/name args` → `name`, or null when the message is not a slash command. */
export function parseExtensionCommandName(message: string): string | null {
  const trimmed = message.trimStart()
  if (!trimmed.startsWith('/')) return null

  const name = trimmed.slice(1).split(/\s/, 1)[0] ?? ''
  return name || null
}
