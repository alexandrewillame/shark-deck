import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { MacroStep } from '@shared/types/macros';
import { hidUsageForBrowserCode } from '@shared/keys';
import { isModifierUsage } from '@shared/keyboard-fn-codes';
import { setKeyCaptureActive } from '../../state/shortcuts';
import { DOM_BUTTON_VALUE, toGroups, type MacroGroup } from './macroUtils';

/** How the pauses between captured events are stored. */
export type RecTiming = 'real' | 'fixed' | 'none';
/** What a kept take does to the steps already in the editor. */
export type RecMode = 'replace' | 'append';
export type RecPhase = 'idle' | 'armed' | 'recording' | 'review';

export interface RecorderTake {
  groups: MacroGroup[];
  /** key presses with no HID usage on this device — reported, not hidden */
  skipped: number;
}

interface RawEvent {
  t: number;
  type: 'key' | 'mouse';
  action: 'down' | 'up';
  value: number | string;
}

/** Gaps under this are keyboard jitter rather than intent, and become no step. */
const MIN_GAP_MS = 10;

/** macOS, where the keyboard events a recording relies on differ — see the
 *  ⌘ and Caps Lock handling in the recorder. */
const IS_MAC = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);

/**
 * Record a release, at `t`, for every key recorded as down and not yet up — so
 * a take never replays with a key held down for good. `held` is emptied.
 */
function releaseHeld(events: RawEvent[], held: Set<string>, t: number): void {
  for (const value of held) events.push({ t, type: 'key', action: 'up', value });
  held.clear();
}

/**
 * Turn captured events into a step list under the chosen timing mode. Pure, and
 * shared by the live preview and the finished take so what you watch being
 * recorded is exactly what you get when you stop.
 */
function buildSteps(raw: RawEvent[], timing: RecTiming, fixedMs: number): MacroStep[] {
  const steps: MacroStep[] = [];
  for (let i = 0; i < raw.length; i++) {
    const e = raw[i]!;
    let gap = 0;
    if (i > 0) {
      if (timing === 'fixed') gap = Math.max(0, Math.round(fixedMs));
      else if (timing === 'real') {
        const measured = Math.round(e.t - raw[i - 1]!.t);
        gap = measured >= MIN_GAP_MS ? measured : 0;
      }
    }
    if (gap > 0) steps.push({ type: 'delay', ms: gap });
    steps.push({ type: e.type, action: e.action, value: e.value });
  }
  return steps;
}

/**
 * Live capture of real key and mouse-button input for the macro editor.
 *
 * Scope: this is DOM capture on the renderer window, so it only sees input
 * delivered to SharkDeck itself. The app has no OS-wide input hook and
 * deliberately does not add one — that would need a native module and, on
 * macOS, exactly the Input Monitoring consent this project otherwise avoids
 * (docs/platform-support.md). The recorder card states the limit instead of
 * letting it surprise anyone.
 *
 * Three defects in the earlier inline version are fixed here:
 *  - the clock started when Record was clicked, so the seconds spent moving
 *    your hands to the keyboard were baked in as a leading delay step. Capture
 *    now arms first and starts the clock on the first real event.
 *  - the mousedown on the Record/Stop button itself was recorded as a step.
 *    Events originating inside `uiRef` are ignored.
 *  - only a *count* of captured events reached React, so a recording was a
 *    number ticking upward with no way to tell what had actually landed until
 *    it was over. `liveGroups` streams the real rows as they are captured.
 *
 * Pointer movement is not captured at all: neither device can store it (both
 * codecs drop `move`), so recording it only ever produced steps that silently
 * vanished on push.
 */
export function useMacroRecorder(options: {
  timing: RecTiming;
  fixedMs: number;
  /** the recorder's own controls — clicks in here are chrome, not input */
  uiRef: RefObject<HTMLElement | null>;
}) {
  const { timing, fixedMs, uiRef } = options;

  const [phase, setPhase] = useState<RecPhase>('idle');
  const [take, setTake] = useState<RecorderTake | null>(null);
  const [live, setLive] = useState<RawEvent[]>([]);
  const [elapsedMs, setElapsedMs] = useState(0);

  const events = useRef<RawEvent[]>([]);
  /** Keys recorded as down and not yet up, so none is left held on replay —
   *  see `releaseHeld`. */
  const held = useRef(new Set<string>());
  const skipped = useRef(0);
  const startedAt = useRef(0);
  // Listeners are attached once per capture session, so they must not close
  // over a stale timing mode.
  const timingRef = useRef(timing);
  timingRef.current = timing;
  const fixedRef = useRef(fixedMs);
  fixedRef.current = fixedMs;
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  const finish = useCallback(() => {
    // A key still down when the recording stops is let go at its last event,
    // not left pressed for the replay to hold forever.
    releaseHeld(events.current, held.current, events.current.at(-1)?.t ?? 0);
    // Group here too, so a take pairs its taps exactly like a loaded macro.
    const steps = buildSteps(events.current, timingRef.current, fixedRef.current);
    setTake({ groups: toGroups(steps), skipped: skipped.current });
    setPhase('review');
  }, []);

  const start = useCallback(() => {
    events.current = [];
    held.current.clear();
    skipped.current = 0;
    startedAt.current = 0;
    setLive([]);
    setElapsedMs(0);
    setTake(null);
    setPhase('armed');
  }, []);

  const stop = useCallback(() => {
    // Armed but nothing ever pressed: go straight back to idle rather than
    // offering an empty take to keep or discard.
    if (phaseRef.current === 'armed') {
      setPhase('idle');
      return;
    }
    finish();
  }, [finish]);

  const reset = useCallback(() => {
    setTake(null);
    setPhase('idle');
  }, []);

  const capturing = phase === 'armed' || phase === 'recording';

  // What has been captured so far, in the same rows the step list uses. Rebuilt
  // from scratch on each event rather than appended to: the timing mode folds a
  // gap into the row that follows it and a down only becomes a tap once its up
  // lands, so the tail of the list genuinely changes shape as events arrive.
  const liveGroups = useMemo(
    () => toGroups(buildSteps(live, timing, fixedMs)),
    [live, timing, fixedMs],
  );

  useEffect(() => {
    if (!capturing) return;
    // The global tab shortcuts listen on window too — without this, Ctrl+W
    // while recording would both record a step and close the tab out from
    // under the recording (state/shortcuts.ts).
    setKeyCaptureActive(true);

    const push = (type: 'key' | 'mouse', action: 'down' | 'up', value: number | string) => {
      const now = performance.now();
      if (!events.current.length) {
        startedAt.current = now;
        setPhase('recording');
      }
      if (type === 'key') {
        if (action === 'down') held.current.add(String(value));
        else if (!held.current.delete(String(value))) return; // already let go
      }
      events.current.push({ t: now, type, action, value });
      setLive([...events.current]);
    };

    // Focus leaving mid-recording — Alt+Tab, ⌘Tab — sends the modifier's
    // release to the other window, so it was recorded down and never up:
    // replayed, the macro ended holding Alt. Whatever is down is let go here.
    const onBlur = () => {
      if (!held.current.size) return;
      releaseHeld(events.current, held.current, performance.now());
      setLive([...events.current]);
    };

    const fromUi = (e: Event) =>
      !!uiRef.current && e.target instanceof Node && uiRef.current.contains(e.target);

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      // Esc is the stop control, so it is swallowed rather than recorded. A
      // macro that genuinely needs Esc can add it from the key picker.
      if (e.code === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        stop();
        return;
      }
      const usage = hidUsageForBrowserCode(e.code);
      e.preventDefault();
      if (!usage) {
        skipped.current++;
        return;
      }
      push('key', 'down', usage);
      // macOS sends Caps Lock as one event per press — keydown as it turns
      // on, keyup as it turns off — so each is a whole tap.
      if (IS_MAC && e.code === 'CapsLock') push('key', 'up', usage);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Escape') return;
      const usage = hidUsageForBrowserCode(e.code);
      e.preventDefault();
      if (!usage) return; // its press half was already counted as skipped
      if (IS_MAC && e.code === 'CapsLock') {
        push('key', 'down', usage);
        push('key', 'up', usage);
        return;
      }
      // macOS delivers no keyup for a key released while ⌘ is held: ⌘C
      // recorded as ⌘↓ C↓ ⌘↑ and replayed with C stuck down. When ⌘ comes up,
      // what was pressed under it is let go first.
      if (IS_MAC && (e.code === 'MetaLeft' || e.code === 'MetaRight')) {
        for (const other of [...held.current]) {
          if (other !== usage && !isModifierUsage(parseInt(other, 16))) push('key', 'up', other);
        }
      }
      push('key', 'up', usage);
    };
    const onMouseDown = (e: MouseEvent) => {
      if (fromUi(e)) return;
      const value = DOM_BUTTON_VALUE[e.button];
      if (!value) return;
      push('mouse', 'down', value);
    };
    const onMouseUp = (e: MouseEvent) => {
      if (fromUi(e)) return;
      const value = DOM_BUTTON_VALUE[e.button];
      if (!value) return;
      push('mouse', 'up', value);
    };
    // A right-click being recorded should not also open a context menu.
    const onContextMenu = (e: MouseEvent) => {
      if (!fromUi(e)) e.preventDefault();
    };

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('mousedown', onMouseDown, true);
    window.addEventListener('mouseup', onMouseUp, true);
    window.addEventListener('contextmenu', onContextMenu, true);
    window.addEventListener('blur', onBlur);
    return () => {
      setKeyCaptureActive(false);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('mousedown', onMouseDown, true);
      window.removeEventListener('mouseup', onMouseUp, true);
      window.removeEventListener('contextmenu', onContextMenu, true);
      window.removeEventListener('blur', onBlur);
    };
  }, [capturing, stop, uiRef]);

  // Elapsed-time readout. Only ticks once the first event has landed, so an
  // armed-but-untouched recorder reads 0.0 s instead of counting up before
  // capture has actually begun.
  useEffect(() => {
    if (phase !== 'recording') return;
    const id = setInterval(() => setElapsedMs(performance.now() - startedAt.current), 100);
    return () => clearInterval(id);
  }, [phase]);

  return {
    phase,
    take,
    liveGroups,
    liveCount: live.length,
    elapsedMs,
    start,
    stop,
    reset,
    capturing,
  };
}

export type MacroRecorderApi = ReturnType<typeof useMacroRecorder>;
