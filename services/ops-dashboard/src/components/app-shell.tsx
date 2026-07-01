import type { ReactNode } from 'react';

/**
 * The primary navigation destinations of the operator console. Each maps to a
 * surface delivered by a later task in Service 7:
 *   - Fleet Map        -> task 15.2
 *   - Mission Planner  -> task 15.3
 *   - Telemetry        -> task 15.4
 *   - Alerts           -> task 15.5
 *   - Replay           -> task 15.6
 */
export const NAV_ITEMS = [
  { key: 'fleet-map', label: 'Fleet Map' },
  { key: 'mission-planner', label: 'Mission Planner' },
  { key: 'telemetry', label: 'Telemetry' },
  { key: 'alerts', label: 'Alerts' },
  { key: 'replay', label: 'Replay' },
] as const;

/**
 * Persistent application shell: a top bar with product identity and a primary
 * navigation rail. Kept presentational/static during bootstrap; routing and
 * live state are wired in as each surface lands.
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between border-b border-slate-800 bg-slate-900 px-6 py-3">
        <div className="flex items-center gap-3">
          <span aria-hidden className="inline-block h-3 w-3 rounded-full bg-status-active" />
          <h1 className="text-base font-semibold tracking-tight">PAWAAC Ops Dashboard</h1>
        </div>
        <nav aria-label="Primary">
          <ul className="flex gap-4 text-sm text-slate-300">
            {NAV_ITEMS.map((item) => (
              <li key={item.key}>{item.label}</li>
            ))}
          </ul>
        </nav>
      </header>
      <main className="flex-1 p-6">{children}</main>
    </div>
  );
}
