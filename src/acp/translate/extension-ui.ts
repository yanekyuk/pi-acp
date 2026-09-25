import type { CreateElicitationRequest } from '@agentclientprotocol/sdk'

/**
 * Translation helpers for pi's extension UI sub-protocol (`extension_ui_request`)
 * to ACP affordances.
 */

export type TextInputMethod = 'input' | 'editor'

type UiRequestFields = Record<string, unknown>

function text(ev: UiRequestFields, key: string): string {
  const value = ev[key]
  return typeof value === 'string' ? value : ''
}

/** Title and message of a pi dialog, joined when both are present and distinct. */
export function uiRequestPrompt(ev: UiRequestFields): string {
  const title = text(ev, 'title').trim()
  const message = text(ev, 'message').trim()
  return title && message && title !== message ? `${title}\n\n${message}` : title || message
}

/** A pi select option written as `Label — description` (em or en dash). */
export type SelectOptionParts = { title: string; description?: string }

const OPTION_DESCRIPTION_SEPARATOR = /\s+[—–]\s+/

export function parseSelectOption(option: string): SelectOptionParts {
  const match = OPTION_DESCRIPTION_SEPARATOR.exec(option)
  if (!match) return { title: option }

  const title = option.slice(0, match.index).trim()
  const description = option.slice(match.index + match[0].length).trim()
  return description ? { title, description } : { title }
}

/** Keep the concise choice on the permission button; Pi still receives the original string. */
export function selectOptionLabel(option: string): string {
  return parseSelectOption(option).title
}

/** Permission buttons do not wrap in ACP clients, so show the full choices in the wrapping body. */
export function formatSelectPrompt(prompt: string, options: string[]): string {
  if (!options.some(option => selectOptionLabel(option) !== option)) return prompt

  const lines = options.map(option => (/^\d+\.\s/.test(option) ? option : `- ${option}`))
  return [prompt, `Options:\n${lines.join('\n')}`].filter(Boolean).join('\n\n')
}

/** Property name used for the single field in pi input/editor/select elicitations. */
export const ELICITATION_TEXT_FIELD = 'value'

type FormElicitation = Omit<Extract<CreateElicitationRequest, { mode: 'form' }>, 'sessionId' | 'requestId'>

/**
 * Build an ACP form elicitation for a pi `select` request. Unlike permission buttons,
 * form choices wrap, so each option keeps its full description. Choices are keyed by
 * index so duplicate or oddly formatted option strings still map back exactly.
 */
export function buildSelectElicitation(ev: UiRequestFields, options: string[]): FormElicitation {
  return {
    mode: 'form',
    message: uiRequestPrompt(ev) || 'Choose an option',
    requestedSchema: {
      type: 'object',
      properties: {
        [ELICITATION_TEXT_FIELD]: {
          type: 'string',
          title: 'Choose one',
          oneOf: options.map((option, index) => ({ const: String(index), ...parseSelectOption(option) }))
        }
      },
      required: [ELICITATION_TEXT_FIELD]
    },
    _meta: { piAcp: { method: 'select' } }
  }
}

/** Map an accepted select elicitation back to the original pi option, or null if invalid. */
export function elicitationSelectedOption(content: unknown, options: string[]): string | null {
  const raw = elicitationTextValue(content)
  if (raw === null || !/^\d+$/.test(raw)) return null
  return options[Number(raw)] ?? null
}

/**
 * Build an ACP form elicitation for a pi `input` (single-line) or `editor` (multi-line)
 * request. The session scope is added by the caller.
 */
export function buildTextElicitation(ev: UiRequestFields, method: TextInputMethod): FormElicitation {
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
