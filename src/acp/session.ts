import type {
  AgentSideConnection,
  ContentBlock,
  McpServer,
  SessionUpdate,
  ToolCallContent,
  ToolCallLocation,
  ToolKind,
  TerminalHandle
} from '@agentclientprotocol/sdk'
import { RequestError } from '@agentclientprotocol/sdk'
import { maybeAuthRequiredError } from './auth-required.js'
import { readFileSync } from 'node:fs'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import { PiRpcProcess, PiRpcSpawnError, type PiRpcEvent } from '../pi-rpc/process.js'
import { BashBridgeServer, type BashBridgeExecuteRequest, type BashBridgeExecutionContext } from './bash-bridge.js'
import { SessionStore } from './session-store.js'
import { toolResultToText } from './translate/pi-tools.js'
import { expandSlashCommand, type FileSlashCommand } from './slash-commands.js'
import { debugLog } from '../debug.js'

type SessionCreateParams = {
  cwd: string
  mcpServers: McpServer[]
  conn: AgentSideConnection
  fileCommands?: import('./slash-commands.js').FileSlashCommand[]
  piCommand?: string
  supportsTerminal?: boolean
  bashBridge?: BashBridgeServer
}

export type StopReason = 'end_turn' | 'cancelled' | 'error'

type PendingTurn = {
  resolve: (reason: StopReason) => void
  reject: (err: unknown) => void
}

type QueuedTurn = {
  message: string
  images: unknown[]
  resolve: (reason: StopReason) => void
  reject: (err: unknown) => void
}

type BashTerminalExecution = {
  terminal: TerminalHandle
  lastOutput: string
}

function findUniqueLineNumber(text: string, needle: string): number | undefined {
  if (!needle) return undefined

  const first = text.indexOf(needle)
  if (first < 0) return undefined

  const second = text.indexOf(needle, first + needle.length)
  if (second >= 0) return undefined

  let line = 1
  for (let i = 0; i < first; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1
  }
  return line
}

function toToolCallLocations(args: unknown, cwd: string, line?: number): ToolCallLocation[] | undefined {
  const path = typeof (args as { path?: unknown } | null | undefined)?.path === 'string' ? (args as { path: string }).path : undefined
  if (!path) return undefined

  const resolvedPath = isAbsolute(path) ? path : resolvePath(cwd, path)
  return [{ path: resolvedPath, ...(typeof line === 'number' ? { line } : {}) }]
}

export class SessionManager {
  private sessions = new Map<string, PiAcpSession>()
  private readonly store = new SessionStore()

  /** Dispose all sessions and their underlying pi subprocesses. */
  disposeAll(): void {
    for (const [id] of this.sessions) this.close(id)
  }

  /** Get a registered session if it exists (no throw). */
  maybeGet(sessionId: string): PiAcpSession | undefined {
    return this.sessions.get(sessionId)
  }

  /**
   * Dispose a session's underlying pi process and remove it from the manager.
   * Used when clients explicitly reload a session and we want a fresh pi subprocess.
   */
  close(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    try {
      void s.dispose?.()
      s.proc.dispose?.()
    } catch {
      // ignore
    }
    this.sessions.delete(sessionId)
  }

  /** Close all sessions except the one with `keepSessionId`. */
  closeAllExcept(keepSessionId: string): void {
    for (const [id] of this.sessions) {
      if (id === keepSessionId) continue
      this.close(id)
    }
  }

  async create(params: SessionCreateParams): Promise<PiAcpSession> {
    // Let pi manage session persistence in its default location (~/.pi/agent/sessions/...)
    // so sessions are visible to the regular `pi` CLI.
    const bashBridge = params.bashBridge ?? (params.supportsTerminal ? await BashBridgeServer.create() : undefined)

    let proc: PiRpcProcess
    try {
      proc = await PiRpcProcess.spawn({
        cwd: params.cwd,
        piCommand: params.piCommand,
        bashBridgeSocketPath: bashBridge?.socketPath
      })
    } catch (e) {
      await bashBridge?.dispose().catch(() => undefined)
      if (e instanceof PiRpcSpawnError) {
        throw RequestError.internalError({ code: e.code }, e.message)
      }
      throw e
    }

    let state: any = null
    try {
      state = (await proc.getState()) as any
    } catch {
      state = null
    }

    const sessionId = typeof state?.sessionId === 'string' ? state.sessionId : crypto.randomUUID()
    const sessionFile = typeof state?.sessionFile === 'string' ? state.sessionFile : null

    if (sessionFile) {
      this.store.upsert({ sessionId, cwd: params.cwd, sessionFile })
    }

    const session = new PiAcpSession({
      sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      proc,
      conn: params.conn,
      fileCommands: params.fileCommands ?? [],
      supportsTerminal: params.supportsTerminal ?? false,
      bashBridge
    })

    this.sessions.set(sessionId, session)
    return session
  }

  get(sessionId: string): PiAcpSession {
    const s = this.sessions.get(sessionId)
    if (!s) throw RequestError.invalidParams(`Unknown sessionId: ${sessionId}`)
    return s
  }

  /**
   * Used by session/load: create a session object bound to an existing sessionId/proc
   * if it isn't already registered.
   */
  async getOrCreate(sessionId: string, params: SessionCreateParams & { proc: PiRpcProcess }): Promise<PiAcpSession> {
    const existing = this.sessions.get(sessionId)
    if (existing) {
      await params.bashBridge?.dispose().catch(() => undefined)
      return existing
    }

    const bashBridge = params.bashBridge ?? (params.supportsTerminal ? await BashBridgeServer.create() : undefined)

    const session = new PiAcpSession({
      sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      proc: params.proc,
      conn: params.conn,
      fileCommands: params.fileCommands ?? [],
      supportsTerminal: params.supportsTerminal ?? false,
      bashBridge
    })

    this.sessions.set(sessionId, session)
    return session
  }
}

export class PiAcpSession {
  readonly sessionId: string
  readonly cwd: string
  readonly mcpServers: McpServer[]

  private startupInfo: string | null = null
  private startupInfoSent = false

  readonly proc: PiRpcProcess
  private readonly conn: AgentSideConnection
  private readonly fileCommands: FileSlashCommand[]

  // Used to map abort semantics to ACP stopReason.
  // Applies to the currently running turn.
  private cancelRequested = false

  // Current in-flight turn (if any). Additional prompts are queued.
  private pendingTurn: PendingTurn | null = null
  private readonly turnQueue: QueuedTurn[] = []
  // Track tool call statuses and ensure they are monotonic (pending -> in_progress -> completed).
  // Some pi events can arrive out of order (e.g. late toolcall_* deltas after execution starts),
  // and clients may hide progress if we ever downgrade back to `pending`.
  private currentToolCalls = new Map<string, 'pending' | 'in_progress'>()
  private completedToolCalls = new Set<string>()
  private terminalBackedBashToolCalls = new Set<string>()

  // pi can emit multiple `turn_end` events for a single user prompt (e.g. after tool_use).
  // The overall agent loop completes when `agent_end` is emitted.
  private inAgentLoop = false

  // For ACP diff support: capture file contents before edits, then emit ToolCallContent {type:"diff"}.
  // This is due to pi sending diff as a string as opposed to ACP expected diff format.
  // Compatible format may need to be implemented in pi in the future.
  private editSnapshots = new Map<string, { path: string; oldText: string }>()
  private bashTerminals = new Map<string, BashTerminalExecution>()
  private readonly supportsTerminal: boolean
  private readonly bashBridge?: BashBridgeServer

  // Ensure `session/update` notifications are sent in order and can be awaited
  // before completing a `session/prompt` request.
  private lastEmit: Promise<void> = Promise.resolve()

  private emitSessionInfoUpdate(updatedAt = new Date().toISOString()): void {
    void this.proc
      .getState()
      .then((state: any) => {
        const sessionName = typeof state?.sessionName === 'string' ? state.sessionName.trim() : ''
        this.emit({
          sessionUpdate: 'session_info_update',
          ...(sessionName ? { title: sessionName } : {}),
          updatedAt
        })
      })
      .catch(() => {
        this.emit({
          sessionUpdate: 'session_info_update',
          updatedAt
        })
      })
  }

  constructor(opts: {
    sessionId: string
    cwd: string
    mcpServers: McpServer[]
    proc: PiRpcProcess
    conn: AgentSideConnection
    fileCommands?: FileSlashCommand[]
    supportsTerminal?: boolean
    bashBridge?: BashBridgeServer
  }) {
    this.sessionId = opts.sessionId
    this.cwd = opts.cwd
    this.mcpServers = opts.mcpServers
    this.proc = opts.proc
    this.conn = opts.conn
    this.fileCommands = opts.fileCommands ?? []
    this.supportsTerminal = opts.supportsTerminal ?? false
    this.bashBridge = opts.bashBridge

    debugLog('session:construct', {
      sessionId: this.sessionId,
      cwd: this.cwd,
      supportsTerminal: this.supportsTerminal,
      bashBridgeSocketPath: this.bashBridge?.socketPath
    })

    if (this.supportsTerminal && this.bashBridge) {
      this.bashBridge.setExecutor((request, ctx) => this.executeBashTerminalRequest(request, ctx))
    }

    this.proc.onEvent(ev => this.handlePiEvent(ev))
  }

  async dispose(): Promise<void> {
    const terminals = [...this.bashTerminals.entries()]
    this.bashTerminals.clear()

    await Promise.allSettled([
      ...terminals.map(([toolCallId, execution]) => this.releaseBashTerminal(toolCallId, execution, true)),
      this.bashBridge?.dispose() ?? Promise.resolve()
    ])
  }

  private async executeBashTerminalRequest(request: BashBridgeExecuteRequest, ctx: BashBridgeExecutionContext): Promise<void> {
    debugLog('session:bash-terminal:start', {
      sessionId: this.sessionId,
      toolCallId: request.toolCallId,
      command: request.command,
      cwd: request.cwd,
      supportsTerminal: this.supportsTerminal
    })

    if (!this.supportsTerminal) {
      ctx.sendError('ACP terminal support is unavailable for this session')
      return
    }

    this.terminalBackedBashToolCalls.add(request.toolCallId)

    const launch = resolveTerminalLaunch(request.command)

    const terminal = await this.conn.createTerminal({
      sessionId: this.sessionId,
      command: launch.command,
      ...(launch.args.length > 0 ? { args: launch.args } : {}),
      cwd: request.cwd ?? this.cwd,
      outputByteLimit: 200_000
    })

    debugLog('session:bash-terminal:created', {
      sessionId: this.sessionId,
      toolCallId: request.toolCallId,
      terminalId: terminal.id
    })

    const execution: BashTerminalExecution = {
      terminal,
      lastOutput: ''
    }
    this.bashTerminals.set(request.toolCallId, execution)

    if (this.currentToolCalls.has(request.toolCallId)) {
      this.emit({
        sessionUpdate: 'tool_call_update',
        toolCallId: request.toolCallId,
        kind: 'execute',
        status: this.currentToolCalls.get(request.toolCallId) ?? 'in_progress',
        content: [{ type: 'terminal', terminalId: terminal.id }]
      })
    } else {
      this.currentToolCalls.set(request.toolCallId, 'in_progress')
      this.emit({
        sessionUpdate: 'tool_call',
        toolCallId: request.toolCallId,
        title: formatToolCallTitle('bash', { command: request.command }),
        kind: 'execute',
        status: 'in_progress',
        rawInput: { command: request.command, ...(typeof request.timeout === 'number' ? { timeout: request.timeout } : {}) },
        content: [{ type: 'terminal', terminalId: terminal.id }]
      })
    }

    let cancelled = false
    let timedOut = false
    let exitCode: number | null | undefined
    let exitSignal: string | null | undefined
    let timeoutHandle: NodeJS.Timeout | undefined

    const timeoutSeconds = request.timeout && request.timeout > 0 ? request.timeout : undefined
    const timeoutPromise = timeoutSeconds
      ? new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            timedOut = true
            reject(new Error('timeout'))
          }, timeoutSeconds * 1000)
        })
      : null

    const abortPromise = new Promise<never>((_, reject) => {
      if (ctx.signal.aborted) {
        cancelled = true
        reject(new Error('aborted'))
        return
      }

      ctx.signal.addEventListener('abort', () => {
        cancelled = true
        reject(new Error('aborted'))
      }, { once: true })
    })

    try {
      const exitPromise = terminal.waitForExit()

      while (true) {
        await this.pushBashTerminalOutput(execution, ctx)

        const race: Array<Promise<{ type: 'exit'; exit: Awaited<ReturnType<TerminalHandle['waitForExit']>> } | { type: 'tick' } | { type: 'abort'; error: unknown } | { type: 'timeout'; error: unknown }>> = [
          exitPromise.then(exit => ({ type: 'exit' as const, exit })),
          sleep(75).then(() => ({ type: 'tick' as const })),
          abortPromise.catch(error => ({ type: 'abort' as const, error }))
        ]
        if (timeoutPromise) {
          race.push(timeoutPromise.catch(error => ({ type: 'timeout' as const, error })))
        }

        const state = await Promise.race(race)

        if (state.type === 'tick') continue

        if (state.type === 'exit') {
          exitCode = state.exit.exitCode ?? null
          exitSignal = state.exit.signal ?? null
          break
        }

        try {
          await terminal.kill()
        } catch {
          // ignore
        }

        const exit = await promiseWithTimeout(terminal.waitForExit(), 1_500).catch(() => ({ exitCode: null, signal: null }))
        exitCode = exit.exitCode ?? null
        exitSignal = exit.signal ?? null
        break
      }

      const finalOutput = await this.pushBashTerminalOutput(execution, ctx, true)
      const failed = timedOut || cancelled || Boolean(exitSignal) || (typeof exitCode === 'number' && exitCode !== 0)

      this.completedToolCalls.add(request.toolCallId)
      debugLog('session:bash-terminal:finished', {
        sessionId: this.sessionId,
        toolCallId: request.toolCallId,
        terminalId: terminal.id,
        exitCode,
        exitSignal,
        cancelled,
        timedOut,
        failed
      })
      this.emit({
        sessionUpdate: 'tool_call_update',
        toolCallId: request.toolCallId,
        kind: 'execute',
        status: failed ? 'failed' : 'completed',
        content: [{ type: 'terminal', terminalId: terminal.id }]
      })
      this.currentToolCalls.delete(request.toolCallId)
      this.terminalBackedBashToolCalls.delete(request.toolCallId)
      await this.releaseBashTerminal(request.toolCallId, execution, false)

      ctx.sendResult({
        output: finalOutput.output,
        truncated: finalOutput.truncated,
        exitCode,
        signal: exitSignal,
        cancelled,
        timedOut
      })
    } catch (error) {
      debugLog('session:bash-terminal:error', {
        sessionId: this.sessionId,
        toolCallId: request.toolCallId,
        error
      })
      if (timeoutHandle) clearTimeout(timeoutHandle)
      this.bashTerminals.delete(request.toolCallId)
      this.terminalBackedBashToolCalls.delete(request.toolCallId)
      try {
        await terminal.release()
      } catch {
        // ignore
      }
      ctx.sendError(error instanceof Error ? error.message : String(error))
      return
    }

    if (timeoutHandle) clearTimeout(timeoutHandle)
  }

  private async pushBashTerminalOutput(
    execution: BashTerminalExecution,
    ctx: Pick<BashBridgeExecutionContext, 'sendUpdate'>,
    force = false
  ): Promise<{ output: string; truncated: boolean }> {
    const current = await execution.terminal.currentOutput()

    if ((force || current.output !== execution.lastOutput) && current.output) {
      execution.lastOutput = current.output
      ctx.sendUpdate({
        output: current.output,
        truncated: current.truncated
      })
    } else if (force || current.output !== execution.lastOutput) {
      execution.lastOutput = current.output
    }

    return {
      output: current.output,
      truncated: current.truncated
    }
  }

  private async releaseBashTerminal(toolCallId: string, execution: BashTerminalExecution, killFirst: boolean): Promise<void> {
    this.bashTerminals.delete(toolCallId)

    if (killFirst) {
      try {
        await execution.terminal.kill()
      } catch {
        // ignore
      }
    }

    try {
      await execution.terminal.release()
    } catch {
      // ignore
    }
  }

  private shouldSuppressToolCall(toolCallId: string): boolean {
    return this.completedToolCalls.has(toolCallId) || this.terminalBackedBashToolCalls.has(toolCallId)
  }

  setStartupInfo(text: string) {
    this.startupInfo = text
  }

  /**
   * Best-effort attempt to send startup info outside of a prompt turn.
   * Some clients (e.g. Zed) may only render agent messages once the UI is ready;
   * callers can invoke this shortly after session/new returns.
   */
  sendStartupInfoIfPending(): void {
    if (this.startupInfoSent || !this.startupInfo) return
    this.startupInfoSent = true

    this.emit({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: this.startupInfo }
    })
  }

  async prompt(message: string, images: unknown[] = []): Promise<StopReason> {

    // pi RPC mode disables slash command expansion, so we do it here.
    const expandedMessage = expandSlashCommand(message, this.fileCommands)

    const turnPromise = new Promise<StopReason>((resolve, reject) => {
      const queued: QueuedTurn = { message: expandedMessage, images, resolve, reject }

      // If a turn is already running, enqueue.
      if (this.pendingTurn) {
        this.turnQueue.push(queued)

        // Best-effort: notify client that a prompt was queued.
        // This doesn't work in Zed yet, needs to be revisited
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: `Queued message (position ${this.turnQueue.length}).`
          }
        })

        // Also publish queue depth via session info metadata.
        // This also not visible in the client
        this.emit({
          sessionUpdate: 'session_info_update',
          _meta: { piAcp: { queueDepth: this.turnQueue.length, running: true } }
        })

        return
      }

      // No turn is running; start immediately.
      this.startTurn(queued)
    })

    return turnPromise
  }

  async cancel(): Promise<void> {
    // Cancel current and clear any queued prompts.
    this.cancelRequested = true

    if (this.turnQueue.length) {
      const queued = this.turnQueue.splice(0, this.turnQueue.length)
      for (const t of queued) t.resolve('cancelled')

      this.emit({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Cleared queued prompts.' }
      })
      this.emit({
        sessionUpdate: 'session_info_update',
        _meta: { piAcp: { queueDepth: 0, running: Boolean(this.pendingTurn) } }
      })
    }

    // Abort the currently running turn (if any). If nothing is running, this is a no-op.
    await this.proc.abort()
  }

  wasCancelRequested(): boolean {
    return this.cancelRequested
  }

  private emit(update: SessionUpdate): void {
    // Serialize update delivery.
    this.lastEmit = this.lastEmit
      .then(() =>
        this.conn.sessionUpdate({
          sessionId: this.sessionId,
          update
        })
      )
      .catch(() => {
        // Ignore notification errors (client may have gone away). We still want
        // prompt completion.
      })
  }

  private async flushEmits(): Promise<void> {
    await this.lastEmit
  }

  private startTurn(t: QueuedTurn): void {
    this.cancelRequested = false
    this.inAgentLoop = false

    this.pendingTurn = { resolve: t.resolve, reject: t.reject }

    // Publish queue depth (0 because we're starting the turn now).
    this.emit({
      sessionUpdate: 'session_info_update',
      _meta: { piAcp: { queueDepth: this.turnQueue.length, running: true } }
    })

    // Kick off pi, but completion is determined by pi events, not the RPC response.
    // Important: pi may emit multiple `turn_end` events (e.g. when the model requests tools).
    // The full prompt is finished when we see `agent_end`.
    this.proc.prompt(t.message, t.images).catch(err => {
      // If the subprocess errors before we get an `agent_end`, treat as error unless cancelled.
      // Also ensure we flush any already-enqueued updates first.
      void this.flushEmits().finally(() => {
        // If this looks like an auth/config issue, surface AUTH_REQUIRED so clients can offer terminal login.
        const authErr = maybeAuthRequiredError(err)
        if (authErr) {
          this.pendingTurn?.reject(authErr)
        } else {
          const reason: StopReason = this.cancelRequested ? 'cancelled' : 'error'
          this.pendingTurn?.resolve(reason)
        }

        this.pendingTurn = null
        this.inAgentLoop = false

        // If the prompt failed, do not automatically proceed—pi may be unhealthy.
        // But we still clear the queueDepth metadata.
        this.emit({
          sessionUpdate: 'session_info_update',
          _meta: { piAcp: { queueDepth: this.turnQueue.length, running: false } }
        })
        this.emitSessionInfoUpdate()
      })
      void err
    })
  }

  private handlePiEvent(ev: PiRpcEvent) {
    const type = String((ev as any).type ?? '')

    switch (type) {
      case 'message_update': {
        const ame = (ev as any).assistantMessageEvent

        // Stream assistant text.
        if (ame?.type === 'text_delta' && typeof ame.delta === 'string') {
          this.emit({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: ame.delta } satisfies ContentBlock
          })
          break
        }

        if (ame?.type === 'thinking_delta' && typeof ame.delta === 'string') {
          this.emit({
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: ame.delta } satisfies ContentBlock
          })
          break
        }

        // Surface tool calls ASAP so clients (e.g. Zed) can show a tool-in-use/loading UI
        // while the model is still streaming tool call args.
        if (ame?.type === 'toolcall_start' || ame?.type === 'toolcall_delta' || ame?.type === 'toolcall_end') {
          const toolCall =
            // pi sometimes includes the tool call directly on the event
            (ame as any)?.toolCall ??
            // ...and always includes it in the partial assistant message at contentIndex
            (ame as any)?.partial?.content?.[(ame as any)?.contentIndex ?? 0]

          const toolCallId = String((toolCall as any)?.id ?? '')
          const toolName = String((toolCall as any)?.name ?? 'tool')

          if (toolCallId) {
            debugLog('session:pi-bash-toolcall-event', {
              sessionId: this.sessionId,
              eventType: ame?.type,
              toolCallId,
              toolName,
              supportsTerminal: this.supportsTerminal,
              terminalBacked: this.terminalBackedBashToolCalls.has(toolCallId),
              completed: this.completedToolCalls.has(toolCallId)
            })

            const rawInput =
              (toolCall as any)?.arguments && typeof (toolCall as any).arguments === 'object'
                ? (toolCall as any).arguments
                : (() => {
                    const s = String((toolCall as any)?.partialArgs ?? '')
                    if (!s) return undefined
                    try {
                      return JSON.parse(s)
                    } catch {
                      return { partialArgs: s }
                    }
                  })()

            if (this.shouldSuppressToolCall(toolCallId)) break

            const locations = toToolCallLocations(rawInput, this.cwd)
            const existingStatus = this.currentToolCalls.get(toolCallId)
            // IMPORTANT: never downgrade status (e.g. if we already marked in_progress via tool_execution_start).
            const status = existingStatus ?? 'pending'

            if (!existingStatus) {
              this.currentToolCalls.set(toolCallId, 'pending')
              this.emit({
                sessionUpdate: 'tool_call',
                toolCallId,
                title: formatToolCallTitle(toolName, rawInput),
                kind: toToolKind(toolName, this.supportsTerminal),
                status,
                locations,
                rawInput
              })
            } else {
              // Best-effort: keep rawInput updated while args are streaming.
              // Keep the existing status (pending or in_progress).
              this.emit({
                sessionUpdate: 'tool_call_update',
                toolCallId,
                status,
                locations,
                rawInput
              })
            }
          }

          break
        }

        // Ignore other delta/event types for now.
        break
      }

      case 'tool_execution_start': {
        const toolCallId = String((ev as any).toolCallId ?? crypto.randomUUID())
        const toolName = String((ev as any).toolName ?? 'tool')
        const args = (ev as any).args
        if (toolName === 'bash') {
          debugLog('session:pi-bash-execution-start', {
            sessionId: this.sessionId,
            toolCallId,
            supportsTerminal: this.supportsTerminal,
            terminalBacked: this.terminalBackedBashToolCalls.has(toolCallId),
            suppressed: this.shouldSuppressToolCall(toolCallId),
            args
          })
        }
        if (this.shouldSuppressToolCall(toolCallId)) break
        this.completedToolCalls.delete(toolCallId)
        let line: number | undefined

        // Capture pre-edit file contents so we can emit a structured ACP diff on completion.
        if (toolName === 'edit') {
          const p = typeof args?.path === 'string' ? args.path : undefined
          if (p) {
            try {
              const abs = isAbsolute(p) ? p : resolvePath(this.cwd, p)
              const oldText = readFileSync(abs, 'utf8')
              this.editSnapshots.set(toolCallId, { path: p, oldText })

              const needle = typeof args?.oldText === 'string' ? args.oldText : ''
              line = findUniqueLineNumber(oldText, needle)
            } catch {
              // Ignore snapshot failures; we'll fall back to plain text output.
            }
          }
        }

        const locations = toToolCallLocations(args, this.cwd, line)

        if (this.shouldSuppressToolCall(toolCallId)) break

        // If we already surfaced the tool call while the model streamed it, just transition.
        if (!this.currentToolCalls.has(toolCallId)) {
          this.currentToolCalls.set(toolCallId, 'in_progress')
          this.emit({
            sessionUpdate: 'tool_call',
            toolCallId,
            title: formatToolCallTitle(toolName, args),
            kind: toToolKind(toolName, this.supportsTerminal),
            status: 'in_progress',
            locations,
            rawInput: args
          })
        } else {
          this.currentToolCalls.set(toolCallId, 'in_progress')
          this.emit({
            sessionUpdate: 'tool_call_update',
            toolCallId,
            kind: toolName === 'bash' && this.supportsTerminal ? 'execute' : undefined,
            status: 'in_progress',
            locations,
            rawInput: args
          })
        }

        break
      }

      case 'tool_execution_update': {
        const toolCallId = String((ev as any).toolCallId ?? '')
        if (!toolCallId) break
        if (String((ev as any).toolName ?? '') === 'bash' || this.terminalBackedBashToolCalls.has(toolCallId)) {
          debugLog('session:pi-bash-execution-update', {
            sessionId: this.sessionId,
            toolCallId,
            toolName: (ev as any).toolName,
            supportsTerminal: this.supportsTerminal,
            terminalBacked: this.terminalBackedBashToolCalls.has(toolCallId),
            suppressed: this.shouldSuppressToolCall(toolCallId)
          })
        }
        if (this.shouldSuppressToolCall(toolCallId)) break

        const partial = (ev as any).partialResult
        const text = toolResultToText(partial)
        const bashMirror = this.bashTerminals.get(toolCallId)

        this.emit({
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: 'in_progress',
          kind: bashMirror ? 'execute' : undefined,
          content: bashMirror
            ? undefined
            : text
              ? ([{ type: 'content', content: { type: 'text', text } }] satisfies ToolCallContent[])
              : undefined,
          rawOutput: bashMirror ? undefined : partial
        })
        break
      }

      case 'tool_execution_end': {
        const toolCallId = String((ev as any).toolCallId ?? '')
        if (!toolCallId) break
        if (String((ev as any).toolName ?? '') === 'bash' || this.terminalBackedBashToolCalls.has(toolCallId)) {
          debugLog('session:pi-bash-execution-end', {
            sessionId: this.sessionId,
            toolCallId,
            toolName: (ev as any).toolName,
            supportsTerminal: this.supportsTerminal,
            terminalBacked: this.terminalBackedBashToolCalls.has(toolCallId),
            suppressed: this.shouldSuppressToolCall(toolCallId),
            isError: Boolean((ev as any).isError)
          })
        }
        if (this.shouldSuppressToolCall(toolCallId)) break

        const result = (ev as any).result
        const isError = Boolean((ev as any).isError)
        const text = toolResultToText(result)

        // If this was an edit and we captured a snapshot, emit a structured ACP diff.
        // This enables clients like Zed to render an actual diff UI.
        const snapshot = this.editSnapshots.get(toolCallId)
        let content: ToolCallContent[] | undefined

        if (!isError && snapshot) {
          try {
            const abs = isAbsolute(snapshot.path) ? snapshot.path : resolvePath(this.cwd, snapshot.path)
            const newText = readFileSync(abs, 'utf8')
            if (newText !== snapshot.oldText) {
              content = [
                {
                  type: 'diff',
                  path: snapshot.path,
                  oldText: snapshot.oldText,
                  newText
                },
                ...(text ? ([{ type: 'content', content: { type: 'text', text } }] as ToolCallContent[]) : [])
              ]
            }
          } catch {
            // ignore; fall back to text only
          }
        }

        const bashMirror = this.bashTerminals.get(toolCallId)

        // Fallback: just text content.
        if (!content && text && !bashMirror) {
          content = [{ type: 'content', content: { type: 'text', text } }] satisfies ToolCallContent[]
        }

        if (bashMirror) {
          content = [{ type: 'terminal', terminalId: bashMirror.terminal.id }] satisfies ToolCallContent[]
        }

        this.completedToolCalls.add(toolCallId)

        this.emit({
          sessionUpdate: 'tool_call_update',
          toolCallId,
          kind: bashMirror ? 'execute' : undefined,
          status: isError ? 'failed' : 'completed',
          content,
          rawOutput: bashMirror ? undefined : result
        })

        this.currentToolCalls.delete(toolCallId)
        this.editSnapshots.delete(toolCallId)
        if (bashMirror) {
          void this.releaseBashTerminal(toolCallId, bashMirror, false)
        }
        break
      }

      case 'auto_retry_start': {
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: formatAutoRetryMessage(ev) } satisfies ContentBlock
        })
        break
      }

      case 'auto_retry_end': {
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Retry finished, resuming.' } satisfies ContentBlock
        })
        break
      }

      case 'auto_compaction_start': {
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Context nearing limit, running automatic compaction...' } satisfies ContentBlock
        })
        break
      }

      case 'auto_compaction_end': {
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: 'Automatic compaction finished; context was summarized to continue the session.'
          } satisfies ContentBlock
        })
        break
      }

      case 'agent_start': {
        this.inAgentLoop = true
        this.completedToolCalls.clear()
        this.terminalBackedBashToolCalls.clear()
        break
      }

      case 'turn_end': {
        // pi uses `turn_end` for sub-steps (e.g. tool_use) and will often start another turn.
        // Do NOT resolve the ACP `session/prompt` here; wait for `agent_end`.
        break
      }

      case 'agent_end': {
        // Ensure all updates derived from pi events are delivered before we resolve
        // the ACP `session/prompt` request.
        void this.flushEmits().finally(() => {
          const reason: StopReason = this.cancelRequested ? 'cancelled' : 'end_turn'
          this.pendingTurn?.resolve(reason)
          this.pendingTurn = null
          this.inAgentLoop = false
          this.emitSessionInfoUpdate()

          // Start next queued prompt, if any.
          const next = this.turnQueue.shift()
          if (next) {
            this.emit({
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: `Starting queued message. (${this.turnQueue.length} remaining)` }
            })
            this.startTurn(next)
          } else {
            this.emit({
              sessionUpdate: 'session_info_update',
              _meta: { piAcp: { queueDepth: 0, running: false } }
            })
          }
        })
        break
      }

      default:
        break
    }
  }
}

type TerminalLaunch = {
  command: string
  args: string[]
}

function resolveTerminalLaunch(commandLine: string): TerminalLaunch {
  const parsed = parseDirectCommand(commandLine)
  if (parsed) return parsed

  return {
    command: defaultShellCommand(),
    args: defaultShellArgs(commandLine)
  }
}

function parseDirectCommand(commandLine: string): TerminalLaunch | null {
  if (process.platform === 'win32') return null

  const trimmed = commandLine.trim()
  if (!trimmed) return null
  if ([
    '|',
    '&',
    ';',
    '<',
    '>',
    '(',
    ')',
    '$',
    '`',
    '\n',
    '*',
    '?',
    '[',
    ']',
    '{',
    '}',
    '~'
  ].some(char => trimmed.includes(char))) {
    return null
  }

  const args: string[] = []
  let current = ''
  let quote: 'single' | 'double' | null = null
  let escaping = false

  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i]

    if (escaping) {
      current += ch
      escaping = false
      continue
    }

    if (ch === '\\' && quote !== 'single') {
      escaping = true
      continue
    }

    if (quote === 'single') {
      if (ch === "'") quote = null
      else current += ch
      continue
    }

    if (quote === 'double') {
      if (ch === '"') quote = null
      else current += ch
      continue
    }

    if (ch === "'") {
      quote = 'single'
      continue
    }

    if (ch === '"') {
      quote = 'double'
      continue
    }

    if (/\s/.test(ch)) {
      if (current) {
        args.push(current)
        current = ''
      }
      continue
    }

    current += ch
  }

  if (escaping || quote) return null
  if (current) args.push(current)
  if (args.length === 0) return null

  return {
    command: args[0],
    args: args.slice(1)
  }
}

function defaultShellCommand(): string {
  return process.env.SHELL || (process.platform === 'win32' ? 'cmd.exe' : '/bin/sh')
}

function defaultShellArgs(command: string): string[] {
  if (process.platform === 'win32') {
    return ['/d', '/s', '/c', command]
  }

  return ['-lc', command]
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms)
  })
}

async function promiseWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs)
    })
  ])
}

function formatToolCallTitle(toolName: string, args: unknown): string {
  if (toolName !== 'bash') return toolName

  const command =
    typeof (args as { command?: unknown } | null | undefined)?.command === 'string'
      ? (args as { command: string }).command.trim()
      : typeof (args as { cmd?: unknown } | null | undefined)?.cmd === 'string'
        ? (args as { cmd: string }).cmd.trim()
        : ''

  if (!command) return 'bash'

  const firstLine = command.split('\n')[0] ?? command
  return firstLine.length > 120 ? `$ ${firstLine.slice(0, 117)}...` : `$ ${firstLine}`
}

function formatAutoRetryMessage(ev: PiRpcEvent): string {
  const attempt = Number((ev as any).attempt)
  const maxAttempts = Number((ev as any).maxAttempts)
  const delayMs = Number((ev as any).delayMs)

  if (!Number.isFinite(attempt) || !Number.isFinite(maxAttempts) || !Number.isFinite(delayMs)) {
    return 'Retrying...'
  }

  let delaySeconds = Math.round(delayMs / 1000)
  if (delayMs > 0 && delaySeconds === 0) delaySeconds = 1

  return `Retrying (attempt ${attempt}/${maxAttempts}, waiting ${delaySeconds}s)...`
}

function toToolKind(toolName: string, bashUsesTerminal = false): ToolKind {
  switch (toolName) {
    case 'read':
      return 'read'
    case 'write':
    case 'edit':
      return 'edit'
    case 'bash':
      return bashUsesTerminal ? 'execute' : 'other'
    default:
      return 'other'
  }
}
