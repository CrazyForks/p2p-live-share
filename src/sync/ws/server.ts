import type { Server as HttpServer } from 'node:http'
import { Buffer } from 'node:buffer'
import { createServer as createHttpServer } from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import { deserializeUplink, serializeDownlink, UpdatePeersAction } from './protocol'

export interface WebSocketData {
  peerId: string
  roomId: string
}

export interface ServerOptions {
  port: number
  hostname: string
  manualDelay?: number
  onServerStart?: (info: { port: number, hostname: string }) => void
  onError?: (error: Error) => void
  onPeerJoin?: (peerId: string, roomId: string) => void
  onPeerLeave?: (peerId: string, roomId: string) => void
  onRoomEmpty?: (roomId: string) => void
}

interface WebSocketWithData extends WebSocket {
  data?: WebSocketData
}

export class WebSocketSignalingServer {
  private rooms = new Map<string, Map<string, WebSocketWithData>>()
  private httpServer: HttpServer | null = null
  private wss: WebSocketServer | null = null
  private options: Required<ServerOptions>

  constructor(options: ServerOptions) {
    this.options = {
      manualDelay: 0,
      onServerStart: () => {},
      onError: () => {},
      onPeerJoin: () => {},
      onPeerLeave: () => {},
      onRoomEmpty: () => {},
      ...options,
    }
  }

  start(): HttpServer {
    const { port, hostname, manualDelay, onServerStart, onError, onPeerJoin, onPeerLeave, onRoomEmpty } = this.options

    // Create HTTP server
    this.httpServer = createHttpServer((req, res) => {
      const url = new URL(req.url || '', `http://${req.headers.host}`)
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end(`P2P Live Share WebSocket Signaling Server. ${this.rooms.size} active room(s).`)
        return
      }

      res.writeHead(404)
      res.end('Not found')
    })

    // Create WebSocket server
    this.wss = new WebSocketServer({ noServer: true })

    // Handle upgrade requests
    this.httpServer.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url || '', `http://${request.headers.host}`)
      const match = url.pathname.match(/^\/([\w-]+)\/([\w-]+)$/)

      if (!match) {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
        socket.destroy()
        return
      }

      const [_, roomId, peerId] = match

      this.wss!.handleUpgrade(request, socket, head, (ws: WebSocketWithData) => {
        ws.data = { roomId, peerId }
        this.wss!.emit('connection', ws, request)
      })
    })

    // Handle WebSocket connections
    this.wss.on('connection', (ws: WebSocketWithData) => {
      const { roomId, peerId } = ws.data!

      let roomClients = this.rooms.get(roomId)
      if (!roomClients) {
        this.rooms.set(roomId, roomClients = new Map())
      }
      roomClients.set(peerId, ws)
      this.sendUpdatePeers(roomId)
      onPeerJoin(peerId, roomId)

      ws.binaryType = 'arraybuffer'
      ws.onmessage = ({ data }) => {
        try {
          const uplink = deserializeUplink(data as ArrayBuffer | string)
          const { roomId, peerId: senderId } = ws.data!

          const roomClients = this.rooms.get(roomId)
          if (!roomClients) {
            console.error(`Room ${roomId} not found. Closing connection.`)
            ws.close()
            return
          }

          const downlinkPayload = {
            action: uplink.action,
            data: uplink.data,
            peerId: senderId,
            metadata: uplink.metadata,
          }
          const downlinkMessage = serializeDownlink(downlinkPayload)

          const targets = uplink.targetPeers
            ? (Array.isArray(uplink.targetPeers) ? uplink.targetPeers : [uplink.targetPeers])
                .map(id => roomClients.get(id))
            : Array.from(roomClients.values())

          targets.forEach((client) => {
            if (client && client !== ws && client.readyState === WebSocket.OPEN) {
              if (manualDelay) {
                setTimeout(() => {
                  client.send(downlinkMessage)
                }, manualDelay)
              }
              else {
                client.send(downlinkMessage)
              }
            }
          })
        }
        catch (error) {
          console.error('Failed to process message:', error)
        }
      }

      ws.onclose = () => {
        const { peerId, roomId } = ws.data!
        const roomClients = this.rooms.get(roomId)
        if (peerId && roomClients) {
          roomClients.delete(peerId)
          if (roomClients.size === 0) {
            this.rooms.delete(roomId)
            onRoomEmpty(roomId)
          }
          else {
            this.sendUpdatePeers(roomId)
          }
          onPeerLeave(peerId, roomId)
        }
      }

      ws.onerror = (error) => {
        onError(error.error)
      }
    })

    this.wss.on('error', (error: Error) => {
      onError(error)
    })

    this.httpServer.on('error', (error: Error) => {
      onError(error)
    })

    // Start listening
    this.httpServer.listen(port, hostname, () => {
      onServerStart({ port, hostname })
    })

    return this.httpServer
  }

  stop(): void {
    if (this.wss) {
      this.wss.close()
      this.wss = null
    }
    if (this.httpServer) {
      this.httpServer.close()
      this.httpServer = null
    }
  }

  getRooms(): Map<string, Map<string, WebSocketWithData>> {
    return this.rooms
  }

  getRoomCount(): number {
    return this.rooms.size
  }

  getPeersInRoom(roomId: string): string[] {
    const roomClients = this.rooms.get(roomId)
    return roomClients ? Array.from(roomClients.keys()) : []
  }

  private sendUpdatePeers(roomId: string): void {
    const roomClients = this.rooms.get(roomId)
    if (roomClients) {
      const peerIds = Array.from(roomClients.keys())
      const updateMessage = serializeDownlink({
        action: UpdatePeersAction,
        data: peerIds,
        peerId: 'server',
      })
      roomClients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(updateMessage)
        }
      })
    }
  }
}

export function createServer(options: ServerOptions): WebSocketSignalingServer {
  return new WebSocketSignalingServer(options)
}
