import { Driver } from './base';
import { KB_CMD } from './compx-keyboard';
import { V8_CMD } from '@shared/mouse-wire';
import type { IdentityKey } from '../identity-key';

/**
 * Drivers for a device that has not said what it is yet, or that Shark Deck
 * leaves alone.
 *
 * Until a device identifies, nothing but its family's identify command is
 * sent: the ROYUAN command sets disagree on what most opcodes do (0x09 is a
 * keymap flash upload on yc500 and an options read on gen2), and another
 * brand's mouse on the V8's PIDs must not receive V8 writes. Every other
 * method keeps the base class's null / not-supported answers.
 *
 * provenance: verified-capture for both identify frames (see identity-key.ts).
 */

/** Keyboards (and GearHub mice) on the ROYUAN chips: identify 0x8F only. */
export class RoyuanIdentify extends Driver {
  override async identify(): Promise<IdentityKey | null> {
    const usb = await this.ch.request(
      this.frame(KB_CMD.GET_USB_VERSION),
      KB_CMD.GET_USB_VERSION,
      2,
      6,
      true,
    );
    if (!usb) return null;
    const modelId = ((usb[3] ?? 0) << 8) | (usb[2] ?? 0);
    return modelId && modelId !== 0xffff ? { family: 'royuan', modelId } : null;
  }
}

/** The V8's protocol family: identify 0x01 only. */
export class HubIdentify extends Driver {
  override async identify(): Promise<IdentityKey | null> {
    const nonce = [0, 1, 2, 3].map(() => Math.floor(Math.random() * 256));
    const reply = await this.ch.request(
      this.frame(V8_CMD.IDENTIFY, [0x00, 0x00, 0x00, 0x08, ...nonce]),
      V8_CMD.IDENTIFY,
      3,
      6,
    );
    if (!reply || reply.length < 13 || (reply[2] ?? 1) !== 0x00) return null;
    return { family: 'compx-hub', cid: reply[10]!, mid: reply[11]!, link: reply[12]! };
  }
}

/** A read-only card (another brand, an unknown id, an unsupported command set): no I/O at all. */
export class NoIo extends Driver {}
