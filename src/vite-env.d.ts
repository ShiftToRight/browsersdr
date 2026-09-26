/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BUILD_ID?: string;
  readonly VITE_BUILD_TIMESTAMP?: string;
  readonly VITE_DIAGNOSTIC_ENDPOINT?: string;
}
