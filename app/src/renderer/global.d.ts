/// <reference types="vite/client" />
import type { Api } from '@shared/ipc';

declare global {
  interface Window {
    sharkdeck: Api;
  }
  /** 'browser' in the browser edition's build (vite.web.config.ts); undefined otherwise. See state/host.ts. */
  const __SD_HOST__: string | undefined;
}

export {};
