import type { ReactNode } from 'react';
import { InfoDot } from './common';

/**
 * Label + a tooltip info dot. Shared by
 * `MagneticSection`'s Mode/Rapid Trigger rows, `SwitchTravelStage`'s
 * per-slider column headers, `LightingTab`'s per-key controls, and the mouse
 * Sensor / Poll rate / Debounce sections. Originally pulled out of
 * MagneticSection.tsx so the travel stage could use it without the two files
 * importing each other; sections.tsx had grown a byte-identical copy called
 * LabelInfo, which this replaces.
 *
 * The Actuation tab's controls (MagneticSection, SwitchTravelStage) pass
 * inline English — that corner of the app has no useT; everything else passes
 * `t(...)`. `media` is
 * optional — an illustration earns its place for the jargon-heavy actuation
 * settings, but most controls just need a sentence.
 */
export function InfoLabel({
  label,
  text,
  media,
  stack,
}: {
  label: string;
  text: string;
  media?: ReactNode;
  /**
   * Icon above the label instead of beside it, for a column header that has to
   * stay centred on the control below it.
   *
   * A prop rather than a stylesheet override: the layout here is an INLINE
   * style, so a caller trying to restack it from CSS could change the
   * direction but not the 6px gap — which left the icon floating well clear of
   * the title it belongs to. Set here, both are right by construction.
   */
  stack?: boolean;
}) {
  return (
    <span
      style={
        stack
          ? { display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 1 }
          : { display: 'inline-flex', alignItems: 'center', gap: 6 }
      }
    >
      {stack && <InfoDot text={text} media={media} size={12} />}
      {label}
      {!stack && <InfoDot text={text} media={media} size={12} />}
    </span>
  );
}
