import { FleetRegistryService } from '../src/drones/fleet-registry.service';
import { InMemoryDroneStore } from '../src/drones/in-memory-drone-store';
import type { EventTransport } from '../src/events/event-transport';
import { ResilientEventPublisher } from '../src/events/resilient-event-publisher';

/** Records every delivered event; a faithful in-memory transport. */
export class RecordingTransport implements EventTransport {
  public readonly events: Array<{ eventName: string; payload: unknown }> = [];

  async emit(eventName: string, payload: unknown): Promise<void> {
    this.events.push({ eventName, payload });
  }

  count(eventName: string): number {
    return this.events.filter((event) => event.eventName === eventName).length;
  }
}

/** Fails its first `failuresBeforeSuccess` deliveries, then succeeds. */
export class FlakyTransport implements EventTransport {
  public readonly events: Array<{ eventName: string; payload: unknown }> = [];
  private remainingFailures: number;

  constructor(failuresBeforeSuccess: number) {
    this.remainingFailures = failuresBeforeSuccess;
  }

  async emit(eventName: string, payload: unknown): Promise<void> {
    if (this.remainingFailures > 0) {
      this.remainingFailures -= 1;
      throw new Error('transport unavailable');
    }
    this.events.push({ eventName, payload });
  }
}

export interface Harness {
  store: InMemoryDroneStore;
  publisher: ResilientEventPublisher;
  service: FleetRegistryService;
  transport: RecordingTransport;
}

/** Builds a service over the in-memory store with a recording transport. */
export function buildHarness(): Harness {
  const store = new InMemoryDroneStore();
  const transport = new RecordingTransport();
  const publisher = new ResilientEventPublisher(transport, { autoFlush: false });
  const service = new FleetRegistryService(store, publisher);
  return { store, publisher, service, transport };
}
