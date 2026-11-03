/**
 * What rapid trigger actually does, as a small state machine.
 *
 * Without RT a key is a plain threshold with hysteresis: it fires once it
 * passes the actuation point, and cannot fire again until it comes back up
 * past the release point. One press per full stroke.
 *
 * With RT the thresholds are **relative to how far the key has travelled since
 * it last changed direction**, not to a fixed depth:
 *
 *   - while the key is down, it releases as soon as it rises `releaseMm` above
 *     the **deepest point it has reached** on this stroke;
 *   - while it is up (but still past the initial actuation point), it fires
 *     again as soon as it falls `pressMm` below the **shallowest point since
 *     that release**.
 *
 * So both thresholds chase the key. That is why the diagram used to be wrong:
 * it drew them at `actuation ± sensitivity`, fixed to the actuation point, so
 * they slid around when the actuation slider moved and never moved with the
 * key. The vendor's own field names say the same thing —
 * `再次按下按键触发所需的行程` ("travel needed to trigger when pressing again")
 * and `松开按键重置所需的行程` ("travel needed to reset when releasing").
 *
 * The key must still return above the actuation point to disarm RT entirely;
 * below that point the relative rules apply.
 */
export interface RtConfig {
  actuationMm: number;
  /** Travel back down, from the shallowest point, that re-triggers the key. */
  pressMm: number;
  /** Travel back up, from the deepest point, that releases the key. */
  releaseMm: number;
}

export interface RtState {
  /** Is the key currently reported as pressed? */
  down: boolean;
  /** Deepest travel reached since the key last went down. */
  deepest: number;
  /** Shallowest travel since the key last came up, while still armed. */
  shallowest: number;
  /** True once past the actuation point, until the key returns above it. */
  armed: boolean;
}

/**
 * Travel comparisons are between measured millimetres, so they need a
 * tolerance: `2.5 - 2.2` is 0.2999999999999998 in binary floating point and
 * would sit just under a 0.3 mm threshold forever. A micrometre is far below
 * both the sensor resolution and the 0.01 mm setting step.
 */
const EPS = 1e-6;

export const rtInitial = (): RtState => ({ down: false, deepest: 0, shallowest: 0, armed: false });

/**
 * Advance the model by one depth sample. Pure — the caller keeps the state, so
 * the same function drives the live diagram and the tooltip animation.
 */
export function rtStep(state: RtState, depthMm: number, cfg: RtConfig): RtState {
  const { actuationMm, pressMm, releaseMm } = cfg;

  // Above the actuation point the key is fully released and RT is disarmed —
  // the next press starts a fresh stroke.
  if (depthMm < actuationMm) {
    return { down: false, deepest: depthMm, shallowest: depthMm, armed: false };
  }

  // At or past the actuation point.
  if (!state.armed) {
    return { down: true, deepest: depthMm, shallowest: depthMm, armed: true };
  }

  if (state.down) {
    const deepest = Math.max(state.deepest, depthMm);
    // Released once it has risen `releaseMm` from the deepest point.
    if (deepest - depthMm >= releaseMm - EPS) {
      return { down: false, deepest, shallowest: depthMm, armed: true };
    }
    return { ...state, down: true, deepest, shallowest: depthMm };
  }

  const shallowest = Math.min(state.shallowest, depthMm);
  // Fires again once it has fallen `pressMm` from the shallowest point.
  if (depthMm - shallowest >= pressMm - EPS) {
    return { down: true, deepest: depthMm, shallowest, armed: true };
  }
  return { ...state, down: false, shallowest };
}

/**
 * Where the two RT thresholds currently sit, in mm of travel — i.e. what the
 * diagram should draw. `null` when the threshold does not apply in the current
 * state (there is no re-press threshold while the key is already down).
 */
export function rtThresholds(
  state: RtState,
  cfg: RtConfig,
): { releaseAt: number | null; pressAt: number | null } {
  if (!state.armed) return { releaseAt: null, pressAt: null };
  return state.down
    ? { releaseAt: Math.max(0, state.deepest - cfg.releaseMm), pressAt: null }
    : { releaseAt: null, pressAt: state.shallowest + cfg.pressMm };
}
