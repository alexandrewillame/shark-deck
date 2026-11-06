/**
 * What a device's firmware says it is, per protocol family — the answer to
 * each driver's `identify()`. Tagged by family so a keyboard's model id and a
 * mouse's model number can never be confused for one another.
 *
 * - `royuan`: the ROYUAN / Compx keyboard chips (and their GearHub mice),
 *   identify 0x8F (`GET_USB_VERSION`): the vendor model id at reply bytes
 *   [2..3] — `verified-capture` on the R85HE (3123).
 * - `compx-hub`: the V8's protocol, identify 0x01: `cid` (124 = Attack Shark),
 *   `mid` (the model) and the link type at reply bytes 10 / 11 / 12 —
 *   `verified-capture` for the frame from our V8 capture (`… 7c 05 05`).
 */
export type IdentityKey =
  | { family: 'royuan'; modelId: number }
  | { family: 'compx-hub'; cid: number; mid: number; link: number };
