/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DEMO_BASEMAP_PMTILES_URL?: string;
  readonly VITE_FALLBACK_TERRAIN_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
