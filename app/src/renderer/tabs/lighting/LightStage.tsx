import type { ReactNode, RefObject } from 'react';
import { ArtAnchor } from '../../components/ArtAnchor';

/**
 * The board, and the column of tools to its right — one wrapper for BOTH
 * lighting panes, so the keyboard sits in exactly the same box on Global and
 * on Per-Key and never moves when you switch between them.
 *
 * A two-track grid: the board's track and a fixed-width tool track. A fixed
 * track keeps its width even when empty, so Global (which has no tools) gets
 * the same board box without a placeholder, and `KeyboardMap`'s `fit` computes
 * the same key size in both. The row is as tall as the taller of the two, so
 * at small sizes a tall tool column pushes the panels below it down — never
 * the board itself. Below a narrow width (see per-key-lighting.css) both panes
 * stack the tools under the board alike.
 *
 * The tools used to sit in a column at the board's LEFT, which took width out
 * of the board's own box on Per-Key only; then under it. Both made the
 * keyboard jump on a sub-tab switch.
 */
export function LightStage({
  boardRef,
  tools,
  reserveTools = true,
  children,
}: {
  boardRef: RefObject<HTMLDivElement | null>;
  /** The tool column, or nothing (its track is reserved anyway). */
  tools?: ReactNode;
  /** False on a board with no per-key editor at all, where nothing switches
   *  between panes and the reserve would only cost width. */
  reserveTools?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="light-stage-box">
      <div className={reserveTools ? 'light-stage' : 'light-stage no-tools'}>
        <ArtAnchor mode="keyboard" className="art-keyboard-anchor" measureRef={boardRef}>
          {children}
        </ArtAnchor>
        {tools}
      </div>
    </div>
  );
}
