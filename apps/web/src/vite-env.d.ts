/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the API; empty = same origin (dev: the Vite proxy). */
  readonly VITE_API_BASE_URL?: string;
  /** 'true' includes the /dev debug page in a production build (verification only). Always on under `vite dev`. */
  readonly VITE_DEV_PAGE?: string;
}
