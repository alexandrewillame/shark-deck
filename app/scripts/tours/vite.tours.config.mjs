// The browser edition's dev server, with the renderer told it is the desktop
// app (window buttons, auto-switch pill): what the README walkthroughs show.
// Started and stopped by record.mjs.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import base from '../../vite.web.config.ts';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export default {
  ...base,
  define: { ...base.define, __SD_HOST__: JSON.stringify('desktop') },
  cacheDir: resolve(APP, 'node_modules/.vite-tours'),
  server: { host: '127.0.0.1', port: 5181, strictPort: true, hmr: false },
};
