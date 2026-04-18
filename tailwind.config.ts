// Tailwind v4 is CSS-first — this file is NOT loaded by the build.
// Configuration lives in app/globals.css via @theme / @source directives.
// Kept for reference/IDE tooling awareness.
import type { Config } from 'tailwindcss';
const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: { extend: {} },
  plugins: [],
};
export default config;
