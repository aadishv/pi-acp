import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export const DEBUG_LOG_PATH = process.env.PI_ACP_DEBUG_LOG || '/tmp/pi-acp-debug.log'

let ensured = false

function ensureLogDir(): void {
  if (ensured) return
  ensured = true

  try {
    mkdirSync(dirname(DEBUG_LOG_PATH), { recursive: true })
  } catch {
    // ignore
  }
}

function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    const code = (value as Error & { code?: unknown }).code
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
      ...(code !== undefined ? { code } : {})
    }
  }

  if (typeof value === 'bigint') return String(value)
  return value
}

export function debugLog(event: string, data?: unknown): void {
  try {
    ensureLogDir()
    appendFileSync(
      DEBUG_LOG_PATH,
      `${JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, event, data }, replacer)}\n`,
      'utf8'
    )
  } catch {
    // ignore
  }
}
