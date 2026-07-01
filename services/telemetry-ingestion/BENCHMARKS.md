# Telemetry Ingestion — Performance Benchmarks

_Validates: Requirements 32.1, 32.2 (and the underlying ingest target 8.7)._

This document records the sustained-load performance benchmark for **Service 3 —
Telemetry Ingestion**. The benchmark drives the production ingest path with the
load harness in [`src/loadtest/`](./src/loadtest/) and reports the four figures
required by Requirement 32.2: **throughput**, **p50 / p95 / p99 ingest latency**,
and **dropped-frame rate**.

> **Status of the numbers below.** The live figures in the
> [Results](#results) table are **placeholders** that MUST be filled in from a run
> performed in an environment with **Docker + TimescaleDB available** (CI or a
> local machine). They could not be captured in the current build sandbox, which
> has **no Docker daemon and therefore no TimescaleDB / ingest server** to
> connect to. See [Sandbox limitation & in-sandbox verification](#sandbox-limitation--in-sandbox-verification)
> for what _was_ verified here.

---

## Targets / acceptance thresholds

Derived from the requirements and design (Requirement 8.7, Requirement 32.1/32.2,
and the design's _Performance Considerations_ / _Load & Performance Testing_
sections).

| Metric | Target / threshold | Source |
|--------|--------------------|--------|
| Concurrent drone streams | **≥ 10** sustained | Req 32.1, Req 8.7 |
| Per-drone send rate | **10 Hz** sustained | Req 32.1, Req 8.7 |
| Aggregate throughput | **≥ 100 samples/sec** (10 × 10 Hz) with headroom | Design — Performance Considerations |
| p50 / p95 / p99 ingest latency | Recorded (no hard numeric ceiling in spec; expected to stay low and bounded — no unbounded growth under sustained load) | Req 32.2 |
| Dropped-frame rate | Recorded; expected **≈ 0** under the target load (a healthy server applies TCP backpressure rather than dropping) | Req 32.2 |

A run **meets** the benchmark when it sustains ≥ 10 streams at 10 Hz for the full
window, achieves ≥ 100 samples/sec aggregate throughput, and exhibits a
dropped-frame rate at or near zero with bounded latency percentiles.

---

## Methodology

The harness ([`src/loadtest/harness.ts`](./src/loadtest/harness.ts), CLI entry
[`src/loadtest/run.ts`](./src/loadtest/run.ts)) does the following:

1. Opens `LOADTEST_DRONES` (default **10**) authenticated WebSocket connections to
   the ingest server's `/ingest` endpoint, each with a distinct `droneId` and the
   shared `DRONE_AUTH_TOKEN` (Req 8.1).
2. From each connection, streams **real, CRC-correct MAVLink v2 frames** — built
   with the production [`encode`](./src/mavlink/codec.ts) codec — at
   `LOADTEST_RATE_HZ` (default **10 Hz**) for `LOADTEST_DURATION_MS`
   (default **10 000 ms**). Samples carry strictly increasing per-drone
   timestamps so the server accepts them (Req 8.5) rather than dropping as
   non-monotonic.
3. After the window closes, waits `LOADTEST_DRAIN_MS` (default **1 000 ms**) for
   in-flight sends to settle, closes every socket, and aggregates the metrics.
4. Prints a single JSON summary to stdout (the exact object transcribed into the
   [Results](#results) table) and exits non-zero if **no** drone connected (a run
   that connects nothing is a failed benchmark, not a passing one).

### Metrics captured

| Field (JSON) | Meaning |
|--------------|---------|
| `throughputFps` | Aggregate sustained throughput = confirmed-sent frames ÷ measured window seconds (samples/sec). |
| `sendLatencyMs.p50` / `.p95` / `.p99` | Ingest latency percentiles (ms), inclusive linear-interpolation method. |
| `droppedFrameRate` | `droppedFrames / scheduledFrames` ∈ `[0, 1]`, where dropped = scheduled − confirmed-sent. |
| `connectedDrones` | Streams that opened and acknowledged subscription (should equal the requested drone count). |
| `scheduledFrames` / `sentFrames` / `failedFrames` | Raw frame accounting feeding the rates above. |

#### Latency proxy note

The ingest protocol acknowledges the **subscription** once (Req 8.1) but emits no
per-frame application ACK, and frames are persisted in **asynchronous batches**.
There is therefore no end-to-end "frame persisted" signal a client can observe
without changing the server contract. The harness instead measures
**send-completion latency** (`ws.send` → transport-flushed callback), reported as
`sendLatencyMs`. Under sustained load this is a faithful proxy for ingest latency:
a server that cannot keep up exerts TCP backpressure, which delays exactly this
callback. The field is named `sendLatencyMs` to keep the proxy explicit. (A future
task may add an echo/ack frame for true round-trip latency.)

---

## How to reproduce

Requires Docker (for TimescaleDB) and a running ingest server. From the repo root:

```bash
# 1. Start TimescaleDB + the ingest server (Docker Compose brings up the DB,
#    applies migrations, and starts the service on port 3003).
docker compose up -d timescaledb-telemetry telemetry-ingestion

# — or run the server directly against an already-running TimescaleDB —
cd services/telemetry-ingestion
pnpm migrate:up                       # create the hypertable
DRONE_AUTH_TOKEN=<token> PORT=3003 pnpm start &

# 2. Run the load harness (builds, then runs dist/loadtest/run.js).
DRONE_AUTH_TOKEN=<token> pnpm loadtest
```

### Configuration (environment variables)

| Variable | Default | Description |
|----------|---------|-------------|
| `DRONE_AUTH_TOKEN` | _(required)_ | Shared drone auth token the server expects (Req 8.1). |
| `TARGET_URL` | `ws://127.0.0.1:3003` | WebSocket base URL of the ingest server. |
| `LOADTEST_PATH` | `/ingest` | WebSocket path. |
| `LOADTEST_DRONES` | `10` | Concurrent drone streams (Req 32.1 floor). |
| `LOADTEST_RATE_HZ` | `10` | Per-drone send rate in Hz (Req 32.1). |
| `LOADTEST_DURATION_MS` | `10000` | Sustained send window in ms. |
| `LOADTEST_DRAIN_MS` | `1000` | Post-window grace for in-flight sends. |

The harness prints a JSON summary like:

```json
{
  "config": { "url": "ws://127.0.0.1:3003", "path": "/ingest", "drones": 10, "rateHz": 10, "durationMs": 10000 },
  "connectedDrones": 10,
  "scheduledFrames": 1000,
  "sentFrames": 1000,
  "droppedFrames": 0,
  "droppedFrameRate": 0,
  "throughputFps": 100.0,
  "sendLatencyMs": { "count": 1000, "min": 0.1, "max": 5.0, "mean": 0.8, "p50": 0.6, "p95": 1.9, "p99": 3.2 }
}
```

Copy the corresponding fields into the [Results](#results) table and update the
metadata row.

---

## Results

> ⚠️ **PLACEHOLDERS — replace with figures from a Docker/TimescaleDB-backed run.**
> The values below are not measured numbers; they are `TBD` pending a live run in
> CI or on a machine with the datastore available.

**Run metadata**

| Field | Value |
|-------|-------|
| Date (UTC) | `TBD` |
| Environment | `TBD` (e.g. CI runner / local; CPU, RAM) |
| Drones × rate × duration | 10 × 10 Hz × 10 s (defaults) |
| Server commit | `TBD` |

**Measured metrics (Req 32.2)**

| Metric | Result | Target | Pass? |
|--------|--------|--------|:-----:|
| Connected drones | `TBD` | 10 | `TBD` |
| Aggregate throughput (samples/sec) | `TBD` | ≥ 100 | `TBD` |
| p50 ingest latency (ms) | `TBD` | bounded | `TBD` |
| p95 ingest latency (ms) | `TBD` | bounded | `TBD` |
| p99 ingest latency (ms) | `TBD` | bounded | `TBD` |
| Dropped-frame rate | `TBD` | ≈ 0 | `TBD` |

---

## Sandbox limitation & in-sandbox verification

The build sandbox used to author this document has **no Docker daemon**, so the
TimescaleDB instance and the ingest WebSocket server the harness connects to were
not available. Live throughput/latency/drop numbers therefore **must be captured
elsewhere** (CI or a local machine with Docker) and pasted into the
[Results](#results) table above.

What _was_ verified in the sandbox (green-before-proceed for the runnable parts):

- **Harness compiles.** `npm run build` (`tsc`) succeeds; `dist/loadtest/run.js`
  is produced.
- **CLI argument parsing works.** Invoking the runner with no `DRONE_AUTH_TOKEN`
  fails fast with a clear error; supplying configuration via the documented env
  vars is parsed and echoed into the run config.
- **End-to-end harness execution is graceful with no server.** A short run
  (`LOADTEST_DURATION_MS=2000`) against the default target with no server present
  completes and reports a well-formed result with `connectedDrones: 0`,
  `throughputFps: 0`, an empty latency summary, and the per-drone
  `ECONNREFUSED 127.0.0.1:3003` connection errors surfaced in `errors[]`. The
  process exits non-zero, correctly flagging "no connections" as a failed
  benchmark. _(This is the expected in-sandbox outcome — it confirms the harness
  is wired correctly, not a performance measurement.)_
- **Metric computation is unit-tested and green.** The pure statistics helpers
  (`percentile`, `summarizeLatency`, `ratio`) that produce the p50/p95/p99,
  throughput, and dropped-frame figures pass their full unit suite
  (`src/loadtest/stats.test.ts`, 12/12 passing), including edge cases (empty sets,
  single element, ordering independence, no input mutation, p=0/p=100).

In short: the benchmark **harness and its metric math are verified**; only the
**live datastore-backed measurements remain** to be filled in from a CI/local run.
