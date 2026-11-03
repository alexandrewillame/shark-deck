import { contextBridge, ipcRenderer } from 'electron';

/** Bridge for crash.html only. Mirrors the handlers in src/main/crash.ts. */
contextBridge.exposeInMainWorld('crash', {
  getReport: (): Promise<string> => ipcRenderer.invoke('crash:get-report'),
  /** The page's words in the app's language — see crashStrings in main/crash.ts. */
  getStrings: (): Promise<Record<string, string>> => ipcRenderer.invoke('crash:get-strings'),
  copy: (text: string): Promise<void> => ipcRenderer.invoke('crash:copy', text),
  openLogs: (): Promise<void> => ipcRenderer.invoke('crash:open-logs'),
  restart: (): void => ipcRenderer.send('crash:restart'),
  quit: (): void => ipcRenderer.send('crash:quit'),
});
