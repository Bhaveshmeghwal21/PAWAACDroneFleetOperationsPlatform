'use client';

/**
 * Detection Replay route (Requirement 25).
 *
 * Leaflet/react-leaflet must run only in the browser, so the replay component
 * is loaded with `ssr: false`. `next/dynamic` with `ssr: false` is only
 * permitted inside a Client Component, which is why this page is `'use client'`.
 */
import dynamic from 'next/dynamic';

const DetectionReplay = dynamic(
  () => import('@/components/detection-replay').then((mod) => mod.DetectionReplay),
  {
    ssr: false,
    loading: () => <p className="text-sm text-slate-400">Loading detection replay…</p>,
  },
);

export default function ReplayPage() {
  return (
    <section className="h-full">
      <DetectionReplay />
    </section>
  );
}
