import { Module } from '@nestjs/common';
import { EVENT_TRANSPORT, EventTransport } from './event-transport';
import { FleetGateway } from './fleet.gateway';
import { ResilientEventPublisher } from './resilient-event-publisher';

/**
 * Wires the WebSocket gateway as the concrete {@link EventTransport} and the
 * {@link ResilientEventPublisher} that delivers domain events through it with
 * at-least-once retry semantics.
 */
@Module({
  providers: [
    FleetGateway,
    { provide: EVENT_TRANSPORT, useExisting: FleetGateway },
    {
      provide: ResilientEventPublisher,
      useFactory: (transport: EventTransport) => new ResilientEventPublisher(transport),
      inject: [EVENT_TRANSPORT],
    },
  ],
  exports: [ResilientEventPublisher],
})
export class EventsModule {}
