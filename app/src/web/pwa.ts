/**
 * The installable, offline side of the browser edition: registers the
 * service worker (src/web/sw.ts) and, once a newer deploy has been fetched in
 * the background, offers to restart into it.
 *
 * Nothing restarts on its own. The banner waits for the user, and its button
 * waits for any device write in flight to finish first — reloading the page
 * in the middle of one could leave a device half-configured.
 */
import { getT } from '@shared/i18n';

type Say = ReturnType<typeof getT>;

/** How often a long-lived tab asks for a newer deploy when it comes back into view. */
const UPDATE_CHECK_MS = 60 * 60 * 1000;

export function registerServiceWorker(opts: {
  language: () => string;
  writesInFlight: () => number;
}): void {
  // The dev server rebuilds on every save; a worker serving its cache there
  // would only get in the way.
  if (import.meta.env.DEV || !('serviceWorker' in navigator)) return;

  let restartRequested = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // The very first install also takes control (clients.claim) — that must
    // not reload anything. Only the restart the user asked for does.
    if (restartRequested) location.reload();
  });

  navigator.serviceWorker
    .register('./sw.js', { scope: './' })
    .then((reg) => {
      const offer = (worker: ServiceWorker) =>
        showUpdateBanner(getT(opts.language()), () => {
          restartRequested = true;
          whenIdle(opts.writesInFlight, () => worker.postMessage('activate-update'));
        });
      // Downloaded on an earlier visit and still waiting.
      if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const incoming = reg.installing;
        incoming?.addEventListener('statechange', () => {
          // No controller means this is the first install: nothing to update from.
          if (incoming.state === 'installed' && navigator.serviceWorker.controller) offer(incoming);
        });
      });
      let lastCheck = Date.now();
      document.addEventListener('visibilitychange', () => {
        if (document.hidden || Date.now() - lastCheck < UPDATE_CHECK_MS) return;
        lastCheck = Date.now();
        void reg.update().catch(() => undefined); // offline: try again next time
      });
    })
    .catch((err) => console.error('[web] service worker registration failed', err));
}

function whenIdle(writesInFlight: () => number, then: () => void): void {
  if (writesInFlight() === 0) then();
  else setTimeout(() => whenIdle(writesInFlight, then), 250);
}

/** Plain DOM rather than React: it belongs to the page, not to the renderer it would replace. */
function showUpdateBanner(say: Say, onRestart: () => void): void {
  if (document.querySelector('.update-banner')) return;
  const bar = document.createElement('div');
  bar.className = 'update-banner';
  bar.setAttribute('role', 'status');

  const text = document.createElement('span');
  text.textContent = say('web.update.ready');

  const restart = document.createElement('button');
  restart.className = 'btn primary';
  restart.textContent = say('web.update.restart');
  restart.addEventListener('click', () => {
    restart.disabled = true;
    onRestart();
  });

  const later = document.createElement('button');
  later.className = 'btn';
  later.textContent = say('web.update.later');
  later.addEventListener('click', () => bar.remove());

  bar.append(text, restart, later);
  document.body.append(bar);
}
