/**
 * Socket.IO gateway for the in-app alert channel.
 *
 * This is bootstrap scaffolding only: it accepts client connections and tracks
 * them so later tasks (11.2+) can push raised alerts to connected operators.
 * No rule evaluation, dispatch or escalation is implemented here.
 */
import { Logger } from '@nestjs/common';
import {
  WebSocketGateway,
  WebSocketServer,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import type { Alert } from '@pawaac/shared-types';

@WebSocketGateway({ namespace: '/alerts', cors: { origin: '*' } })
export class AlertsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(AlertsGateway.name);

  @WebSocketServer()
  server!: Server;

  handleConnection(client: Socket): void {
    this.logger.log(`Alert subscriber connected: ${client.id}`);
  }

  handleDisconnect(client: Socket): void {
    this.logger.log(`Alert subscriber disconnected: ${client.id}`);
  }

  /**
   * Transport primitive used by the dispatch layer (task 11.2+) to push a
   * raised alert to all connected in-app subscribers. The shared `Alert` DTO
   * keeps the wire contract consistent across services.
   */
  broadcast(alert: Alert): void {
    this.server.emit('alert', alert);
  }
}
