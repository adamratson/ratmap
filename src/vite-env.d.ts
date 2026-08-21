/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_R2_BASE_URL?: string;
  readonly VITE_BASEMAP_PMTILES_URL?: string;
  readonly VITE_TERRAIN_PMTILES_URL?: string;
  readonly VITE_PEAKS_PMTILES_URL?: string;
  readonly VITE_FALLBACK_TERRAIN_URL?: string;
  readonly VITE_USE_FALLBACK_TERRAIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
