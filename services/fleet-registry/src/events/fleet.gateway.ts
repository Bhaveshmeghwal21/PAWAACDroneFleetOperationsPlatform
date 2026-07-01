import { WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import type { Server } from 'socket.io';
import { EventTransport } from './event-transport';

/**
 * Socket.IO gateway that fans out Fleet Registry real-time events to connected
 * dashboard clients (Requirements 3.1, 3.2). It satisfies the
 * {@link EventTransport} port so the resilient publisher can deliver through it.
 */
@WebSocketGateway({ cors: { origin: '*' } })
export class FleetGateway implements EventTransport {
  @WebSocketServer()
  private readonly server!: Server;

  async emit(eventName: string, payload: unknown): Promise<void> {
    if (!this.server) {
      throw new Error('WebSocket server is not initialised');
    }
    this.server.emit(eventName, payload);
  }
}
