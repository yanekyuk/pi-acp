/**
 * Minimal typings for the parts of pi's extension API used by pi-acp extensions.
 *
 * The extension runs inside the pi subprocess, where pi aliases this module
 * specifier to its own installation, so pi-acp does not depend on the package.
 * Shapes mirror @earendil-works/pi-coding-agent (core/tools/{read,edit,write}.ts).
 */
declare module '@earendil-works/pi-coding-agent' {
  export interface ReadOperations {
    readFile: (absolutePath: string) => Promise<Buffer>
    access: (absolutePath: string) => Promise<void>
    detectImageMimeType?: (absolutePath: string) => Promise<string | null | undefined>
  }

  export interface EditOperations {
    readFile: (absolutePath: string) => Promise<Buffer>
    writeFile: (absolutePath: string, content: string) => Promise<void>
    access: (absolutePath: string) => Promise<void>
  }

  export interface WriteOperations {
    writeFile: (absolutePath: string, content: string) => Promise<void>
    mkdir: (dir: string) => Promise<void>
  }

  /** Opaque built-in tool definition (schema, execute, renderers, prompt metadata). */
  export interface ToolDefinition {
    name: string
    label: string
    description: string
  }

  export function createReadToolDefinition(cwd: string, options?: { operations?: ReadOperations }): ToolDefinition
  export function createEditToolDefinition(cwd: string, options?: { operations?: EditOperations }): ToolDefinition
  export function createWriteToolDefinition(cwd: string, options?: { operations?: WriteOperations }): ToolDefinition

  /** pi-tui component returned by `ctx.ui.custom()` factories. */
  export interface Component {
    render(width: number): string[]
    dispose?(): void
  }

  export type CustomUIFactory<T> = (
    tui: unknown,
    theme: unknown,
    keybindings: unknown,
    done: (result: T) => void
  ) => Component | Promise<Component>

  export interface ExtensionUIContext {
    readonly theme: unknown
    select(title: string, options: string[]): Promise<string | undefined>
    /** Pi types this as `Promise<T>`, but RPC mode resolves `undefined` without rendering. */
    custom<T>(factory: CustomUIFactory<T>, options?: unknown): Promise<T | undefined>
  }

  export interface ExtensionContext {
    model?: { provider: string }
    modelRegistry: {
      isUsingOAuth(model: { provider: string }): boolean
      /** Runtime-private model runtime; not part of pi's public extension API. */
      runtime?: unknown
    }
  }

  export interface SessionStartContext extends ExtensionContext {
    hasUI: boolean
    ui: ExtensionUIContext
  }

  export interface ExtensionAPI {
    registerTool(tool: ToolDefinition): void
    on(
      event: 'before_provider_request',
      handler: (event: { payload: unknown }, ctx: ExtensionContext) => unknown
    ): () => void
    on(event: 'session_start', handler: (event: unknown, ctx: SessionStartContext) => unknown): () => void
  }
}

/** pi-tui classes observed by the custom-select bridge; pi aliases this module like the one above. */
declare module '@earendil-works/pi-tui' {
  export class SelectList {
    render(width: number): string[]
  }

  export class Text {
    render(width: number): string[]
  }
}
