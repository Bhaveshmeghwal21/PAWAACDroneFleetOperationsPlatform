'use client';

/**
 * Live telemetry panels for the selected drone (Requirement 23).
 *
 * Renders four panels — attitude indicator, battery graph, EKF2 health, and
 * altitude chart — that update in real time as telemetry arrives:
 *   - the panel set is shown for the selected drone (Requirement 23.1)
 *   - each panel is wrapped in its own error boundary so a render failure in
 *     one panel shows a fallback for that panel without taking down the others
 *     (Requirement 23.2)
 *   - the panels re-render whenever the underlying telemetry state changes
 *     (Requirement 23.3)
 *
 * Following the fleet-map (task 15.2) pattern, all non-visual logic lives in the
 * pure, unit-tested `lib/telemetry-panel-state` module (latest snapshot + bounded
 * rolling series + sparkline geometry). This component is the thin React adapter
 * that seeds recent history from the Gateway, subscribes to the telemetry
 * socket, and renders the panels.
 */
import { Component, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Attitude, BatteryState, Ekf2State, Uuid } from '@pawaac/shared-types';

import { apiClient, type GatewayApiClient } from '@/lib/api-client';
import {
  createTelemetrySocket,
  type SocketAuthOptions,
  type TelemetrySocket,
} from '@/lib/ws-client';
import {
  applyPanelSample,
  buildSparkline,
  emptyPanelState,
  getDronePanel,
  latestAttitude,
  latestBattery,
  latestEkf2,
  listPanelDroneIds,
  radiansToDegrees,
  seedPanelSamples,
  type DronePanelData,
  type SeriesPoint,
  type TelemetryPanelState,
} from '@/lib/telemetry-panel-state';

/** Slice of the Gateway client the panels depend on (eases testing). */
type TelemetryPanelClient = Pick<GatewayApiClient, 'listDrones' | 'getRecentTelemetry'>;

export interface TelemetryPanelsProps {
  /** Gateway client; defaults to the shared configured instance. */
  client?: TelemetryPanelClient;
  /** Telemetry socket factory; defaults to `createTelemetrySocket`. */
  createSocket?: (options?: SocketAuthOptions) => TelemetrySocket;
  /** JWT forwarded to the Gateway/socket for authenticated streams. */
  token?: string;
  /** Optionally preselect a drone (otherwise the first known drone is used). */
  initialDroneId?: Uuid;
}

/* ------------------------------------------------------------------------- */
/* Per-panel error boundary (Requirement 23.2)                               */
/* ------------------------------------------------------------------------- */

interface PanelBoundaryProps {
  title: string;
  children: ReactNode;
}

interface PanelBoundaryState {
  hasError: boolean;
}

/**
 * Isolates a single panel: if its subtree throws while rendering, this boundary
 * shows fallback content for that panel only, leaving the sibling panels intact
 * (Requirement 23.2). React error boundaries must be class components.
 */
export class PanelErrorBoundary extends Component<PanelBoundaryProps, PanelBoundaryState> {
  constructor(props: PanelBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): PanelBoundaryState {
    return { hasError: true };
  }

  override render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div
          className="flex h-full flex-col items-center justify-center gap-1 rounded-lg border border-red-900 bg-red-950/40 p-4 text-center"
          role="alert"
          data-testid={`panel-error-${slug(this.props.title)}`}
        >
          <span aria-hidden className="text-lg">
            ⚠
          </span>
          <p className="text-sm font-medium text-red-300">{this.props.title} unavailable</p>
          <p className="text-xs text-red-400/80">This panel failed to render.</p>
        </div>
      );
    }
    return this.props.children;
  }
}

/** A titled panel card wrapping its content in an error boundary. */
function Panel({ title, testId, children }: { title: string; testId: string; children: ReactNode }) {
  return (
    <section
      className="flex flex-col gap-3 rounded-lg border border-slate-800 bg-slate-900 p-4"
      data-testid={testId}
    >
      <h3 className="text-sm font-semibold text-slate-200">{title}</h3>
      <div className="min-h-[7rem] flex-1">
        <PanelErrorBoundary title={title}>{children}</PanelErrorBoundary>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------------- */
/* Individual panels                                                         */
/* ------------------------------------------------------------------------- */

function AttitudePanel({ attitude }: { attitude: Attitude | undefined }) {
  if (!attitude) {
    return <EmptyPanel label="Awaiting attitude…" />;
  }
  const rollDeg = radiansToDegrees(attitude.roll);
  const pitchDeg = radiansToDegrees(attitude.pitch);
  const yawDeg = radiansToDegrees(attitude.yaw);

  return (
    <div className="flex items-center gap-4" data-testid="attitude-readout">
      {/* A simple artificial-horizon disc rotated by roll and shifted by pitch. */}
      <div className="relative h-24 w-24 overflow-hidden rounded-full border border-slate-700 bg-slate-950">
        <div
          className="absolute inset-[-50%]"
          style={{ transform: `rotate(${-rollDeg}deg) translateY(${clamp(pitchDeg, -45, 45) * 0.6}px)` }}
        >
          <div className="h-1/2 w-full bg-sky-700/70" />
          <div className="h-1/2 w-full bg-amber-800/70" />
        </div>
        <div className="absolute left-1/2 top-1/2 h-0.5 w-10 -translate-x-1/2 -translate-y-1/2 bg-white/80" />
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-slate-500">Roll</dt>
        <dd className="font-mono text-slate-200">{formatDeg(rollDeg)}</dd>
        <dt className="text-slate-500">Pitch</dt>
        <dd className="font-mono text-slate-200">{formatDeg(pitchDeg)}</dd>
        <dt className="text-slate-500">Yaw</dt>
        <dd className="font-mono text-slate-200">{formatDeg(yawDeg)}</dd>
      </dl>
    </div>
  );
}

function BatteryPanel({
  battery,
  series,
}: {
  battery: BatteryState | undefined;
  series: SeriesPoint[];
}) {
  if (!battery) {
    return <EmptyPanel label="Awaiting battery…" />;
  }
  const pct = clamp(battery.remainingPct, 0, 100);
  const barColor = pct <= 20 ? '#ef4444' : pct <= 40 ? '#f59e0b' : '#22c55e';

  return (
    <div className="flex flex-col gap-3" data-testid="battery-readout">
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-2xl text-slate-100">{Math.round(pct)}%</span>
        <span className="text-xs text-slate-400">
          {battery.voltage.toFixed(1)} V · {battery.current.toFixed(1)} A
        </span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded bg-slate-800">
        <div className="h-full rounded" style={{ width: `${pct}%`, backgroundColor: barColor }} />
      </div>
      <Sparkline series={series} stroke={barColor} label="Battery remaining percentage trend" />
    </div>
  );
}

function Ekf2Panel({ ekf2 }: { ekf2: Ekf2State | undefined }) {
  if (!ekf2) {
    return <EmptyPanel label="Awaiting EKF2 health…" />;
  }
  const color = ekf2.healthy ? 'text-emerald-400' : 'text-red-400';
  const dot = ekf2.healthy ? 'bg-emerald-500' : 'bg-red-500';

  return (
    <div className="flex flex-col gap-2" data-testid="ekf2-readout">
      <div className="flex items-center gap-2">
        <span aria-hidden className={`inline-block h-3 w-3 rounded-full ${dot}`} />
        <span className={`text-lg font-semibold ${color}`}>{ekf2.healthy ? 'Healthy' : 'Degraded'}</span>
      </div>
      <p className="text-xs text-slate-400">
        Unhealthy flags: <span className="font-mono text-slate-200">0x{ekf2.flags.toString(16)}</span>
      </p>
    </div>
  );
}

function AltitudePanel({
  altitude,
  series,
}: {
  altitude: number | undefined;
  series: SeriesPoint[];
}) {
  if (altitude === undefined) {
    return <EmptyPanel label="Awaiting altitude…" />;
  }
  return (
    <div className="flex flex-col gap-3" data-testid="altitude-readout">
      <span className="font-mono text-2xl text-slate-100">{altitude.toFixed(1)} m</span>
      <Sparkline series={series} stroke="#38bdf8" label="Altitude trend" />
    </div>
  );
}

/** Inline SVG sparkline driven by the pure `buildSparkline` geometry. */
function Sparkline({ series, stroke, label }: { series: SeriesPoint[]; stroke: string; label: string }) {
  const width = 220;
  const height = 56;
  const spark = useMemo(() => buildSparkline(series, width, height), [series]);

  if (spark.points.length === 0) {
    return <p className="text-xs text-slate-500">No history yet.</p>;
  }

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-14 w-full"
      role="img"
      aria-label={label}
      preserveAspectRatio="none"
    >
      <polyline
        points={spark.polyline}
        fill="none"
        stroke={stroke}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

function EmptyPanel({ label }: { label: string }) {
  return <p className="text-sm text-slate-500">{label}</p>;
}

/* ------------------------------------------------------------------------- */
/* Live subscription hook                                                    */
/* ------------------------------------------------------------------------- */

/**
 * Subscribe to the live telemetry state: seed recent history for the selected
 * drone from the Gateway, then keep it live via the telemetry socket. All
 * transitions go through the pure reducers.
 */
function useTelemetryPanels(
  client: TelemetryPanelClient,
  makeSocket: () => TelemetrySocket,
  selectedDroneId: Uuid | undefined,
  token: string | undefined,
): TelemetryPanelState {
  const [state, setState] = useState<TelemetryPanelState>(emptyPanelState);

  // Seed recent history for the selected drone so the charts start populated.
  useEffect(() => {
    if (!selectedDroneId) {
      return;
    }
    let cancelled = false;
    client
      .getRecentTelemetry(selectedDroneId, token)
      .then((samples) => {
        if (!cancelled) {
          setState((prev) => seedPanelSamples(prev, selectedDroneId, samples));
        }
      })
      .catch(() => {
        // A failed seed is non-fatal: the live socket still populates the panels.
      });
    return () => {
      cancelled = true;
    };
  }, [client, selectedDroneId, token]);

  // Keep the panels live over the telemetry socket.
  useEffect(() => {
    const socket = makeSocket();
    socket.on('telemetry:sample', (sample) => {
      setState((prev) => applyPanelSample(prev, sample));
    });
    socket.connect();
    return () => {
      socket.off('telemetry:sample');
      socket.disconnect();
    };
  }, [makeSocket]);

  return state;
}

/* ------------------------------------------------------------------------- */
/* Container                                                                 */
/* ------------------------------------------------------------------------- */

export function TelemetryPanels({
  client = apiClient,
  createSocket = createTelemetrySocket,
  token,
  initialDroneId,
}: TelemetryPanelsProps = {}) {
  const [drones, setDrones] = useState<{ id: Uuid; label: string }[]>([]);
  const [selectedDroneId, setSelectedDroneId] = useState<Uuid | undefined>(initialDroneId);

  // Populate the drone selector from the registry (via the Gateway).
  useEffect(() => {
    let cancelled = false;
    client
      .listDrones(token)
      .then((list) => {
        if (cancelled) {
          return;
        }
        setDrones(list.map((d) => ({ id: d.id, label: d.serialNumber || d.id })));
        setSelectedDroneId((current) => current ?? list[0]?.id);
      })
      .catch(() => {
        // Selector stays empty; live drones still appear via telemetry below.
      });
    return () => {
      cancelled = true;
    };
  }, [client, token]);

  const makeSocket = useMemo(
    () => () => createSocket(token ? { token } : {}),
    [createSocket, token],
  );

  const state = useTelemetryPanels(client, makeSocket, selectedDroneId, token);

  // Drone ids that have produced telemetry but aren't in the registry selector.
  const liveOnlyIds = useMemo(() => {
    const known = new Set(drones.map((d) => d.id));
    return listPanelDroneIds(state).filter((id) => !known.has(id));
  }, [drones, state]);

  // Fall back to the first drone that is actually streaming if none chosen yet.
  const effectiveDroneId = selectedDroneId ?? drones[0]?.id ?? listPanelDroneIds(state)[0];
  const panel: DronePanelData | undefined = getDronePanel(state, effectiveDroneId);

  return (
    <div className="flex h-full flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Live Telemetry</h2>
        <label className="flex items-center gap-2 text-xs text-slate-400">
          <span>Drone</span>
          <select
            value={effectiveDroneId ?? ''}
            onChange={(event) => setSelectedDroneId(event.target.value || undefined)}
            className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-slate-200"
            data-testid="drone-select"
          >
            {drones.length === 0 && liveOnlyIds.length === 0 ? (
              <option value="">No drones</option>
            ) : null}
            {drones.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
            {liveOnlyIds.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
      </div>

      {effectiveDroneId ? (
        <span className="text-xs text-slate-500" data-testid="selected-drone">
          {panel?.lastTs ? `Last update ${panel.lastTs}` : 'Awaiting telemetry…'}
        </span>
      ) : (
        <p className="text-sm text-slate-500">Select a drone to view live telemetry.</p>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2" data-testid="telemetry-panels">
        <Panel title="Attitude" testId="panel-attitude">
          <AttitudePanel attitude={latestAttitude(panel)} />
        </Panel>
        <Panel title="Battery" testId="panel-battery">
          <BatteryPanel battery={latestBattery(panel)} series={panel?.batterySeries ?? []} />
        </Panel>
        <Panel title="EKF2 Health" testId="panel-ekf2">
          <Ekf2Panel ekf2={latestEkf2(panel)} />
        </Panel>
        <Panel title="Altitude" testId="panel-altitude">
          <AltitudePanel altitude={panel?.latest?.altitude} series={panel?.altitudeSeries ?? []} />
        </Panel>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------- */
/* Small helpers                                                             */
/* ------------------------------------------------------------------------- */

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function formatDeg(value: number): string {
  return `${value.toFixed(1)}°`;
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

export default TelemetryPanels;
