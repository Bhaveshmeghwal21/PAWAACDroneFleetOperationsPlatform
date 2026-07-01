'use client';

/**
 * Mission Planner route (Requirement 22).
 *
 * Leaflet/react-leaflet must run only in the browser, so the planner component
 * is loaded with `ssr: false`. `next/dynamic` with `ssr: false` is only
 * permitted inside a Client Component, which is why this page is `'use client'`.
 */
import dynamic from 'next/dynamic';

const MissionPlanner = dynamic(
  () => import('@/components/mission-planner').then((mod) => mod.MissionPlanner),
  {
    ssr: false,
    loading: () => <p className="text-sm text-slate-400">Loading mission planner…</p>,
  },
);

export default function MissionPlannerPage() {
  return (
    <section className="h-full">
      <MissionPlanner />
    </section>
  );
}
