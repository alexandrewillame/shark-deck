/**
 * Whether a quit has to wait for the renderer's prompt.
 *
 * The renderer knows which screens hold a change nobody applied
 * (renderer/state/leaveGuard.ts) and reports every flip through
 * `setPendingChanges`. While one is pending, index.ts holds a quit — tray
 * Exit, ⌘Q, or closing a window that really closes — shows the window and
 * sends `app:quitRequested`; the renderer asks, and answers with `quitApp`,
 * which lets the next quit through.
 *
 * Kept free of Electron, so the rule can be tested on its own.
 */

let pending = false;
let allowed = false;

/** The renderer's answer to "is anything unapplied?". A renderer that
 *  reloads or crashes holds nothing any more, and says so through here too. */
export function setPendingChanges(next: boolean): void {
  pending = next;
}

/** Hold this quit and ask the renderer first? */
export function shouldAskBeforeQuit(): boolean {
  return pending && !allowed;
}

/** The user answered the prompt (or the session is ending): let quitting through. */
export function allowQuit(): void {
  allowed = true;
}

/** Tests only. */
export function resetQuitGuard(): void {
  pending = false;
  allowed = false;
}
