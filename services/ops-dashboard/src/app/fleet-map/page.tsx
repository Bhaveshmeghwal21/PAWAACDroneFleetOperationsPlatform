'use client';

/**
 * Fleet Map route (Requirement 21).
 *
 * Leaflet/react-leaflet must run only in the browser, so the map component is
 * loaded with `ssr: false`. `next/dynamic` with `ssr: false` is only permitted
 * inside a Client Component, which is why this page is `'use client'`.
 */
import dynamic from 'next/dynamic';

const FleetMap = dynamic(() => import('@/components/fleet-map').then((mod) => mod.FleetMap), {
  ssr: false,
  loading: () => <p className="text-sm text-slate-400">Loading fleet map…</p>,
});

export default function FleetMapPage() {
  return (
    <section className="h-full">
      <FleetMap />
    </section>
  );
}
