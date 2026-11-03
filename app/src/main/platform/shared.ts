import { exec } from 'node:child_process';
import { shell } from 'electron';

/** Run a shell command, swallowing errors — callers that need to know success
 *  should use `runChecked` instead. Windows-hidden so no console flash. */
export function run(cmd: string): Promise<void> {
  return new Promise((resolve) => exec(cmd, { windowsHide: true }, () => resolve()));
}

/** Run a shell command and report whether it exited cleanly, without ever
 *  throwing. Used where a platform impl tries several candidate commands in
 *  turn and needs to know when to fall through to the next one. */
export function runChecked(cmd: string): Promise<boolean> {
  return new Promise((resolve) => exec(cmd, { windowsHide: true }, (err) => resolve(!err)));
}

/** `shell.openExternal` behind an http(s) guard — identical on every OS. */
export async function openExternal(url: string): Promise<void> {
  if (/^https?:\/\//i.test(url)) await shell.openExternal(url);
}
