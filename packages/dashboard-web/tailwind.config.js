/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        mono: ['JetBrains Mono', 'Menlo', 'Consolas', 'monospace'],
      },
      colors: {
        // Semantic palette — match the README "cockpit, not SaaS dashboard" feel.
        tension: {
          cycle: '#ef4444', // red — invariant breaks
          orphan: '#71717a', // zinc — disconnected
          hub: '#f59e0b', // amber — unstable hub
          adr: '#3b82f6', // blue — ADR-governed
          ok: '#10b981', // green — clean
        },
      },
    },
  },
  plugins: [],
}
