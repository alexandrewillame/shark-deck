# The ROYUAN 2.4 GHz receiver relay

A ROYUAN receiver (VID 0x3151) does not answer its device's commands itself:
it **carries** them. Implemented in `app/src/main/hid/transport.ts`
(`relaySendUnlocked` / `relayReceiveUnlocked`), switched on per endpoint by
`DeviceDescriptor.relay`, which `registry.ts` sets from the receiver's PID:

| Receiver | Behind it | Source |
|---|---|---|
| 3151:4011 | a keyboard (target `0x0A`) | sharkfin, on an X86; OpenRGB #4074 for the K86 |
| 3151:402D | a GearHub mouse (target `0x05`) | OpenMouse, on an R2 |

**Never on our hardware.** `ported-from-vendor`; `inferred` in practice.

## The sequence

1. Poll status `0xF7` until byte 5 = 1 (the receiver takes a packet).
2. Select the target: `[0xF6, 0x0A]` keyboard, `[0xF6, 0x05]` mouse. Skipping
   it drops the packet.
3. Send the device's packet unchanged — same opcode, same checksum. Both
   keyboard command sets (gen2, yc500) pass straight through.
4. Poll `0xF7` until byte 0 = 1 (a reply is waiting).
5. Release it with `0xFC`, then read the feature report as usual; the reply
   echoes the device's opcode.

Timing: about 100 ms to a reply; the vendor app polls up to 5 × 100 ms;
Shark Deck allows 500 ms to send and 1 s to read, like sharkfin. The
receiver frames carry the `compx-fea` checksum (sending them without one is
also reported to work).

## Status reply (`0xF7`)

| Byte | Meaning |
|---|---|
| 0 | 1 = a reply is waiting |
| 1 | keyboard battery % |
| 2 | mouse battery % |
| 3 / 4 | keyboard / mouse link, 0 = online |
| 5 | 1 = ready for a packet |
| 6 | what is paired: 1 keyboard, 2 mouse, 3 both |

This is the only battery a ROYUAN keyboard has: on its cable it reports none.

## Over the receiver, refused

A factory reset and the live key-travel stream need the cable: the receiver
drops a bare-opcode packet if the device has dozed, and the stream is pushed
input reports it does not carry. Shark Deck drops `restore` from a relayed
device's capabilities and refuses the travel stream.

## Known gaps

Not every receiver relays — some carry nothing, and the same model ships with
both kinds; a board behind one stays "Identifying…". A receiver not in the
table above is treated as a device of its own.

## Sources

- sharkfin — <https://github.com/dniminenn/sharkfin> (GPL-3.0-or-later),
  `docs/PROTOCOL.md` "2.4 GHz receiver"; facts only.
- OpenMouse mouse-protocol (AGPL-3.0, facts only) `src/drivers/gearhub/hid.ts`;
  innox2-mac (MIT).
