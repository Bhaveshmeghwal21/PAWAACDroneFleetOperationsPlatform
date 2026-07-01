# @pawaac/shared-types

The single source of truth for cross-service DTOs and domain events shared by
every PAWAAC Node service. Keeping these contracts in one place ensures the
gateway, backend services, and dashboard agree on the exact shapes that travel
between them.

**Type:** ESM-only TypeScript library · no runtime datastore · published within
the workspace as `@pawaac/shared-types`.

## What It Provides

The package re-exports each domain module from its entry point so consumers can
import everything from the package root:

| Module | Contents |
|--------|----------|
| `common` | Shared primitives and cross-cutting types. |
| `fleet` | Fleet Registry DTOs (`Drone`, `ComponentLifecycle`, `MaintenanceAlert`, statuses). |
| `mission` | Mission Planning DTOs (`Mission`, `Waypoint`, `Geofence`, conflicts). |
| `telemetry` | Telemetry sample/anomaly types. |
| `vision` | Vision AI detection/track/scene-event types. |
| `alert` | Alert & Notification rule/alert/channel types. |
| `gateway` | Gateway types incl. the `Role` union and auth context. |
| `events` | Cross-service domain event contracts. |
| `guards` | Runtime type guards / narrowing helpers. |

## How Services Consume It

Add it as a workspace dependency (already wired for every Node service):

```jsonc
// package.json
"dependencies": {
  "@pawaac/shared-types": "workspace:*"
}
```

Then import the shared contracts from the package root:

```ts
import type { Drone, Mission, AlertRule, Role } from '@pawaac/shared-types';
```

### Notes for consumers

- The package is **ESM-only** (`"type": "module"`, single `import` export
  condition). CommonJS services (e.g. the API Gateway) consume it via
  `import type` only — importing runtime values would break module resolution at
  boot. Where a runtime value is needed (such as the role privilege ordering),
  the service maintains a locally-typed copy constrained to the shared union so
  it cannot drift.
- It must be **built before dependents** so the emitted `dist/` types are
  available. From the repo root, `pnpm -r run build` builds in topological
  order; the Docker builds for Node services compile from the monorepo root so
  the workspace package resolves.

## Develop, Build & Test

```bash
pnpm install
pnpm --filter @pawaac/shared-types run build      # tsc -b → dist/
pnpm --filter @pawaac/shared-types run test       # vitest run
pnpm --filter @pawaac/shared-types run lint
pnpm --filter @pawaac/shared-types run typecheck
pnpm --filter @pawaac/shared-types run clean      # remove dist + build info
```

Source lives under `src/` (one file per domain module); the public surface is
re-exported from `src/index.ts`.
