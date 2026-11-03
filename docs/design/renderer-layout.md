# Renderer layout decisions

Settled decisions about how the device-config screen is laid out, moved out of
the source comments so they are not in the read path of anyone editing the
components. The operative rules stay next to the code; the reasoning is here.

## The travelling device photo

The device's photo (or generated silhouette) is a single DOM node —
`<PersistentDeviceArt>`, rendered once in `App.tsx` and never unmounted.

Each tab marks where it wants that art with `<ArtAnchor>`, which publishes the
target box into `store.artFlight`. Moving between tabs only updates that target
rect, and a CSS transition slides and scales the art there, because it is the
same node throughout rather than a fresh image per tab.

`mode="keyboard"` is for the panes that own an actual interactive keyboard —
Keys, Actuation, and per-key Lighting. There the anchor fades the photo out in
place rather than showing it, and fades it back in on the way out, still
sliding to wherever the next tab wants it.

## Hero photo beside the content, not above it

`HeroPane` puts the photo in a fixed left column with tab content beside it.
Profile, Buttons, Macros, Device and the mouse-only Lighting sub-panes use it.

Keyboards originally kept their photo *above* the content, with no `hero-side`
class at all. That left a wide band of empty space next to a photo with nothing
beside it, so keyboards now get the same side-by-side treatment as mice. The
`is-keyboard` class exists only to size the art column for a keyboard's much
wider photo (`--hero-art-h`) instead of a mouse's taller one.

Keys, Actuation and Lighting's per-key/global panes deliberately do **not** go
through `HeroPane`. There the interactive board itself is the functional
editing surface rather than decoration, so it stays on top. See `KeysTab.tsx`,
`ActuationTab.tsx`, `LightingTab.tsx`.

## Why the tab rail is sticky with its own scroll region

The rail collapses to icons-only (`settings.railCollapsed`), which is why every
button carries a tooltip — once collapsed, that tooltip is the only label left.

The rail is `position: sticky` and splits its button list from its collapse
footer, each with its own scroll region. Without that split, a device with
enough capability tabs to make the rail taller than the viewport pushed the
collapse footer off-screen: the whole rail was being stretched to the
(possibly tall, scrolled) height of the CSS grid it is paired with. Pinning the
rail itself and giving the nav its own overflow is what fixes it.

See `.tabrail`, `.tabrail-nav` and `.tabrail-foot` in
`app/src/renderer/styles/config-shell.css`.

## Disabling a tab when the device drops offline

A banner appears and every control in the active tab is disabled by a wrapping
`<fieldset>`. Native `disabled` cascades to every input, button and select
inside it, so no per-control plumbing is needed.

The banner itself sits **outside** the fieldset so it stays interactive. There
is nothing to click on it today, but it must never itself go inert.
