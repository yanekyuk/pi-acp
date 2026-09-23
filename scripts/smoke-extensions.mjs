// Smoke: pi extension support over ACP.
//   1. available_commands_update includes extension commands (e.g. /mcp, /goal, /advisor)
//   2. an extension slash command (/mcp status) completes the ACP turn without an agent run
//
// Requires a real `pi` with extensions installed. Run: node scripts/smoke-extensions.mjs
import { spawn } from 'node:child_process'

const cwd = process.cwd()
const command = process.argv[2] ?? '/mcp status'

const child = spawn('node', ['dist/index.js'], { cwd, stdio: ['pipe', 'pipe', 'inherit'], env: process.env })
child.stdout.setEncoding('utf8')

const send = obj => child.stdin.write(JSON.stringify(obj) + '\n')
const fail = msg => {
  console.error(`FAIL: ${msg}`)
  child.kill('SIGTERM')
  process.exit(1)
}

send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } })
send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd, mcpServers: [] } })

let sessionId = null
let buffer = ''
const timer = setTimeout(() => fail('timed out waiting for the extension command turn to end'), 60_000)

child.stdout.on('data', chunk => {
  buffer += chunk
  const lines = buffer.split('\n')
  buffer = lines.pop() ?? ''

  for (const line of lines) {
    if (!line.trim()) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }

    if (msg?.id === 2) {
      if (!msg.result?.sessionId) fail(`session/new failed: ${JSON.stringify(msg.error ?? msg)}`)
      sessionId = msg.result.sessionId
    }

    if (msg?.method === 'session/update') {
      const update = msg.params?.update
      if (update?.sessionUpdate === 'available_commands_update') {
        const names = update.availableCommands.map(c => c.name)
        console.log(`commands (${names.length}):`, names.join(', '))
        const commandName = command.slice(1).split(' ')[0]
        if (!names.includes(commandName)) fail(`/${commandName} not advertised`)
        send({
          jsonrpc: '2.0',
          id: 3,
          method: 'session/prompt',
          params: { sessionId, prompt: [{ type: 'text', text: command }] }
        })
      } else if (update?.sessionUpdate === 'agent_message_chunk') {
        console.log('agent:', update.content?.text, update._meta ? JSON.stringify(update._meta) : '')
      } else if (update?.sessionUpdate === 'session_info_update' && update._meta?.piAcp?.status) {
        console.log('status:', JSON.stringify(update._meta.piAcp.status))
      }
    }

    if (msg?.id === 3) {
      clearTimeout(timer)
      console.log('prompt result:', JSON.stringify(msg.result ?? msg.error))
      setTimeout(() => {
        child.kill('SIGTERM')
        process.exit(msg.result?.stopReason === 'end_turn' ? 0 : 1)
      }, 50)
    }
  }
})
