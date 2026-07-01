import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type { MaintenanceDomainEvent } from '@pawaac/shared-types';
import {
  DroneStatusChangedEvent,
  EVENT_TRANSPORT,
  EventTransport,
  MAINTENANCE_DUE_EVENT,
  STATUS_CHANGED_EVENT,
} from './event-transport';

interface QueuedEvent {
  eventName: string;
  payload: unknown;
  attempts: number;
}

/** Tunables for {@link ResilientEventPublisher}. */
export interface PublisherOptions {
  /** Maximum delivery attempts before an event is dropped. Defaults to unbounded. */
  maxRetries?: number;
  /** Background flush cadence in milliseconds. */
  flushIntervalMs?: number;
  /** When false, no background timer is started (used by tests). */
  autoFlush?: boolean;
}

/**
 * Publishes domain events through an {@link EventTransport}, queueing and
 * retrying any event whose delivery fails until it succeeds (Requirement 3.4).
 * The queue is drained both immediately after a failure and on a background
 * timer.
 */
@Injectable()
export class ResilientEventPublisher implements OnModuleDestroy {
  private readonly logger = new Logger(ResilientEventPublisher.name);
  private readonly queue: QueuedEvent[] = [];
  private readonly maxRetries: number;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    @Inject(EVENT_TRANSPORT) private readonly transport: EventTransport,
    options: PublisherOptions = {},
  ) {
    this.maxRetries = options.maxRetries ?? Number.POSITIVE_INFINITY;
    if (options.autoFlush ?? true) {
      this.timer = setInterval(() => {
        void this.flush();
      }, options.flushIntervalMs ?? 2000);
      // Do not keep the event loop alive solely for the flush timer.
      this.timer.unref?.();
    }
  }

  /** Broadcasts a drone status-change event. */
  async publishStatusChange(event: DroneStatusChangedEvent): Promise<boolean> {
    return this.publish(STATUS_CHANGED_EVENT, event);
  }

  /** Broadcasts a maintenance-due event for the Alert service. */
  async publishMaintenanceDue(event: MaintenanceDomainEvent): Promise<boolean> {
    return this.publish(MAINTENANCE_DUE_EVENT, event);
  }

  /** Number of events awaiting (re)delivery. */
  get pendingCount(): number {
    return this.queue.length;
  }

  private async publish(eventName: string, payload: unknown): Promise<boolean> {
    const item: QueuedEvent = { eventName, payload, attempts: 0 };
    const delivered = await this.tryDeliver(item);
    if (!delivered) {
      this.queue.push(item);
    }
    return delivered;
  }

  /** Attempts to redeliver every queued event; survivors are re-queued. */
  async flush(): Promise<void> {
    if (this.queue.length === 0) {
      return;
    }
    const pending = this.queue.splice(0, this.queue.length);
    for (const item of pending) {
      const delivered = await this.tryDeliver(item);
      if (!delivered && item.attempts < this.maxRetries) {
        this.queue.push(item);
      }
    }
  }

  private async tryDeliver(item: QueuedEvent): Promise<boolean> {
    try {
      await this.transport.emit(item.eventName, item.payload);
      return true;
    } catch (error) {
      item.attempts += 1;
      this.logger.warn(
        `Delivery of "${item.eventName}" failed (attempt ${item.attempts}); will retry`,
        error instanceof Error ? error.message : String(error),
      );
      return false;
    }
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }
}
