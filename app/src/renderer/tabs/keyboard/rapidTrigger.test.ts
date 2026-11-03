import { describe, expect, it } from 'vitest';
import { rtInitial, rtStep, rtThresholds, type RtConfig } from './rapidTrigger';

const CFG: RtConfig = { actuationMm: 1.5, pressMm: 0.3, releaseMm: 0.3 };

/** Run a depth trace and return the press/release edges it produced. */
function trace(depths: number[], cfg = CFG) {
  let s = rtInitial();
  const edges: string[] = [];
  for (const d of depths) {
    const next = rtStep(s, d, cfg);
    if (next.down !== s.down) edges.push(`${next.down ? 'press' : 'release'}@${d}`);
    s = next;
  }
  return { edges, state: s };
}

describe('rapid trigger', () => {
  it('fires when the key passes the actuation point', () => {
    expect(trace([0, 0.5, 1.4, 1.6]).edges).toEqual(['press@1.6']);
  });

  it('releases after rising `releaseMm` from the deepest point, NOT at the actuation point', () => {
    // Down to 3.0, then back up. 3.0 - 0.3 = 2.7 releases — well below the
    // 1.5 mm actuation point, which is the entire point of rapid trigger.
    const { edges } = trace([0, 2.0, 3.0, 2.8, 2.7]);
    expect(edges).toEqual(['press@2', 'release@2.7']);
  });

  it('re-fires after falling `pressMm` from the shallowest point, still deep in the stroke', () => {
    const { edges } = trace([0, 3.0, 2.7, 2.6, 2.9]);
    // press at 3.0, release at 2.7 (3.0-0.3), then re-press at 2.9 (2.6+0.3).
    expect(edges).toEqual(['press@3', 'release@2.7', 'press@2.9']);
  });

  it('does several presses per stroke — a plain threshold does one', () => {
    const depths = [0, 2.5, 2.2, 2.5, 2.2, 2.5, 0];
    const rt = trace(depths).edges.filter((e) => e.startsWith('press'));
    expect(rt.length).toBe(3);

    // The same trace with RT effectively off (huge sensitivities) fires once.
    const plain = trace(depths, { actuationMm: 1.5, pressMm: 9, releaseMm: 9 }).edges.filter((e) =>
      e.startsWith('press'),
    );
    expect(plain.length).toBe(1);
  });

  it('disarms once the key returns above the actuation point', () => {
    const { state } = trace([0, 2.0, 0.2]);
    expect(state.armed).toBe(false);
    expect(state.down).toBe(false);
  });

  it('a partial lift smaller than the sensitivity does not release', () => {
    expect(trace([0, 3.0, 2.85]).edges).toEqual(['press@3']);
  });

  describe('thresholds the diagram draws', () => {
    it('has none before the key is armed', () => {
      expect(rtThresholds(rtInitial(), CFG)).toEqual({ releaseAt: null, pressAt: null });
    });

    it('tracks the deepest point while down', () => {
      const { state } = trace([0, 2.0, 3.2]);
      expect(rtThresholds(state, CFG).releaseAt).toBeCloseTo(2.9, 6);
    });

    it('tracks the shallowest point while up', () => {
      const { state } = trace([0, 3.0, 2.6]);
      expect(rtThresholds(state, CFG).pressAt).toBeCloseTo(2.9, 6);
    });

    it('never reports a release threshold above the top of travel', () => {
      const { state } = trace([0, 1.6], { actuationMm: 1.5, pressMm: 0.3, releaseMm: 9 });
      expect(rtThresholds(state, { actuationMm: 1.5, pressMm: 0.3, releaseMm: 9 }).releaseAt).toBe(
        0,
      );
    });
  });
});
