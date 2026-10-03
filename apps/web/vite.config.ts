import babel from '@rolldown/plugin-babel';
import { devtools } from '@tanstack/devtools-vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import tailwindcss from '@tailwindcss/vite';
import viteReact, { reactCompilerPreset } from '@vitejs/plugin-react';
import { nitro } from 'nitro/vite';
import path from 'node:path';
// Pure Vite build/plugins config for the app (`vite dev`/`vite build`). The Vitest test
// PROJECTS live in the root `vitest.config.ts` + `apps/web/vitest.config{,.browser}.ts`,
// which `mergeConfig` THIS config to inherit the plugins below. `defineConfig` from
// `vitest/config` (a superset of Vite's) keeps it importable from those configs.
import { defineConfig } from 'vitest/config';
import { erDataTiles } from './vite-plugins/er-data-tiles.ts';

// Vitest sets this. The app-server plugins below (devtools/tanstackStart/nitro) are only needed for
// `vite dev`/`vite build`; under Vitest they break browser mode (`react: module is not defined`
// during dep-scan) and leave the process hanging. Vitest always runs ROOT plugin hooks even for
// standalone projects, so excluding them here — not just in the perf project — is what keeps the
// browser run clean. Tests get only react + tailwind + wasm + erDataTiles (map-tile middleware).
// On Vercel CI, Nitro auto-detects the `VERCEL` env and switches to its `vercel` preset, emitting
// the Build Output API to `.vercel/output` (NOT `.output`). In a monorepo Vercel only auto-detects
// that dir at the REPO ROOT, but Nitro writes it relative to its cwd (apps/web) — so redirect the
// output up two levels. Locally (no VERCEL) the default node-server preset + `.output` is untouched.
// GitHub Pages (static hosting, no server): set `PAGES_BASE_PATH` to the site's sub-path
// (`/<repo>/` for a project page, `/` for a user/org page). Vite's `base` follows it, and
// TanStack Start derives the router basepath from that. The build switches to Start's SPA
// mode: all routing is client-side (the app has no server functions/loaders), and the build
// prerenders one HTML shell, `.output/public/_shell.html`. The deploy step
// (.github/workflows/pages.yml) publishes `.output/public` as-is, with that shell copied to
// `index.html` + `404.html` (the Pages SPA fallback). Nitro keeps its default node-server
// preset here on purpose: Start's shell prerender runs against Nitro's preview server, and
// the static `github-pages` preset has no server to answer it under a base path.
// Unset = the normal SSR build (Vercel / node-server), unchanged.
const PAGES_BASE_PATH = process.env.PAGES_BASE_PATH;

const appOnlyPlugins = process.env.VITEST
  ? []
  : [
      devtools(),
      PAGES_BASE_PATH
        ? tanstackStart({ spa: { enabled: true } })
        : tanstackStart({ prerender: { enabled: false } }),
      nitro({
        // Files under `public/` aren't fingerprinted, so Nitro/Vercel serve them
        // `max-age=0, must-revalidate` — every map pan re-validated every tile (one billed edge
        // request per 304). The tile prefix is content-versioned (`/map-tiles/{hash}/`, see
        // `vite-plugins/er-data-tiles.ts`), so the whole tree is safe to cache for a year. Nitro's
        // vercel preset emits this as a route in `.vercel/output/config.json`; the node preset
        // applies it at runtime, so local `.output` previews match.
        routeRules: {
          '/map-tiles/**': {
            headers: { 'cache-control': 'public, max-age=31536000, immutable' },
          },
        },
        ...(process.env.VERCEL
          ? { output: { dir: path.resolve(import.meta.dirname, '../../.vercel/output') } }
          : {}),
      }),
    ];

// React Compiler (plugin-react v6 removed the inline babel option, so this runs via
// @rolldown/plugin-babel). MUST come after viteReact() — the preset's rolldown filter only
// applies it to the client environment and to files that look like components/hooks. Gated out of
// VITEST for the same reason as appOnlyPlugins: tests run on the un-compiled source.
const reactCompilerPlugins = process.env.VITEST
  ? []
  : [babel({ presets: [reactCompilerPreset()] })];

export default defineConfig({
  ...(PAGES_BASE_PATH ? { base: PAGES_BASE_PATH } : {}),
  define: { __PAGES_BUILD__: JSON.stringify(Boolean(PAGES_BASE_PATH)) },
  server: {
    port: 3005,
    strictPort: true,
  },
  build: {
    // Item icons + their 80px thumbnails are resolved via `import.meta.glob(…, '?url')`
    // in `@elden-ring-compass/data/images`. The thumbnails are <4KB, so Vite's default
    // 4KB inline limit would base64-inline ~2.7k of them into the JS bundle (a ~9MB
    // `images` chunk). Force every icon asset to emit as a real, HTTP-cacheable,
    // lazily-fetched file instead. `undefined` = Vite's default for all other assets.
    assetsInlineLimit: (filePath: string) =>
      filePath.includes('/icons/items') ? false : undefined,
  },
  // `viteReact()` MUST come after `tanstackStart()` — the TanStack Router plugin (inside
  // tanstackStart/appOnlyPlugins) has to run before the JSX transform. Under VITEST appOnlyPlugins
  // is empty, so react ends up last either way.
  plugins: [erDataTiles(), tailwindcss(), ...appOnlyPlugins, viteReact(), ...reactCompilerPlugins],
  resolve: {
    tsconfigPaths: true,
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
});
