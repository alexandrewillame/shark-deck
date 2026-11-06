---
name: add-device-model
description: Checklist for adding support for a new Attack Shark mouse or keyboard model to SharkDeck - where each platform's models are declared, how a device is identified, device photos, and what comes free. Use whenever adding a new device, model, PID, model id, Hub mid, or colour variant.
---

# Adding a device model

A device is **identified, not matched**: VID/PID only names a protocol family
(`app/src/main/devices/registry.ts`), the device attaches `pending`, answers
its family's identify command, and `app/src/main/devices/identity.ts` turns
that answer into a descriptor. So "adding a model" means adding it to the
table its platform identifies by — never a new VID/PID entry.

## Where a model goes, by platform

| Platform | Identified by | Declare it in |
|---|---|---|
| ROYUAN keyboards (gen2, yc500) — VID 3151 / 39AB | firmware model id (`0x8F`) | **nowhere by hand**: `npm run import:kb` imports the vendor registry (via sharkfin) into `catalog/generated/`, and `catalog/keyboard-builder.ts` builds every descriptor by rule. Fix a row in `catalog/keyboard-resolutions.ts`; a name in the importer's `NAME_OVERRIDES`; photos in `KEYBOARD_ART`; travel limits in `TRAVEL_OVERRIDES`. |
| A keyboard checked on hardware | the same | a hand-written descriptor overlaying its row (`catalog/keyboards.ts` `OVERLAYS`, like `r85he.ts`). Its slug must stay the row's (`slugs.lock.json` is append-only: per-model stores are keyed by it). |
| Compx Hub mice — VID 3554 | identify `0x01`: cid 124 + mid + link | `catalog/hub-mice.ts`: `NAMED` for a mid you can name, `HUB_MID_CLASS` for its sensor class, `HUB_CANDIDATES` for the photos the class offers. |
| GearHub-V5 mice — VID 3151 | device id (`0x8F`) | `catalog/gearhub-mice.ts` `GEARHUB_MICE`. |
| JXC mice — VID 373E | the PID (no model read) | `catalog/jxc-mice.ts` `MODELS`; another brand's PID in `OTHER_BRANDS`. |
| Beken mice — VID 1D57 | the PID | `catalog/beken-mice.ts` — shown, never driven (see `docs/protocol/mouse-beken.md`). |

A model on a command set no driver speaks gets `identity: 'unsupported'`: a
named card, nothing read or written. Another brand's id belongs in the
platform's foreign table, which gives the "Not an Attack Shark device" card.

**Pick capabilities from what the firmware has, never from the name.** One
marketing name can cover several ids with different hardware. Set
`provenance` honestly (`verified-capture` / `ported-from-vendor` /
`inferred`); only the R85HE and the V8 have been checked on hardware.

## Menus come from the gate table

`app/src/shared/menuGates.ts` decides every tab, section and control from the
descriptor's capabilities and `DeviceUi`. A new model needs nothing there —
unless it has a control no gate covers (then see `add-capability-tab`).
Keyboards without a key map with every slot (`keyMatrix.layoutStatus`
`none`) get whole-board settings only; that is by design.

## Photos

1. `app/assets/devices/manifest.json`: the model's art key, each colour's
   store name and source URL (official store photos only).
2. `cd app && python -E -P scripts/build-device-art.py --only <art-key>`
   (Python 3 + Pillow; `-E -P`, not `-I`, or the user-site Pillow is hidden)
   cuts the background out and writes `<art-key>-<colour>.webp` (≤ 50 KB).
   Per-variant `holes` (backdrop seen through a slot or open shell),
   `tolerance` and `crop` in the manifest fix a bad cut-out — see
   `app/assets/devices/README.md`.
3. **Show the result to the user before it ships** (the gallery the
   script's `--gallery` builds) — photos are signed off first. Judge the
   edges on the app's dark surface, zoomed in: a light rim there is the
   white backdrop left in, which the user rejects.
4. Nothing to wire: the manifest is read by `src/shared/device-art.ts`
   (colours, labels, swatches — add a swatch for a new colour name under
   `swatches`) and the folder is bundled whole by `deviceArtAssets.ts`. Point
   the model at its photo set with `artKey` when its slug differs.
   `deviceArt.test.ts` and `src/web/precacheBudget.test.ts` check the rest.

## After any catalogue change

```bash
cd app && npm run lineup && npm run --silent check
```

`npm run lineup` regenerates the tables of `docs/devices/attack-shark-lineup.md`;
`lineup.test.ts` fails when they are stale.

## Free by construction - do not go looking for these

- **A simulated device.** `virtualDescriptors()` (`devices/virtual.ts`) puts
  every catalogue model, one keyboard per distinct menu shape, every Hub, GearHub
  and JXC model, and a read-only card in developer mode.
- **The backup policy.** It belongs to the driver (`backupPolicy()`), and
  `test/contract/backup-policy.test.ts` checks it for every model a driver
  drives.
- **The udev rule.** Only a new **VID** needs a line, in
  `app/assets/linux/60-sharkdeck.rules` and `scripts/linux/install-udev-rules.sh`;
  `udev-rules.test.ts` checks both against `knownVendorIds()`.

## Verify

```bash
cd app && npm run --silent check
```

With the real device connected, `node scripts/smoke-hid.mjs` (read-only,
~8-10 lines per device; `--probe <vid>:<pid>` for one it does not know).
**Never pass `--watch`** — it never exits.

No hardware? `npm run dev:web` (background it) or `npm run dev`, then
Settings -> Developer -> **Simulated devices**.
