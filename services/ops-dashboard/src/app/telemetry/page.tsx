import { TelemetryPanels } from '@/components/telemetry-panels';

/**
 * Telemetry route (Requirement 23).
 *
 * Renders the live telemetry panels for the selected drone. `TelemetryPanels`
 * is a Client Component (`'use client'`) — its WebSocket subscription and
 * Gateway calls run only in the browser, inside effects — so it can be rendered
 * directly from this server page without disabling SSR (no Leaflet here).
 */
export default function TelemetryPage() {
  return (
    <section className="mx-auto h-full max-w-5xl">
      <TelemetryPanels />
    </section>
  );
}
