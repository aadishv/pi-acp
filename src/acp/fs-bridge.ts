import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath, isAbsolute } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import * as readline from 'node:readline'
import { debugLog } from '../debug.js'

export type FsBridgeReadTextFileRequest = {
  type: 'read_text_file'
  toolCallId: string
  path: string
  cwd?: string
  offset?: number
  limit?: number
}

export type FsBridgeWriteTextFileRequest = {
  type: 'write_text_file'
  toolCallId: string
  path: string
  cwd?: string
  content: string
}

type FsBridgeAbortRequest = {
  type: 'abort'
}

type FsBridgeRequest = FsBridgeReadTextFileRequest | FsBridgeWriteTextFileRequest | FsBridgeAbortRequest

type FsBridgeResponse =
  | { type: 'result'; content?: string; path?: string; bytesWritten?: number }
  | { type: 'error'; message: string }

export type FsBridgeExecutionContext = {
  signal: AbortSignal
  sendResult: (message: { content?: string; path?: string; bytesWritten?: number }) => void
  sendError: (message: string) => void
}

type FsBridgeReadExecutor = (request: FsBridgeReadTextFileRequest, ctx: FsBridgeExecutionContext) => Promise<void>
type FsBridgeWriteExecutor = (request: FsBridgeWriteTextFileRequest, ctx: FsBridgeExecutionContext) => Promise<void>

function socketPathForDir(dir: string): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\pi-acp-fs-${randomUUID()}`
  }

  return join(dir, 'fs.sock')
}

export function resolveBridgePath(path: string, cwd?: string): string {
  return isAbsolute(path) ? path : resolvePath(cwd ?? process.cwd(), path)
}

export class FsBridgeServer {
  readonly socketPath: string
  private readExecutor: FsBridgeReadExecutor | null = null
  private writeExecutor: FsBridgeWriteExecutor | null = null

  private constructor(
    socketPath: string,
    private readonly tempDir: string | null,
    private readonly server: Server
  ) {
    this.socketPath = socketPath
  }

  static async create(): Promise<FsBridgeServer> {
    const tempDir = process.platform === 'win32' ? null : await mkdtemp(join(tmpdir(), 'pi-acp-fs-'))
    const socketPath = socketPathForDir(tempDir ?? tmpdir())
    const server = createServer()
    const bridge = new FsBridgeServer(socketPath, tempDir, server)

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

    debugLog('fs-bridge:create', { socketPath })
    return bridge
  }

  setExecutors(executors: { readTextFile: FsBridgeReadExecutor; writeTextFile: FsBridgeWriteExecutor }): void {
    this.readExecutor = executors.readTextFile
    this.writeExecutor = executors.writeTextFile
    debugLog('fs-bridge:set-executors', { socketPath: this.socketPath })
  }

  async dispose(): Promise<void> {
    debugLog('fs-bridge:dispose:start', { socketPath: this.socketPath })
    await new Promise<void>(resolve => {
      this.server.close(() => resolve())
    })

    if (process.platform !== 'win32') {
      await Promise.allSettled([
        rm(this.socketPath, { force: true }),
        this.tempDir ? rm(this.tempDir, { recursive: true, force: true }) : Promise.resolve()
      ])
    }

    debugLog('fs-bridge:dispose:end', { socketPath: this.socketPath })
  }

  private async handleConnection(socket: Socket): Promise<void> {
    debugLog('fs-bridge:connection', { socketPath: this.socketPath })
    const rl = readline.createInterface({ input: socket })
    const abortController = new AbortController()
    let started = false

    const send = (message: FsBridgeResponse) => {
      debugLog('fs-bridge:send', { socketPath: this.socketPath, type: message.type, bytesWritten: 'bytesWritten' in message ? message.bytesWritten : undefined, contentLength: 'content' in message && typeof message.content === 'string' ? message.content.length : undefined, message: 'message' in message ? message.message : undefined })
      if (socket.destroyed) return
      socket.write(`${JSON.stringify(message)}\n`)
    }

    socket.on('close', () => {
      debugLog('fs-bridge:socket-close', { socketPath: this.socketPath })
      abortController.abort()
      rl.close()
    })

    socket.on('error', error => {
      debugLog('fs-bridge:socket-error', { socketPath: this.socketPath, error })
      abortController.abort()
      rl.close()
    })

    rl.on('line', line => {
      if (!line.trim()) return

      let message: FsBridgeRequest
      try {
        message = JSON.parse(line) as FsBridgeRequest
        debugLog('fs-bridge:receive', { socketPath: this.socketPath, type: message.type, toolCallId: 'toolCallId' in message ? message.toolCallId : undefined, path: 'path' in message ? message.path : undefined })
      } catch {
        send({ type: 'error', message: 'Invalid fs bridge JSON' })
        socket.end()
        return
      }

      if (message.type === 'abort') {
        abortController.abort()
        return
      }

      if (started) {
        send({ type: 'error', message: 'Only one fs request is allowed per connection' })
        socket.end()
        return
      }
      started = true

      const executor = message.type === 'read_text_file' ? this.readExecutor : this.writeExecutor
      if (!executor) {
        send({ type: 'error', message: 'FS bridge executor not ready' })
        socket.end()
        return
      }

      void executor(message as never, {
        signal: abortController.signal,
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
