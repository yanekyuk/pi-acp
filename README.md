# pi-acp

ACP ([Agent Client Protocol](https://agentclientprotocol.com/overview/introduction)) adapter for [`pi`](https://github.com/earendil-works/pi) coding agent (fka shitty coding agent).

`pi-acp` communicates **ACP JSON-RPC 2.0 over stdio** to an ACP client (e.g. Zed editor) and spawns `pi --mode rpc`, bridging requests/events between the two.

## Status

This is an MVP-style adapter intended to be useful today and easy to iterate on. Some ACP features may be not implemented or are not supported (see [Limitations](#limitations)). Development is centered around [Zed](https://zed.dev) editor support, other clients may have varying levels of compatibility.

Expect some minor breaking changes.

## Features

- Streams assistant output as ACP `agent_message_chunk`
- Maps pi tool execution to ACP `tool_call` / `tool_call_update`
  - Tool call locations are surfaced when available for ACP clients that support opening the referenced file/context
  - Relative file paths from pi are resolved against the session cwd before being emitted as ACP tool locations, which enables follow-along features in clients like Zed
  - For `edit`, `pi-acp` attempts to infer a 1-based line number from a unique `oldText` match in the pre-edit file snapshot and includes it in the emitted tool location when possible
  - For `edit`, `pi-acp` snapshots the file before the tool runs and emits an ACP **structured diff** (`oldText`/`newText`) on completion when possible
- ACP filesystem delegation (`fs/read_text_file`, `fs/write_text_file`)
  - When the client advertises `fs.writeTextFile`, `pi-acp` loads a small pi extension (`dist/acp-fs-extension.js`) that overrides pi's built-in `read`/`edit`/`write` tools and routes file contents through the ACP client over a local socket. This is what makes editors like Zed list the files edited by the session (Keep All / Reject All), edit against unsaved buffer contents, and follow the agent's location. If the client rejects an operation (e.g. a path outside the open project), the tool falls back to the local filesystem.
- Session persistence
  - pi stores its own sessions in `~/.pi/agent/sessions/...`
  - `pi-acp` stores a small mapping file at `~/.pi/pi-acp/session-map.json` so `session/load` can reattach to a previous pi session file
- Slash commands
  - Loads file-based slash commands compatible with pi’s conventions
  - Adds a small set of built-in commands for headless/editor usage
  - Supports skill commands (if enabled in pi settings, they appear as `/skill:skill-name` in the ACP client)
- Skills are loaded by pi directly and are available in ACP sessions
- Pi extensions (see [Extensions](#extensions))
  - Extension slash commands (e.g. `/mcp`, `/goal`, `/advisor`, `/subagents`) are advertised to the client and run through pi
  - Extension dialogs map to ACP: `select`/`confirm` → permission prompts, `input`/`editor` → ACP elicitation (or a chat reply when the client lacks it), `notify`/`setStatus` → tagged messages/metadata
  - The `todo` tool (rpiv-todo) is mirrored into the ACP **plan** view; other well-known extension tools get proper ACP tool kinds and human-readable titles
- (Zed) `pi-acp` emits “startup info” block into the session (pi version, context, skills, prompts, extensions - similar to `pi` in the terminal). You can disable it by setting `quietStartup: true` in pi settings (`~/.pi/agent/settings.json` or `<project>/.pi/settings.json`). When `quietStartup` is enabled, `pi-acp` will still emit a 'New version available' message if the installed pi version is outdated.
- (Zed) Session history is supported in Zed starting with [`v0.225.0`](https://zed.dev/releases/preview/0.225.0). Session loading / history maps to pi's session files. Sessions can be resumed both in `pi` and in the ACP client.

## Prerequisites

Make sure pi is installed

```bash
npm install -g @earendil-works/pi-coding-agent
```

- Node.js 22+
- `pi` v0.80.4+ installed and available on your `PATH` (the adapter runs the `pi` executable)
- Configure `pi` separately for your model providers/API keys

## Install

### Add pi-acp to your ACP client, e.g. [Zed](https://zed.dev/docs/agents/external-agents/)

#### Using ACP Registry in Zed or other clients that support it:

In Zed launch the registry with `zed: acp registry` command and select `pi ACP` adapter from the list. This will automatically add the agent server configuration to your `settings.json` and keep it up to date:

```json
  "agent_servers": {
    "pi-acp": {
      "type": "registry",
    },
  }
```

#### Using with `npx` (no global install needed, always loads the latest version):

Add the following to your Zed `settings.json`:

```json
  "agent_servers": {
    "pi": {
      "type": "custom",
      "command": "npx",
      "args": ["-y", "pi-acp"],
      "env": {}
    }
  }
```

#### Global install

```bash
npm install -g pi-acp
```

```json
  "agent_servers": {
    "pi": {
      "type": "custom",
      "command": "pi-acp",
      "args": [],
      "env": {}
    }
  }
```

#### From source

```bash
npm install
npm run build
```

Point your ACP client to the built `dist/index.js`:

```json
  "agent_servers": {
    "pi": {
      "type": "custom",
      "command": "node",
      "args": ["/path/to/pi-acp/dist/index.js"],
      "env": {}
    }
  }
```

### Environment variables

- `PI_ACP_ENABLE_EMBEDDED_CONTEXT=true` advertises ACP `promptCapabilities.embeddedContext` support to the client.
- Default: unset/any other value means `false`.
- When disabled, compliant ACP clients should avoid sending embedded `resource` blocks. If they send them anyway, `pi-acp` still degrades gracefully by converting them into plain-text prompt context.

You can add the environment variable in the Zed settings with:

```json
  "agent_servers": {
    "pi": {
      "type": "custom",
      "command": "node",
      "args": ["/path/to/pi-acp/dist/index.js"],
      "env": {
          "PI_ACP_ENABLE_EMBEDDED_CONTEXT": "true",
      }
    }
  }
```

### Slash commands

`pi-acp` supports slash commands:

#### 1) File-based commands (aka prompts)

Loaded from:

- User commands: `~/.pi/agent/prompts/**/*.md`
- Project commands: `<cwd>/.pi/prompts/**/*.md`

#### 2) Built-in commands

- `/compact [instructions...]` – run pi compaction (optionally with custom instructions)
- `/autocompact on|off|toggle` – toggle automatic compaction
- `/export` – export the current session to HTML in the session `cwd`
- `/session` – show session stats (tokens/messages/cost/session file)
- `/name <name>` – set session display name
- `/queue all|one-at-a-time` – set pi queue mode (unstable feature)
- `/changelog` – print the installed pi changelog (best-effort)
- `/steering` - maps to `pi` Steering Mode, get/set
- `/follow-up` - pats to `pi` Follow-up Mode, get/set

Other built-in commands:

- `/model` - not implemented (use the model selector UI in Zed)
- `/thinking` - maps to 'mode' selector in Zed
- `/clear` - not implemented (use ACP client 'new' command)

#### 3) Skill commands

- Skill commands can be enabled in pi settings and will appear in the slash command list in ACP client as `/skill:skill-name`.

#### 4) Extension commands

- Slash commands registered by pi extensions (`pi.registerCommand`) are advertised to the client and executed by pi. Output the extension emits via `ctx.ui.notify()` is shown in the chat.
- Commands that only work with pi's terminal overlay UI (`ctx.ui.custom()`), such as `/btw`, are not offered because they cannot render in an ACP client.

### Extensions

`pi-acp` runs pi with its extensions enabled and translates their UI to ACP. It has been verified with:

| Extension                                                      | What you get in the ACP client                                                                                                                             |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter) | `mcp`/`mcpScript` tool calls with titles like `MCP: <tool>`; `/mcp`, `/mcp-auth` commands; OAuth/elicitation prompts as permission requests                |
| `@juicesharp/rpiv-advisor`                                     | `advisor` calls shown as **think** tool calls (`Consult advisor`) with streamed status; `/advisor` command                                                 |
| `@juicesharp/rpiv-args`                                        | `/skill:<name> <args>` argument substitution works transparently                                                                                           |
| `@juicesharp/rpiv-ask-user-question`                           | Questions render as permission prompts; "Type something." and multi-select answers use ACP elicitation, or a chat reply on clients without it              |
| `@juicesharp/rpiv-btw`                                         | `/btw` is hidden (requires pi's terminal overlay)                                                                                                          |
| `@juicesharp/rpiv-todo`                                        | Every `todo` call updates the ACP **plan** view (pending / in progress / completed); `/todos` command                                                      |
| `@juicesharp/rpiv-web-tools`                                   | `web_search` → **search** (`Search: <query>`), `web_fetch` → **fetch** (`Fetch <url>`); `/web-tools` command                                               |
| [pi-subagents](https://github.com/nicobailon/pi-subagents)     | `subagent` calls titled by agent/workflow (`Subagent: scout (async)`), background run notices shown in chat, `/subagents-*` commands                       |
| `@narumitw/pi-goal`                                            | `/goal` command and confirmations; goal status published as `session_info_update` metadata (`_meta.piAcp.status`); `goal_*` tools shown as **think** calls |

How pi extension UI maps to ACP:

| pi `ctx.ui` call                                       | ACP                                                                                                                                                                                                                            |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `select(title, options)`                               | `session/request_permission` with one option per choice                                                                                                                                                                        |
| `confirm(title, message)`                              | `session/request_permission` with Yes/No                                                                                                                                                                                       |
| `input(title, placeholder)` / `editor(title, prefill)` | `session/create_elicitation` (form, when the client advertises `clientCapabilities.elicitation.form`); otherwise pi-acp asks in chat and uses the user's **next message** as the answer (cancel with the client's stop button) |
| `notify(message, type)`                                | `agent_message_chunk` tagged with `_meta.piAcp.notify.level`                                                                                                                                                                   |
| `setStatus(key, text)`                                 | `session_info_update` with `_meta.piAcp.status`                                                                                                                                                                                |
| `setTitle(title)`                                      | `session_info_update` with the new title                                                                                                                                                                                       |
| `setWidget`, `set_editor_text`, `custom`               | not representable in ACP; ignored                                                                                                                                                                                              |

Extension messages (`pi.sendMessage` with `display: true`) and extension errors are surfaced as chat messages.

## Authentication (ACP Registry support)

This agent supports **Terminal Auth** for the [ACP Registry](https://agentclientprotocol.com/get-started/registry).
In Zed, this will show an **Authenticate** banner that launches pi in a terminal.
Launch pi in a terminal for interactive login/setup:

```bash
pi-acp --terminal-login
```

Your ACP client can also invoke this automatically based on the agent's advertised `authMethods`.

## Development

```bash
npm install
npm run dev        # run from src via tsx
npm run build
npm run lint
npm run test
```

Project layout:

- `src/acp/*` – ACP server + translation layer
- `src/pi-rpc/*` – pi subprocess wrapper (RPC protocol) and the FS bridge socket server
- `src/pi-extension/*` – pi extension loaded into the pi subprocess (built separately to `dist/acp-fs-extension.js`)

## Limitations

- No ACP terminal delegation (`terminal/*`); pi executes commands locally. File reads/writes go through the client only for pi's built-in `read`/`edit`/`write` tools; `bash` and other tools still touch the disk directly.
- MCP servers are accepted in ACP params and stored in session state, but not wired through to pi in this adapter. If you use [pi MCP adapter](https://github.com/nicobailon/pi-mcp-adapter) it will be available in the ACP client.
- Assistant streaming is currently sent as `agent_message_chunk` (no separate thought stream).
- Extension commands that depend on pi's terminal overlay (`ctx.ui.custom()`), e.g. `/btw` or `/mcp setup`, cannot render in ACP clients; pi-acp hides `/btw` and pi reports the limitation for others.
- Queue is implemented client-side and should work like pi's `one-at-a-time`
- ~~ACP clients don't yet suport session history, but ACP sessions from `pi-acp` can be `/resume`d in pi directly~~

## License

MIT (see [LICENSE](LICENSE)).
