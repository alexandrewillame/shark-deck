/**
 * Installs the desktop app's storage — JSON files under Electron's userData
 * folder — before any other module can read or write app data. Imported by
 * index.ts straight after bootstrapEnv, for the same reason that one is first:
 * electron-vite evaluates the bundle top to bottom in import order.
 *
 * The root is resolved on every call, as `app.getPath('userData')` always was.
 */
import { app } from 'electron';
import { installStorage } from './store';
import { createFsStorage } from './store-fs';

installStorage(createFsStorage(() => app.getPath('userData')));
