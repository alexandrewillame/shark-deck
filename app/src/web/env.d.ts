/**
 * Build-time constants the browser edition's Vite config (vite.web.config.ts)
 * defines. Absent under vitest and in the desktop build, so read them behind
 * a `typeof` check.
 */
declare const __SD_APP_VERSION__: string | undefined;
