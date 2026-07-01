import { DroneStatusChangedEvent, STATUS_CHANGED_EVENT } from '../src/events/event-transport';
import { ResilientEventPublisher } from '../src/events/resilient-event-publisher';
import { FlakyTransport, RecordingTransport } from './helpers';

const sampleEvent: DroneStatusChangedEvent = {
  droneId: 'drone-1',
  previousStatus: 'active',
  status: 'maintenance',
  version: 2,
  ts: new Date('2024-01-01T00:00:00.000Z').toISOString(),
};

describe('ResilientEventPublisher (Requirement 3.4)', () => {
  it('delivers immediately when the transport is healthy', async () => {
    const transport = new RecordingTransport();
    const publisher = new ResilientEventPublisher(transport, { autoFlush: false });

    const delivered = await publisher.publishStatusChange(sampleEvent);

    expect(delivered).toBe(true);
    expect(publisher.pendingCount).toBe(0);
    expect(transport.count(STATUS_CHANGED_EVENT)).toBe(1);
  });

  it('queues a failed delivery and retries it on the next flush', async () => {
    const transport = new FlakyTransport(1);
    const publisher = new ResilientEventPublisher(transport, { autoFlush: false });

    const delivered = await publisher.publishStatusChange(sampleEvent);
    expect(delivered).toBe(false);
    expect(publisher.pendingCount).toBe(1);

    await publisher.flush();

    expect(publisher.pendingCount).toBe(0);
    expect(transport.events).toHaveLength(1);
  });

  it('keeps retrying until delivery eventually succeeds', async () => {
    const transport = new FlakyTransport(3);
    const publisher = new ResilientEventPublisher(transport, { autoFlush: false });

    await publisher.publishStatusChange(sampleEvent);
    await publisher.flush(); // attempt 2 fails
    await publisher.flush(); // attempt 3 fails
    expect(publisher.pendingCount).toBe(1);
    await publisher.flush(); // attempt 4 succeeds

    expect(publisher.pendingCount).toBe(0);
    expect(transport.events).toHaveLength(1);
  });
});
