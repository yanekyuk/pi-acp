import { spawn } from 'node:child_process'
import { getPiCommand, shouldUseShellForPiCommand } from '../pi-rpc/command.js'

const ESC = String.fromCharCode(0x1b)
const CSI = String.fromCharCode(0x9b)
const ANSI_ESCAPE_REGEX = new RegExp(
  `[${ESC}${CSI}][[\\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]`,
  'g'
)

const MAX_TITLE_LENGTH = 80
const DEFAULT_TIMEOUT_MS = 15_000

export function cleanTitle(raw: string): string | null {
  const noAnsi = raw.replace(ANSI_ESCAPE_REGEX, '')

  const firstLine = noAnsi
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(line => Boolean(line))

  if (!firstLine) return null

  let cleaned = firstLine
    .replace(/^#+\s*/, '')
    .replace(/^[-*•]\s+/, '')
    .replace(/^\d+[.)]\s+/, '')
    .replace(/[*_`]/g, '')
    .replace(/^["'“”‘’«»]+|["'“”‘’«»]+$/g, '')
    .trim()

  cleaned = cleaned
    .replace(/^(?:title|subject|topic|session(?:\s+name)?|summary)\s*:\s*/i, '')
    .replace(/[*_`]/g, '')
    .replace(/^["'“”‘’«»]+|["'“”‘’«»]+$/g, '')
    .replace(/[\s.:,;-]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()

  if (!cleaned) return null

  if (cleaned.length > MAX_TITLE_LENGTH) {
    const truncated = cleaned.slice(0, MAX_TITLE_LENGTH)
    const lastSpace = truncated.lastIndexOf(' ')
    cleaned = (lastSpace > 20 ? truncated.slice(0, lastSpace) : truncated).trim()
  }

  return cleaned || null
}

export function deriveFallbackTitle(userMessage: string): string {
  const noAnsi = userMessage.replace(ANSI_ESCAPE_REGEX, '')

  const lines = noAnsi.split(/\r?\n/).map(l => l.trim())

  let inCodeBlock = false
  let candidate = ''

  for (const line of lines) {
    if (line.startsWith('```') || line.startsWith('~~~')) {
      inCodeBlock = !inCodeBlock
      continue
    }
    if (!inCodeBlock && line.length > 0) {
      candidate = line
      break
    }
  }

  if (!candidate) return 'New Session'

  let text = candidate
    .replace(/^#+\s*/, '')
    .replace(/^[-*•>]\s+/, '')
    .replace(/^\d+[.)]\s+/, '')
    .replace(/[*_`]/g, '')
    .trim()

  let prev = ''
  while (prev !== text) {
    prev = text
    text = text
      .replace(
        /^(?:can\s+you(?:\s+please)?|could\s+you(?:\s+please)?|please|help\s+me(?:\s+to)?|i\s+need\s+to|i\s+want\s+to|how\s+(?:do|can)\s+i)\s+/i,
        ''
      )
      .trim()
  }

  if (!text) return 'New Session'

  text = text.charAt(0).toUpperCase() + text.slice(1)

  if (text.length > 50) {
    const slice = text.slice(0, 50)
    const lastSpace = slice.lastIndexOf(' ')
    text = (lastSpace > 15 ? slice.slice(0, lastSpace) : slice).trim()
  }

  return text || 'New Session'
}

export function buildTitlePrompt(context: { userMessage: string; assistantMessage?: string }): string {
  const user = context.userMessage.trim().slice(0, 500)
  const assistant = context.assistantMessage ? context.assistantMessage.trim().slice(0, 500) : ''

  const lines = [
    'Generate a concise, descriptive title (3 to 6 words) for this conversation in the language of the conversation.',
    'Respond with ONLY the title. Do not include quotes, markdown formatting, colons, or trailing punctuation.',
    '',
    'Conversation:',
    `User: ${user}`
  ]

  if (assistant) {
    lines.push(`Assistant: ${assistant}`)
  }

  return lines.join('\n')
}

export type TitleOptions = {
  userMessage: string
  assistantMessage?: string
  cwd?: string
  model?: string
  piCommand?: string
  timeoutMs?: number
  spawnProcess?: typeof spawn
}

export async function generateTitle(options: TitleOptions): Promise<string> {
  const userMessage = options.userMessage.trim()
  if (!userMessage) return 'New Session'

  const piCmd = options.piCommand ?? getPiCommand()
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const spawnFn = options.spawnProcess ?? spawn

  const promptText = buildTitlePrompt({
    userMessage,
    assistantMessage: options.assistantMessage
  })

  const args = [
    '-p',
    '--no-tools',
    '--no-session',
    '--no-extensions',
    '--no-skills',
    '--no-prompt-templates',
    '--thinking',
    'off'
  ]

  if (options.model) {
    args.push('--model', options.model)
  }

  const shell = shouldUseShellForPiCommand(piCmd)

  return await new Promise<string>(resolve => {
    let child: ReturnType<typeof spawnFn>
    try {
      child = spawnFn(piCmd, args, {
        cwd: options.cwd,
        shell,
        stdio: ['pipe', 'pipe', 'pipe']
      })
    } catch {
      resolve(deriveFallbackTitle(userMessage))
      return
    }

    let stdout = ''
    let settled = false

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // ignore kill error
      }
      finish(deriveFallbackTitle(userMessage))
    }, timeoutMs)

    function finish(result: string) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    child.stdin?.on('error', () => {})
    child.stdin?.end(promptText)
    child.stderr?.resume()
    child.stdout?.on('data', chunk => {
      stdout += String(chunk)
    })

    child.on('error', () => {
      finish(deriveFallbackTitle(userMessage))
    })

    child.on('close', code => {
      if (code === 0) {
        const cleaned = cleanTitle(stdout)
        if (cleaned) {
          finish(cleaned)
          return
        }
      }
      finish(deriveFallbackTitle(userMessage))
    })
  })
}
