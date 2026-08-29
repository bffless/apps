/**
 * Tailwind v4 for the island build. The islands render Studio's `CutEditor`, whose
 * markup is Tailwind utility classes over Studio's `@theme` tokens — so the island's
 * CSS entry (`islands/<island>/styles.css`) imports `studio/index.css` and points
 * `@source` at the Studio sources the classes live in.
 *
 * Vite resolves a PostCSS config by searching UP from its `root`, and
 * `vite.islands.config.ts` roots each build at `islands/<island>/` — so this file at
 * the app root is what both the island build and any later CSS entry pick up. Studio's
 * own `postcss.config.js` is the same one line (`apps/studio/postcss.config.js`).
 */
export default {
  plugins: {
    '@tailwindcss/postcss': {},
  },
}
