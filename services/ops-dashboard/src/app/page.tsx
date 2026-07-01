import { NAV_ITEMS } from '@/components/app-shell';
import { clientConfig } from '@/lib/config';

/**
 * Landing surface for the operator console. During bootstrap this renders a
 * static overview of the surfaces to come and confirms the gateway/WebSocket
 * endpoints the dashboard is configured to talk to. Live surfaces replace these
 * placeholders in tasks 15.2–15.6.
 */
export default function HomePage() {
  return (
    <section className="mx-auto max-w-3xl space-y-8">
      <div className="space-y-2">
        <h2 className="text-2xl font-semibold">Operations Overview</h2>
        <p className="text-slate-400">
          Live monitoring, mission planning, and incident triage for the drone fleet. Connected
          through the API Gateway.
        </p>
      </div>

      <dl className="grid grid-cols-1 gap-3 rounded-lg border border-slate-800 bg-slate-900 p-4 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-slate-500">API Gateway</dt>
          <dd className="font-mono text-slate-200">{clientConfig.apiGatewayUrl}</dd>
        </div>
        <div>
          <dt className="text-slate-500">WebSocket</dt>
          <dd className="font-mono text-slate-200">{clientConfig.wsUrl}</dd>
        </div>
      </dl>

      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {NAV_ITEMS.map((item) => (
          <li key={item.key} className="rounded-lg border border-slate-800 bg-slate-900 p-4">
            <h3 className="font-medium">{item.label}</h3>
            <p className="mt-1 text-sm text-slate-500">Coming soon.</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
