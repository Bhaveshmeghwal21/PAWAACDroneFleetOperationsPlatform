import type { Config } from 'tailwindcss';

/**
 * Tailwind scans the App Router sources for class usage. The map/planner/alert
 * surfaces (tasks 15.2+) live under src/, so a single content glob suffices.
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Operational status palette reused across map markers, panels, and
        // the alert feed once those surfaces are implemented.
        status: {
          active: '#16a34a',
          maintenance: '#d97706',
          decommissioned: '#6b7280',
        },
      },
    },
  },
  plugins: [],
};

export default config;
