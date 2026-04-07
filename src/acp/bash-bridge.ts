import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import * as readline from 'node:readline'
import { debugLog } from '../debug.js'

export type BashBridgeExecuteRequest = {
  type: 'bash_execute'
  toolCallId: string
  command: string
  cwd?: string
  timeout?: number
}

type BashBridgeAbortRequest = {
  type: 'abort'
}

type BashBridgeRequest = BashBridgeExecuteRequest | BashBridgeAbortRequest

export type BashBridgeUpdateMessage = {
  type: 'update'
  output: string
  truncated?: boolean
}

export type BashBridgeResultMessage = {
  type: 'result'
  output: string
  exitCode?: number | null
  signal?: string | null
  truncated?: boolean
  cancelled?: boolean
  timedOut?: boolean
}

export type BashBridgeErrorMessage = {
  type: 'error'
  message: string
}

type BashBridgeResponse = BashBridgeUpdateMessage | BashBridgeResultMessage | BashBridgeErrorMessage

export type BashBridgeExecutionContext = {
  signal: AbortSignal
  sendUpdate: (message: Omit<BashBridgeUpdateMessage, 'type'>) => void
  sendResult: (message: Omit<BashBridgeResultMessage, 'type'>) => void
  sendError: (message: string) => void
}

type BashBridgeExecutor = (request: BashBridgeExecuteRequest, ctx: BashBridgeExecutionContext) => Promise<void>

function socketPathForDir(dir: string): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\pi-acp-bash-${randomUUID()}`
  }

  return join(dir, 'bash.sock')
}

export class BashBridgeServer {
  readonly socketPath: string

  private constructor(
    socketPath: string,
    private readonly tempDir: string | null,
    private readonly server: Server
  ) {
    this.socketPath = socketPath
  }

  private executor: BashBridgeExecutor | null = null

  static async create(): Promise<BashBridgeServer> {
    const tempDir = process.platform === 'win32' ? null : await mkdtemp(join(tmpdir(), 'pi-acp-bash-'))
    const socketPath = socketPathForDir(tempDir ?? tmpdir())
    const server = createServer()
    const bridge = new BashBridgeServer(socketPath, tempDir, server)

    server.on('connection', socket => {
      void bridge.handleConnection(socket)
    })

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        server.off('listening', onListening)
        reject(err)
      }
      const onListening = () => {
        server.off('error', onError)
        resolve()
      }

      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(socketPath)
    })

    debugLog('bash-bridge:create', { socketPath })
    return bridge
  }

  setExecutor(executor: BashBridgeExecutor): void {
    this.executor = executor
    debugLog('bash-bridge:set-executor', { socketPath: this.socketPath })
  }

  async dispose(): Promise<void> {
    debugLog('bash-bridge:dispose:start', { socketPath: this.socketPath })
    await new Promise<void>(resolve => {
      this.server.close(() => resolve())
    })

    if (process.platform !== 'win32') {
      await Promise.allSettled([
        rm(this.socketPath, { force: true }),
        this.tempDir ? rm(this.tempDir, { recursive: true, force: true }) : Promise.resolve()
      ])
    }

    debugLog('bash-bridge:dispose:end', { socketPath: this.socketPath })
  }

  private async handleConnection(socket: Socket): Promise<void> {
    debugLog('bash-bridge:connection', { socketPath: this.socketPath })
    const rl = readline.createInterface({ input: socket })
    const abortController = new AbortController()
    let started = false

    const send = (message: BashBridgeResponse) => {
      debugLog('bash-bridge:send', {
        socketPath: this.socketPath,
        type: message.type,
        toolCallId: 'toolCallId' in message ? (message as any).toolCallId : undefined,
        outputLength: 'output' in message && typeof message.output === 'string' ? message.output.length : undefined,
        message: 'message' in message ? message.message : undefined
      })
      if (socket.destroyed) return
      socket.write(`${JSON.stringify(message)}\n`)
    }

    socket.on('close', () => {
      debugLog('bash-bridge:socket-close', { socketPath: this.socketPath })
      abortController.abort()
      rl.close()
    })

    socket.on('error', error => {
      debugLog('bash-bridge:socket-error', { socketPath: this.socketPath, error })
      abortController.abort()
      rl.close()
    })

    rl.on('line', line => {
      if (!line.trim()) return

      let message: BashBridgeRequest
      try {
        message = JSON.parse(line) as BashBridgeRequest
        debugLog('bash-bridge:receive', {
          socketPath: this.socketPath,
          type: message.type,
          toolCallId: message.type === 'bash_execute' ? message.toolCallId : undefined,
          command: message.type === 'bash_execute' ? message.command : undefined
        })
      } catch {
        send({ type: 'error', message: 'Invalid bash bridge JSON' })
        socket.end()
        return
      }

      if (message.type === 'abort') {
        abortController.abort()
        return
      }

      if (message.type !== 'bash_execute') {
        send({ type: 'error', message: `Unsupported bash bridge message type: ${(message as any)?.type ?? 'unknown'}` })
        socket.end()
        return
      }

      if (started) {
        send({ type: 'error', message: 'bash_execute already started on this connection' })
        socket.end()
        return
      }

      started = true

      if (!this.executor) {
        send({ type: 'error', message: 'Bash bridge executor not ready' })
        socket.end()
        return
      }

      void this.executor(message, {
        signal: abortController.signal,
        sendUpdate: update => send({ type: 'update', ...update }),
        sendResult: result => {
          send({ type: 'result', ...result })
          socket.end()
        },
        sendError: error => {
          send({ type: 'error', message: error })
          socket.end()
        }
      }).catch(err => {
        send({ type: 'error', message: err instanceof Error ? err.message : String(err) })
        socket.end()
      })
    })
  }
}
