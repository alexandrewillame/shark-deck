import { proximity } from '@shared/proximityFade';

/**
 * The auto-switch card's page script (overlay.html). Displays what
 * main/overlayWindow.ts sends and fades the card near the pointer; it never
 * talks back.
 */

interface OverlayContent {
  id: number;
  kind: 'game' | 'desktop';
  ms: number;
  logo: string;
  brand: string;
  mode: string;
  exe: string;
  exeIcon: string | null;
}

interface OverlayApi {
  onContent?: (cb: (c: OverlayContent) => void) => () => void;
  onPointer?: (cb: (at: { x: number; y: number }) => void) => () => void;
  onFade?: (cb: (ms: number) => void) => () => void;
}

const api: OverlayApi = (window as unknown as { overlay?: OverlayApi }).overlay ?? {};

const byId = <T extends Element = HTMLElement>(id: string) =>
  document.getElementById(id) as unknown as T;
const card = byId('card');
const logo = byId<HTMLImageElement>('logo');
const brand = byId('brand');
const gameIcon = byId<HTMLImageElement>('game-icon');
const gameLetter = byId('game-letter');
const desktop = byId<SVGElement>('desktop');
const mode = byId('mode');
const exe = byId('exe');
const bar = byId('bar');

/** Images arrive inline: this page's CSP allows `data:` images and nothing
 *  else, so a file:// path would be blocked anyway. */
const isImage = (v: unknown): v is string => typeof v === 'string' && v.startsWith('data:image/');

/** Show `src` in `img`, or hide `img` when there is no image to show. */
function setImage(img: HTMLImageElement, src: unknown): void {
  if (isImage(src)) img.src = src;
  else img.removeAttribute('src');
  img.hidden = !isImage(src);
}

/** Which switch the card shows: a second message for it (a late icon) only
 *  fills it in, without sliding it in or restarting its countdown again. */
let current: number | null = null;

api.onContent?.((c) => {
  setImage(logo, c.logo);
  brand.textContent = c.brand ?? '';
  // The subject: the game's icon, else its initial; the desktop on the way back.
  const game = c.kind !== 'desktop';
  setImage(gameIcon, game ? c.exeIcon : null);
  const initial = (c.exe ?? '').trim().charAt(0).toUpperCase();
  gameLetter.textContent = initial;
  gameLetter.hidden = !game || isImage(c.exeIcon) || !initial;
  desktop.toggleAttribute('hidden', game);
  mode.textContent = c.mode ?? '';
  exe.textContent = c.exe ?? '';
  exe.hidden = !c.exe;
  if (c.id !== current) {
    current = c.id;
    // Whole again after the last card's fade (Linux; see onFade below).
    document.body.style.transition = 'none';
    document.body.style.opacity = '1';
    card.style.setProperty('--ms', `${c.ms ?? 10000}ms`);
    // Restart both animations: a fresh element for the bar, a re-added class
    // (after a forced layout) for the slide-in.
    const fill = bar.firstElementChild;
    if (fill) fill.replaceWith(fill.cloneNode());
    card.classList.remove('enter');
    void card.offsetWidth;
    card.classList.add('enter');
    // A new card starts whole; the next pointer sample fades it if it must.
    card.style.setProperty('--prox', '1');
  }
});

api.onPointer?.(({ x, y }) => {
  card.style.setProperty('--prox', String(proximity(x, y, card.getBoundingClientRect())));
});

// Linux: the window cannot fade, so the page does, before main hides it.
api.onFade?.((ms) => {
  document.body.style.transition = `opacity ${ms}ms linear`;
  document.body.style.opacity = '0';
});
