/**
 * Production CSP hardening, extracted from electron.vite.config.ts so a test
 * can run it against the real HTML.
 *
 * The dev CSP in index.html has to allow `ws://localhost` / `http://localhost`
 * for Vite HMR. That must not ship: a packaged renderer has no reason to reach
 * any localhost service, because the app makes no network calls at all. This
 * also adds the `form-action` directive, which `default-src` does not cover.
 *
 * Why it lives here rather than inline in the vite config: the plugin is
 * `apply: 'build'`, so a dev run never executes it, and nothing else proved
 * the regex still matched. If a directive is renamed or reordered such that
 * `connect-src` no longer matches, the replace silently becomes a no-op and a
 * localhost-permitting CSP ships. test/contract/no-network-csp.test.ts asserts
 * the substitution actually fires.
 */
export function hardenCsp(html: string): string {
  return html.replace(/connect-src[^;"]*/, "connect-src 'self'; form-action 'none'");
}

/**
 * The same for the browser edition's page (src/web/index.html, built by
 * vite.web.config.ts), one step stricter: `connect-src 'none'`. The published
 * page loads its modules, styles and images under their own directives and
 * its service worker under `worker-src`, so nothing it does is a connection —
 * and GitHub Pages is a public origin, unlike the desktop's local files.
 */
export function hardenWebCsp(html: string): string {
  // Scoped to the CSP meta tag's own `content` attribute: matching the bare
  // directive name anywhere in the page rewrote an HTML comment that
  // mentioned it and left the real policy untouched.
  return html.replace(
    /(http-equiv="Content-Security-Policy"\s+content=")([^"]*)(")/,
    (_m, open: string, csp: string, close: string) =>
      open + csp.replace(/connect-src[^;]*/, "connect-src 'none'; form-action 'none'") + close,
  );
}
