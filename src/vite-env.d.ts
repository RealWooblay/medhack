/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MEDGEMMA_ENDPOINT?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
