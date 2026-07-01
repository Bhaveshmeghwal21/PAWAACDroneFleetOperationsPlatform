# Ops Dashboard (Service 7)

**Stack:** Next.js 15 · React 19 · TypeScript · Tailwind CSS · Leaflet / react-leaflet · socket.io-client · `@pawaac/shared-types`
**Datastore:** none — consumes the API Gateway exclusively
**Default port:** `3006`

The operator-facing web UI for live operations, mission planning, telemetry, the
alert feed, and detection replay. It reads and writes exclusively through the
API Gateway (REST + WebSocket); it never talks to backend services or datastores
directly.

## Key Surfaces

| Route | Purpose |
|-------|---------|
| `/fleet-map` | Real-time fleet map (Leaflet): live positions, battery, flight mode. |
| `/mission-planner` | Drag-and-drop waypoint editor, geofence drawing, upload. |
| `/telemetry` | Live telemetry panels: attitude, battery graph, EKF2 health, altitude chart. |
| `/alerts` | Alert feed with acknowledge workflow. |
| `/replay` | Detection replay: timeline scrubbing with detections overlaid on the map. |

State logic for each surface lives under `src/lib/` (e.g. `fleet-map-state.ts`,
`mission-planner-state.ts`, `alert-feed-state.ts`, `detection-replay-state.ts`),
unit-tested with Vitest; UI components are in `src/components/`.

## Configuration

The dashboard is configured by two browser-facing variables inlined into the
client bundle at build time (`NEXT_PUBLIC_*`). When running under Docker Compose,
server-side calls use the in-network gateway URL while the browser uses the
host-published URL.

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_ENV` | `production` | Runtime environment. |
| `PORT` | `3006` | HTTP listen port (container). |
| `API_GATEWAY_URL` | `http://api-gateway:3000` | Server-side (in-network) gateway URL. |
| `NEXT_PUBLIC_API_GATEWAY_URL` | `http://localhost:3000` | Browser-facing gateway REST URL. |
| `NEXT_PUBLIC_WS_URL` | `ws://localhost:3000` | Browser-facing gateway WebSocket URL. |

See the root [Environment Variable Reference](../../README.md#environment-variable-reference).

## Run & Test Locally

```bash
pnpm install
pnpm --filter @pawaac/ops-dashboard run dev        # next dev on port 3006
pnpm --filter @pawaac/ops-dashboard run build      # next build (standalone output)
pnpm --filter @pawaac/ops-dashboard run test       # vitest run (unit tests)
pnpm --filter @pawaac/ops-dashboard run test:e2e   # playwright E2E
pnpm --filter @pawaac/ops-dashboard run lint
```

The dev server expects a reachable API Gateway at `NEXT_PUBLIC_API_GATEWAY_URL`
(default `http://localhost:3000`). For a full environment, bring the whole stack
up with Docker Compose from the repo root and open <http://localhost:3006>.
