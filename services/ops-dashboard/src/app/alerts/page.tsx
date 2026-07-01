import { AlertFeed } from '@/components/alert-feed';

/**
 * Alerts route (Requirement 24).
 *
 * Renders the live alert feed. `AlertFeed` is a Client Component (`'use
 * client'`) — its WebSocket subscription and acknowledge actions run only in
 * the browser, inside effects/handlers — so it can be rendered directly from
 * this server page without disabling SSR.
 */
export default function AlertsPage() {
  return (
    <section className="mx-auto h-full max-w-3xl">
      <AlertFeed />
    </section>
  );
}
