/**
 * HTTP-layer tests for the historical telemetry query endpoint
 * (`GET /telemetry/:droneId/history`, task 7.7, Requirement 10).
 *
 * The datastore is replaced by a fake {@link HistoryQueryReader} so these tests
 * focus on routing, query-string parsing, the success envelope, the RFC 7807
 * 400 mapping for a `from > to` rejection (Req 10.4), and the 503 when no
 * reader is configured.
 */
import type { AddressInfo } from 'node:net';
import { loadConfig } from './config.js';
import { createApp, type App } from './app.js';
import {
  HistoryQueryValidationError,
  type HistoryQueryInput,
  type HistoryQueryReader,
  type TelemetrySeries,
} from './query/history.js';

const config = loadConfig({ PORT: '0', TRACE_HEADER: 'X-Trace-Id' });
const DRONE_ID = '22222222-2222-2222-2222-222222222222';

function baseUrl(app: App): string {
  const address = app.server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

/** A reader that records its last input and returns a fixed series. */
function fakeReader(): HistoryQueryReader & { lastInput?: HistoryQueryInput } {
  const reader: HistoryQueryReader & { lastInput?: HistoryQueryInput } = {
    queryHistory(input: HistoryQueryInput): Promise<TelemetrySeries> {
      reader.lastInput = input;
      // Mirror the validation contract so an inverted range yields a 400.
      if (Date.parse(input.from) > Date.parse(input.to)) {
        return Promise.reject(new HistoryQueryValidationError('"from" must be <= "to".'));
      }
      return Promise.resolve({
        droneId: input.droneId,
        from: input.from,
        to: input.to,
        bucketSeconds: 1,
        bucketCount: 1,
        source: 'raw',
        points: [
          {
            ts: input.from,
            sampleCount: 1,
            avgAltitude: 100,
            minAltitude: 100,
            maxAltitude: 100,
            avgBatRemainingPct: 50,
            minBatRemainingPct: 50,
            avgRcSignalStrength: 75,
            minRcSignalStrength: 75,
          },
        ],
      });
    },
  };
  return reader;
}

describe('GET /telemetry/:droneId/history (Req 10)', () => {
  let app: App;

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  it('returns 200 with the downsampled series and forwards parsed params', async () => {
    const reader = fakeReader();
    app = createApp({ config, historyReader: reader });
    await app.listen();

    const res = await fetch(
      `${baseUrl(app)}/telemetry/${DRONE_ID}/history?from=2024-01-01T00:00:00Z&to=2024-01-01T01:00:00Z&buckets=10`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as TelemetrySeries;
    expect(body.droneId).toBe(DRONE_ID);
    expect(body.points).toHaveLength(1);

    expect(reader.lastInput).toEqual({
      droneId: DRONE_ID,
      from: '2024-01-01T00:00:00Z',
      to: '2024-01-01T01:00:00Z',
      buckets: '10',
    });
  });

  it('returns 400 problem+json when from > to (Req 10.4)', async () => {
    app = createApp({ config, historyReader: fakeReader() });
    await app.listen();

    const res = await fetch(
      `${baseUrl(app)}/telemetry/${DRONE_ID}/history?from=2024-01-01T02:00:00Z&to=2024-01-01T01:00:00Z`,
    );
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    const body = (await res.json()) as { status: number; title: string; instance: string };
    expect(body.status).toBe(400);
    expect(body.title).toBe('Bad Request');
    expect(body.instance).toBe(`/telemetry/${DRONE_ID}/history`);
  });

  it('returns 503 problem+json when no history reader is configured', async () => {
    app = createApp({ config });
    await app.listen();

    const res = await fetch(`${baseUrl(app)}/telemetry/${DRONE_ID}/history?from=a&to=b`);
    expect(res.status).toBe(503);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    const body = (await res.json()) as { status: number };
    expect(body.status).toBe(503);
  });

  it('echoes the trace id on the history response (Req 34.3)', async () => {
    app = createApp({ config, historyReader: fakeReader() });
    await app.listen();

    const res = await fetch(
      `${baseUrl(app)}/telemetry/${DRONE_ID}/history?from=2024-01-01T00:00:00Z&to=2024-01-01T01:00:00Z`,
      { headers: { 'X-Trace-Id': 'trace-hist-1' } },
    );
    expect(res.headers.get('x-trace-id')).toBe('trace-hist-1');
  });
});
