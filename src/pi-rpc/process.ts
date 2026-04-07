import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import * as readline from 'node:readline'
import { pathToFileURL } from 'node:url'
import { debugLog, DEBUG_LOG_PATH } from '../debug.js'
import { getPiCommand, shouldUseShellForPiCommand } from './command.js'

export class PiRpcSpawnError extends Error {
  /** Underlying spawn error code, e.g. ENOENT, EACCES */
  code?: string

  constructor(message: string, opts?: { code?: string; cause?: unknown }) {
    super(message)
    this.name = 'PiRpcSpawnError'
    this.code = opts?.code
    ;(this as any).cause = opts?.cause
  }
}

const ESC = String.fromCharCode(0x1b)
const CSI = String.fromCharCode(0x9b)

const ANSI_ESCAPE_REGEX = new RegExp(
  `[${ESC}${CSI}][[\\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]`,
  'g'
)

function stripAnsi(s: string): string {
  // Basic ANSI escape stripping (colors, cursor movement, etc.)
  return s.replace(ANSI_ESCAPE_REGEX, '')
}

type PiRpcCommand =
  | { type: 'prompt'; id?: string; message: string; images?: unknown[] }
  | { type: 'abort'; id?: string }
  | { type: 'get_state'; id?: string }
  // Model
  | { type: 'get_available_models'; id?: string }
  | { type: 'set_model'; id?: string; provider: string; modelId: string }
  // Thinking
  | { type: 'set_thinking_level'; id?: string; level: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' }
  // Modes
  | { type: 'set_follow_up_mode'; id?: string; mode: 'all' | 'one-at-a-time' }
  | { type: 'set_steering_mode'; id?: string; mode: 'all' | 'one-at-a-time' }
  // Compaction
  | { type: 'compact'; id?: string; customInstructions?: string }
  | { type: 'set_auto_compaction'; id?: string; enabled: boolean }
  // Session
  | { type: 'get_session_stats'; id?: string }
  | { type: 'set_session_name'; id?: string; name: string }
  | { type: 'export_html'; id?: string; outputPath?: string }
  | { type: 'switch_session'; id?: string; sessionPath: string }
  // Messages
  | { type: 'get_messages'; id?: string }
  // Commands
  | { type: 'get_commands'; id?: string }

type PiRpcResponse = {
  type: 'response'
  id?: string
  command: string
  success: boolean
  data?: unknown
  error?: string
}

export type PiRpcEvent = Record<string, unknown>

type SpawnParams = {
  cwd: string
  /** Optional override for `pi` executable name/path */
  piCommand?: string
  /** If set, pi will persist the session to this exact file (via `--session <path>`). */
  sessionPath?: string
  /** Enables the bash ACP bridge extension and passes the socket path to pi. */
  bashBridgeSocketPath?: string
}

function buildPiAcpBashOverrideExtensionSource(piModuleImport: string): string {
  return `
import { createConnection } from 'node:net'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createInterface } from 'node:readline'
import { createBashTool } from ${JSON.stringify(piModuleImport)}

function logDebug(event, data) {
  try {
    const logPath = process.env.PI_ACP_DEBUG_LOG || '/tmp/pi-acp-debug.log'
    mkdirSync(dirname(logPath), { recursive: true })
    appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, event, data }) + '\\n')
  } catch {
    // ignore
  }
}

logDebug('pi-extension:loaded', { argv: process.argv, socketPath: process.env.PI_ACP_BASH_BRIDGE_SOCKET })

function formatSuccessResult(result) {
  const output = typeof result?.output === 'string' && result.output.length > 0 ? result.output : '(no output)'
  return {
    content: [{ type: 'text', text: output }],
    details: {
      exitCode: result?.exitCode ?? 0,
      ...(result?.signal ? { signal: result.signal } : {}),
      ...(result?.truncated ? { truncated: true } : {})
    }
  }
}

function formatFailureMessage(result, timeoutSeconds) {
  const output = typeof result?.output === 'string' ? result.output.trimEnd() : ''
  const suffix = result?.timedOut
    ? \`Command timed out after \${timeoutSeconds ?? 'unknown'} seconds\`
    : result?.cancelled
      ? 'Command aborted'
      : typeof result?.signal === 'string' && result.signal.length > 0
        ? \`Command terminated by signal \${result.signal}\`
        : typeof result?.exitCode === 'number'
          ? \`Command exited with code \${result.exitCode}\`
          : 'Command failed'

  return output ? \`\${output}\n\n\${suffix}\` : suffix
}

function executeViaBridge(request, signal, onUpdate) {
  return new Promise((resolve, reject) => {
    const socketPath = process.env.PI_ACP_BASH_BRIDGE_SOCKET
    logDebug('pi-extension:executeViaBridge:start', { toolCallId: request.toolCallId, command: request.command, socketPath })
    if (!socketPath) {
      reject(new Error('PI_ACP_BASH_BRIDGE_SOCKET is not configured'))
      return
    }

    const socket = createConnection(socketPath)
    const rl = createInterface({ input: socket })
    let settled = false

    const cleanup = () => {
      rl.close()
      socket.removeAllListeners()
      if (signal) signal.removeEventListener('abort', onAbort)
    }

    const finishResolve = value => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }

    const finishReject = error => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }

    const onAbort = () => {
      if (socket.destroyed) return
      socket.write(JSON.stringify({ type: 'abort' }) + '\\n')
    }

    socket.once('error', error => {
      logDebug('pi-extension:socket-error', { toolCallId: request.toolCallId, error: String(error?.message || error) })
      finishReject(error)
    })

    rl.on('error', error => {
      logDebug('pi-extension:readline-error', { toolCallId: request.toolCallId, error: String(error?.message || error) })
      finishReject(error)
    })

    socket.once('connect', () => {
      logDebug('pi-extension:socket-connect', { toolCallId: request.toolCallId })
      socket.write(JSON.stringify(request) + '\\n')
    })

    rl.on('line', line => {
      if (!line.trim()) return

      let message
      try {
        message = JSON.parse(line)
      } catch {
        finishReject(new Error('Invalid bash bridge response'))
        return
      }

      if (message?.type === 'update') {
        const text = typeof message.output === 'string' ? message.output : ''
        logDebug('pi-extension:update', { toolCallId: request.toolCallId, outputLength: text.length })
        if (!text) return
        onUpdate?.({
          content: [{ type: 'text', text }],
          details: message.truncated ? { truncated: true } : undefined
        })
        return
      }

      if (message?.type === 'result') {
        const result = message
        logDebug('pi-extension:result', { toolCallId: request.toolCallId, exitCode: result?.exitCode, signal: result?.signal, timedOut: result?.timedOut, cancelled: result?.cancelled })
        if (result?.timedOut || result?.cancelled || typeof result?.signal === 'string' || (typeof result?.exitCode === 'number' && result.exitCode !== 0)) {
          finishReject(new Error(formatFailureMessage(result, request.timeout)))
          return
        }
        finishResolve(formatSuccessResult(result))
        return
      }

      if (message?.type === 'error') {
        logDebug('pi-extension:error', { toolCallId: request.toolCallId, message: message.message })
        finishReject(new Error(typeof message.message === 'string' ? message.message : 'Bash bridge error'))
        return
      }

      finishReject(new Error('Unknown bash bridge response'))
    })

    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

export default function (pi) {
  const originalBash = createBashTool(process.cwd())

  pi.registerTool({
    name: 'bash',
    label: 'bash',
    description: originalBash.description,
    parameters: originalBash.parameters,
    prepareArguments: originalBash.prepareArguments,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      logDebug('pi-extension:bash-execute', { toolCallId, command: params.command, cwd: ctx.cwd, hasSocket: Boolean(process.env.PI_ACP_BASH_BRIDGE_SOCKET) })
      try {
        return await executeViaBridge({
          type: 'bash_execute',
          toolCallId,
          command: params.command,
          timeout: params.timeout,
          cwd: ctx.cwd
        }, signal, onUpdate)
      } catch (error) {
        logDebug('pi-extension:bash-execute-error', { toolCallId, error: String(error?.message || error) })
        if (process.env.PI_ACP_BASH_BRIDGE_SOCKET) throw error
        return await originalBash.execute(toolCallId, params, signal, onUpdate)
      }
    }
  })
}
`
}

function resolvePiCliPath(cmd: string): string | null {
  const directPath = cmd.includes('/') || cmd.includes('\\') ? cmd : null
  const discoveredPath = directPath
    ? directPath
    : (() => {
        const lookup = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8' })
        if (lookup.status !== 0) return null
        const first = lookup.stdout
          .split(/\r?\n/)
          .map(line => line.trim())
          .find(Boolean)
        return first ?? null
      })()

  if (!discoveredPath) return null

  try {
    return realpathSync(discoveredPath)
  } catch {
    return null
  }
}

function resolvePiModuleImport(cmd: string): string | null {
  const cliPath = resolvePiCliPath(cmd)
  if (!cliPath) return null

  const indexPath = join(dirname(cliPath), 'index.js')
  if (!existsSync(indexPath)) return null
  return pathToFileURL(indexPath).href
}

let piAcpBashOverrideExtensionPath: string | null = null
let piAcpBashOverrideExtensionImport: string | null = null

function ensurePiAcpBashOverrideExtension(cmd: string): string {
  const piModuleImport = resolvePiModuleImport(cmd)
  if (!piModuleImport) {
    throw new PiRpcSpawnError(`Could not resolve pi module path for bash override injection (command: ${cmd}).`)
  }

  if (piAcpBashOverrideExtensionPath && piAcpBashOverrideExtensionImport === piModuleImport) {
    return piAcpBashOverrideExtensionPath
  }

  const path = join(tmpdir(), 'pi-acp-bash-override-extension.ts')
  writeFileSync(path, buildPiAcpBashOverrideExtensionSource(piModuleImport), 'utf8')
  piAcpBashOverrideExtensionPath = path
  piAcpBashOverrideExtensionImport = piModuleImport
  debugLog('pi-rpc:write-extension', { path, piModuleImport })
  return path
}

export class PiRpcProcess {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<string, { resolve: (v: PiRpcResponse) => void; reject: (e: unknown) => void }>()
  private eventHandlers: Array<(ev: PiRpcEvent) => void> = []
  private readonly preludeLines: string[] = []

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child

    const rl = readline.createInterface({ input: child.stdout })
    rl.on('line', line => {
      if (!line.trim()) return
      let msg: any
      try {
        msg = JSON.parse(line)
      } catch {
        // pi may emit a human-readable prelude on stdout before NDJSON starts.
        // Capture it so the ACP adapter can surface it on session start.
        const cleaned = stripAnsi(String(line)).trimEnd()
        if (cleaned) this.preludeLines.push(cleaned)
        return
      }

      if (msg?.type === 'message_update' || msg?.type === 'tool_execution_start' || msg?.type === 'tool_execution_update' || msg?.type === 'tool_execution_end' || msg?.type === 'agent_start' || msg?.type === 'agent_end') {
        debugLog('pi-rpc:stdout-event', {
          type: msg?.type,
          toolCallId: msg?.toolCallId,
          toolName: msg?.toolName,
          assistantMessageEventType: msg?.assistantMessageEvent?.type
        })
      }

      if (msg?.type === 'response') {
        debugLog('pi-rpc:response', { id: msg?.id, command: msg?.command, success: msg?.success })
        const id = typeof msg.id === 'string' ? msg.id : undefined
        if (id) {
          const pending = this.pending.get(id)
          if (pending) {
            this.pending.delete(id)
            pending.resolve(msg as PiRpcResponse)
            return
          }
        }
      }

      for (const h of this.eventHandlers) h(msg as PiRpcEvent)
    })

    child.on('exit', (code, signal) => {
      debugLog('pi-rpc:exit', { code, signal })
      const err = new Error(`pi process exited (code=${code}, signal=${signal})`)
      for (const [, p] of this.pending) p.reject(err)
      this.pending.clear()
    })

    child.on('error', err => {
      debugLog('pi-rpc:error', { error: err })
      for (const [, p] of this.pending) p.reject(err)
      this.pending.clear()
    })
  }

  static async spawn(params: SpawnParams): Promise<PiRpcProcess> {
    // On Windows, npm commonly creates pi.cmd / pi.bat launcher scripts.
    const cmd = getPiCommand(params.piCommand)

    // Speed/robustness for ACP:
    // - themes are irrelevant in rpc mode and can be noisy/slow to load.
    // Keep extensions + prompt templates enabled because ACP users may rely on them
    // (e.g. MCP extensions, prompt templates for workflows).
    const args = ['--mode', 'rpc', '--no-themes']
    if (params.bashBridgeSocketPath) {
      args.push('-e', ensurePiAcpBashOverrideExtension(cmd))
    }
    if (params.sessionPath) args.push('--session', params.sessionPath)

    debugLog('pi-rpc:spawn', {
      cmd,
      args,
      cwd: params.cwd,
      bashBridgeSocketPath: params.bashBridgeSocketPath,
      debugLogPath: DEBUG_LOG_PATH
    })

    const child = spawn(cmd, args, {
      cwd: params.cwd,
      stdio: 'pipe',
      env: {
        ...process.env,
        PI_ACP_DEBUG_LOG: process.env.PI_ACP_DEBUG_LOG || DEBUG_LOG_PATH,
        ...(params.bashBridgeSocketPath ? { PI_ACP_BASH_BRIDGE_SOCKET: params.bashBridgeSocketPath } : {})
      },
      shell: shouldUseShellForPiCommand(cmd)
    })

    // Ensure spawn failures (e.g. ENOENT when pi isn't installed) are surfaced as a
    // deterministic error instead of later EPIPE/internal-error noise.
    try {
      await new Promise<void>((resolve, reject) => {
        const onSpawn = () => {
          cleanup()
          resolve()
        }
        const onError = (err: any) => {
          cleanup()
          reject(err)
        }
        const cleanup = () => {
          child.off('spawn', onSpawn)
          child.off('error', onError)
        }

        child.once('spawn', onSpawn)
        child.once('error', onError)
      })
    } catch (e: any) {
      const code = typeof e?.code === 'string' ? e.code : undefined
      if (code === 'ENOENT') {
        throw new PiRpcSpawnError(
          `Could not start pi: executable not found (command: ${cmd}). Pi needs to be installed before it can run in ACP clients. Install it via \`npm install -g @mariozechner/pi-coding-agent\` or ensure \`pi\` is on your PATH. Then try again.`,
          { code, cause: e }
        )
      }

      if (code === 'EACCES') {
        throw new PiRpcSpawnError(`Could not start pi: permission denied (command: ${cmd}).`, { code, cause: e })
      }

      throw new PiRpcSpawnError(`Could not start pi (command: ${cmd}).`, { code, cause: e })
    }

    child.stderr.on('data', chunk => {
      debugLog('pi-rpc:stderr', { text: String(chunk) })
      // leave stderr untouched; ACP clients may capture it.
    })

    const proc = new PiRpcProcess(child)

    // Best-effort handshake.
    // Important: pi may emit a get_state response pointing at a sessionFile in a directory
    // that is created lazily. Create the parent dir up-front to avoid later parse errors
    // when we call commands like export_html.
    try {
      const state = (await proc.getState()) as any
      const sessionFile = typeof state?.sessionFile === 'string' ? state.sessionFile : null
      if (sessionFile) {
        const { mkdirSync } = await import('node:fs')
        const { dirname } = await import('node:path')
        mkdirSync(dirname(sessionFile), { recursive: true })
      }
    } catch {
      // ignore for now
    }

    return proc
  }

  onEvent(handler: (ev: PiRpcEvent) => void): () => void {
    this.eventHandlers.push(handler)
    return () => {
      this.eventHandlers = this.eventHandlers.filter(h => h !== handler)
    }
  }

  dispose(signal: NodeJS.Signals | number = 'SIGTERM'): void {
    if (this.child.killed) return
    try {
      this.child.kill(signal as any)
    } catch {
      // ignore
    }
  }

  /**
   * Human-readable stdout lines emitted before RPC NDJSON begins (e.g. Context/Skills/Extensions info).
   * Themes are typically noisy/less useful for ACP, so callers can filter as needed.
   */
  consumePreludeLines(): string[] {
    const lines = this.preludeLines.splice(0, this.preludeLines.length)
    return lines
  }

  async prompt(message: string, images: unknown[] = []): Promise<void> {
    const res = await this.request({ type: 'prompt', message, images })
    if (!res.success) throw new Error(`pi prompt failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async abort(): Promise<void> {
    const res = await this.request({ type: 'abort' })
    if (!res.success) throw new Error(`pi abort failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async getState(): Promise<unknown> {
    const res = await this.request({ type: 'get_state' })
    if (!res.success) throw new Error(`pi get_state failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async getAvailableModels(): Promise<unknown> {
    const res = await this.request({ type: 'get_available_models' })
    if (!res.success) throw new Error(`pi get_available_models failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async setModel(provider: string, modelId: string): Promise<unknown> {
    const res = await this.request({ type: 'set_model', provider, modelId })
    if (!res.success) throw new Error(`pi set_model failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async setThinkingLevel(level: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'): Promise<void> {
    const res = await this.request({ type: 'set_thinking_level', level })
    if (!res.success) throw new Error(`pi set_thinking_level failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async setFollowUpMode(mode: 'all' | 'one-at-a-time'): Promise<void> {
    const res = await this.request({ type: 'set_follow_up_mode', mode })
    if (!res.success) throw new Error(`pi set_follow_up_mode failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async setSteeringMode(mode: 'all' | 'one-at-a-time'): Promise<void> {
    const res = await this.request({ type: 'set_steering_mode', mode })
    if (!res.success) throw new Error(`pi set_steering_mode failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async compact(customInstructions?: string): Promise<unknown> {
    const res = await this.request({ type: 'compact', customInstructions })
    if (!res.success) throw new Error(`pi compact failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async setAutoCompaction(enabled: boolean): Promise<void> {
    const res = await this.request({ type: 'set_auto_compaction', enabled })
    if (!res.success) throw new Error(`pi set_auto_compaction failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async getSessionStats(): Promise<unknown> {
    const res = await this.request({ type: 'get_session_stats' })
    if (!res.success) throw new Error(`pi get_session_stats failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async setSessionName(name: string): Promise<void> {
    const res = await this.request({ type: 'set_session_name', name })
    if (!res.success) throw new Error(`pi set_session_name failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async exportHtml(outputPath?: string): Promise<{ path: string }> {
    const res = await this.request({ type: 'export_html', outputPath })
    if (!res.success) throw new Error(`pi export_html failed: ${res.error ?? JSON.stringify(res.data)}`)
    const data: any = res.data
    return { path: String(data?.path ?? '') }
  }

  async switchSession(sessionPath: string): Promise<void> {
    const res = await this.request({ type: 'switch_session', sessionPath })
    if (!res.success) throw new Error(`pi switch_session failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async getMessages(): Promise<unknown> {
    const res = await this.request({ type: 'get_messages' })
    if (!res.success) throw new Error(`pi get_messages failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async getCommands(): Promise<unknown> {
    const res = await this.request({ type: 'get_commands' })
    if (!res.success) throw new Error(`pi get_commands failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  private request(cmd: PiRpcCommand): Promise<PiRpcResponse> {
    const id = crypto.randomUUID()
    const withId = { ...cmd, id }

    debugLog('pi-rpc:request', { type: cmd.type, id })

    const line = JSON.stringify(withId) + '\n'

    return new Promise<PiRpcResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })

      try {
        this.child.stdin.write(line, err => {
          if (err) {
            this.pending.delete(id)
            reject(err)
          }
        })
      } catch (e) {
        this.pending.delete(id)
        reject(e)
      }
    })
  }
}
