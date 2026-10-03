/// <reference types="vite/client" />

declare module '*.png' {
  const value: string;
  export default value;
}

declare module '*.jpg' {
  const value: string;
  export default value;
}

declare module '*.jpeg' {
  const value: string;
  export default value;
}

declare module '*.svg' {
  const value: string;
  export default value;
}

declare module '*.webp' {
  const value: string;
  export default value;
}

/** `/map-tiles/{version}` — see `vite-plugins/er-data-tiles.ts` and `@/lib/map-tiles`. */
declare const __ER_MAP_TILES_BASE__: string;

/** True for the static GitHub Pages build (`PAGES_BASE_PATH` set) — see `vite.config.ts`. */
declare const __PAGES_BUILD__: boolean;
