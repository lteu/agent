import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { JSONRPCMessageSchema, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import WebSocket, { type RawData } from 'ws'

/** MCP JSON-RPC transport over WebSocket, compatible with CC's `type: "ws"` configs. */
export class McpWebSocketTransport implements Transport {
  private readonly socket: WebSocket
  private started = false
  private closed = false

  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void

  constructor(url: URL, headers: Record<string, string> = {}) {
    this.socket = new WebSocket(url, { headers })
    this.socket.on('message', this.handleMessage)
    this.socket.on('error', this.handleError)
    this.socket.on('close', this.handleClose)
  }

  private handleMessage = (data: RawData): void => {
    try {
      const raw = typeof data === 'string' ? data : data.toString()
      const parsed = JSON.parse(raw) as unknown
      if (Array.isArray(parsed)) {
        for (const item of parsed) this.onmessage?.(JSONRPCMessageSchema.parse(item))
      } else {
        this.onmessage?.(JSONRPCMessageSchema.parse(parsed))
      }
    } catch (error) {
      this.onerror?.(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private handleError = (error: Error): void => {
    this.onerror?.(error)
  }

  private handleClose = (): void => {
    if (this.closed) return
    this.closed = true
    this.onclose?.()
  }

  async start(): Promise<void> {
    if (this.started) throw new Error('MCP WebSocket transport can only be started once')
    this.started = true
    if (this.socket.readyState === WebSocket.OPEN) return
    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        cleanup()
        resolve()
      }
      const onError = (error: Error) => {
        cleanup()
        reject(error)
      }
      const cleanup = () => {
        this.socket.off('open', onOpen)
        this.socket.off('error', onError)
      }
      this.socket.on('open', onOpen)
      this.socket.on('error', onError)
    })
  }

  async send(message: JSONRPCMessage | JSONRPCMessage[]): Promise<void> {
    if (this.socket.readyState !== WebSocket.OPEN) throw new Error('MCP WebSocket is not open')
    await new Promise<void>((resolve, reject) => {
      this.socket.send(JSON.stringify(message), error => error ? reject(error) : resolve())
    })
  }

  async close(): Promise<void> {
    if (this.closed) return
    if (this.socket.readyState === WebSocket.CONNECTING) {
      this.closed = true
      this.socket.terminate()
      this.onclose?.()
      return
    }
    if (this.socket.readyState === WebSocket.CLOSED) {
      this.handleClose()
      return
    }
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        this.socket.terminate()
        resolve()
      }, 1_000)
      timer.unref?.()
      this.socket.once('close', () => {
        clearTimeout(timer)
        resolve()
      })
      this.socket.close()
    })
    this.handleClose()
  }
}
