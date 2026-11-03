# App background

The Appearance popover's **Background** group. You pick an effect, and it is
drawn behind every screen in the colours of the current palette. The panels in
front of it turn to frosted glass.

Code lives in `app/src/renderer/background/`. Surfaces are in
`app/src/renderer/styles/background.css`. Settings are in
`app/src/shared/backgrounds.ts` and `AppSettings`.

## The effects

There are nine, plus None:

- Smoke, Fire, Electricity, Lava, Aurora, Nebula, Water and Rain emit light
  over the page colour.
- Landscape is a picture.

They are backgrounds, not light shows: muted, unhurried, and mostly dark.
Electricity is a thunderstorm at night: a ceiling of storm cloud drifting
slowly, its lumps lit faintly from below, rain, and about every three or four
seconds, unevenly, a burst of one to three bolts that lights the clouds around
it; Fire rises slowly, in clusters of tongues with dark gaps between them
(the first version was one flat sheet of colour along the whole bottom of the
window, which read as "saturated"); Water is the web of caustics that sunlight throws
through waves, seen underwater; Rain is a window at night, out-of-focus city
lights behind glass covered in beads of rain that each show the lights upside
down, with a drop running down the pane now and then.

Five were retired. Artistic's marbling became Paint and Paint became Military;
Military (woodland camouflage) and Petrol (an oil film) then gave way to Rain;
and Primal (cave-art motifs, a still picture) left the set. A settings file
that names one is moved on by `toBackgroundEffect()` in `shared/backgrounds.ts`:
Primal to None, the other four to Rain.

Every effect is one GLSL ES 1.00 fragment shader, drawn on a single full-window
triangle (`shaders/effects.ts`, after `shaders/common.ts`). There are no
images: nothing is fetched, nothing is shipped as a texture, and recolouring
an effect only means changing two uniforms.

Anything with an edge in it is drawn sharp at whatever size the buffer is.
Widths are set in pixels (`1 / uRes.y`) or from the field's own rate of change
(`slope()`, from `OES_standard_derivatives`) rather than as fixed fractions of
the window, which blurred at one size and aliased at another.

## Colours

- **Palette on.** An effect is drawn in `--accent-rgb` and `--violet-rgb` (the
  secondary accent) over `--bg`. All three are read from the stylesheet with
  `getComputedStyle`, so tokens.css stays the only place palette colours live.
- **Palette off.** An effect uses its own natural pair (registry.ts), one for
  dark pages and one for light ones: orange fire, green-violet aurora, and so
  on. A few effects need to know which (`uPal`): Rain's city has red tail
  lights and warm white of its own, which a palette's two colours replace,
  and the white-hot cores of Fire and Lava are warmer in their own colours.
- **Light pages.** Emitters cannot add light to a light page. `glow()` lays
  them down as ink instead: the same hue, as strong as the light was bright.
- **Palette or mode changes.** A `MutationObserver` on `<html>` picks these up,
  and the canvas cross-fades over 400 ms, the same length as `.theme-anim`.

## Layering

- `BackgroundLayer` is the first child of `.app`. It is a fixed, full-window
  host at `z-index: -1`, and it ignores pointer events.
- `.app` is `isolation: isolate`. The canvas therefore paints above `.app`'s
  own gradient and below everything in it. That gradient is also the fallback
  when WebGL is unavailable.
- The layer must never move inside `.view` or `.tabpane-in`. Both animate a
  transform, and a transformed ancestor would make the fixed layer fixed to
  them instead of to the window.
- `data-bg` is on `<html>` only while an effect is on (`applyTheme`). Every
  frosted rule hangs off it, so with None nothing changes.

## Frosted surfaces

- **Top-level containers** (panels, device cards, macro library/editor, the
  tab rail, the sticky sub-tab bars) get the pane colour at `--glass-a` over a
  `backdrop-filter` blur.
- **Nested surfaces** get translucency only. Blur is redone on every frame the
  background draws, and a nested blur would re-blur glass for nothing.
- **Opaque on purpose:** keyboard boards, inputs, menus, popovers, tooltips,
  dialogs and toasts.
- **Tab switches.** With a background on, the entrance animation is a slide
  without the fade. An ancestor below full opacity cuts off what
  `backdrop-filter` can see, so panels would show flat until the fade ended.
- **Reduced transparency.** `prefers-reduced-transparency` makes the panels
  solid again and keeps the background.

## Cost

A frame is drawn only when something changed, or while the effect moves, at
the effect's own rate (12-30 fps). The drawing buffer is a fraction of the
window's device pixels (`scale`, 0.75-1: drawn at half size, as they first
were, every line came out blurred), capped at about 4.1 million pixels
(`MAX_PIXELS`) so a very large window draws slightly softer rather than
slower. It holds one still frame and stops when any of these is true:

- Animate is off;
- the GPU is a software rasteriser (SwiftShader, llvmpipe);
- the window is hidden.

Animate is unset until the switch is first flipped, and until then it follows
the system: off where the system asks for reduced motion (on Windows,
Accessibility > Visual effects > Animation effects). Once set, the switch
wins. Reduced motion used to stop the background whatever the switch said,
and the switch still read on (`background/motion.ts`).

A window made with `show: false` counts as visible to its page until it is
shown or hidden, so a start to the tray (login) hides it explicitly; left
unshown, it animated the background for nobody.

Shaders compile in parallel through `KHR_parallel_shader_compile` where
available. Compiled the blocking way they take 0.2-0.6 s each. On the
development machine, frames took 1-3.5 ms at 960x540 and 5-9 ms at 1920x1080,
both measured with a read-back after every frame, so an upper bound.

Both extensions are asked for again after a lost context comes back: a
restored context starts with none, and without them every program would read
as still compiling. A frame that runs into a lost context before its event
arrives fails; the layer clears that when the context returns rather than
staying off.

The picker's thumbnails are drawn by one shared renderer, never one context
per tile. Chromium allows 16 live contexts. All nine shaders take about 2.5 s
to build on the development machine (Electricity alone about 2 s, Lava
1.2 s, on Direct3D 11), and Chromium's shader cache does not keep them
between launches. So the tiles are drawn ahead of time, 4 s after launch
once the window is showing, and each tile appears as soon as its own shader
is ready rather than in the picker's order. A lost thumbnail context is
replaced, not waited on.

The intensity slider updates the layer live through `background/live.ts` and
saves to settings once it settles. Saving on every tick would re-render every
screen that reads settings.
