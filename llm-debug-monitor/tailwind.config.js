/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Portico Sans', 'system-ui', 'sans-serif'],
      },
      colors: {
        'monitor-bg': '#0f172a',
        'monitor-card': '#1e293b',
        'monitor-border': '#334155',
        'monitor-accent': '#3b82f6',
        'monitor-success': '#22c55e',
        'monitor-warning': '#f59e0b',
        'monitor-error': '#ef4444',
      },
      typography: {
        DEFAULT: {
          css: {
            color: 'inherit',
            a: { color: '#60a5fa' },
            strong: { color: 'inherit' },
            code: {
              color: '#f472b6',
              backgroundColor: 'rgba(0,0,0,0.3)',
              borderRadius: '0.25rem',
              padding: '0.125rem 0.25rem',
            },
            'code::before': { content: '""' },
            'code::after': { content: '""' },
            pre: {
              backgroundColor: 'rgba(0,0,0,0.3)',
              color: '#e2e8f0',
            },
            h1: { color: 'inherit' },
            h2: { color: 'inherit' },
            h3: { color: 'inherit' },
            h4: { color: 'inherit' },
            blockquote: { color: 'inherit', borderLeftColor: '#475569' },
          },
        },
      },
    },
  },
  plugins: [
    require('@tailwindcss/typography'),
  ],
}
