import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { AppShell } from '@/components/app-shell';

export const metadata: Metadata = {
  title: 'PAWAAC Ops Dashboard',
  description:
    'Operator console for the PAWAAC Drone Fleet Operations Platform: live fleet map, mission planning, telemetry, alerts, and detection replay.',
};

/**
 * Root layout: wraps every route in the persistent operator app shell
 * (header + primary navigation). Individual surfaces render into the shell's
 * main content region.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
