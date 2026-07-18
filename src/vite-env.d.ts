/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MEDGEMMA_ENDPOINT?: string
  readonly VITE_MEDGEMMA_MODEL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
