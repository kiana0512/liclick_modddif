import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#0e1020',
        panel: '#151729',
        liclick: {
          pink: '#ff5ccf',
          purple: '#8b5cf6',
          violet: '#6d5dfc',
          orange: '#ff9f43',
        },
      },
      boxShadow: {
        glow: '0 0 32px rgba(139, 92, 246, 0.22)',
      },
    },
  },
  plugins: [],
};

export default config;
