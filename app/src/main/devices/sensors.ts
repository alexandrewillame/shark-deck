import { DPI_REGISTER_TABLES } from './dpi-tables';

/**
 * DPI <-> sensor register conversion.
 *
 * For sensors with an explicit lookup table in the vendor `driver_sensor.h`
 * (PAW3311/3325/3335/3220/4090/8960 families) we use it directly. For sensors
 * driven by a linear formula (the V8's PAW3950: `DPIRange=50,26000,50,…` in the
 * Hub's Config.ini) we fall back to `round(dpi / step)`. The V8 path is
 * `provenance: inferred` until confirmed against a capture.
 */

export interface SensorProfile {
  name: string;
  minDpi: number;
  maxDpi: number;
  stepDpi: number;
  supportsModeSelect: boolean;
  supportsLodCal: boolean;
  supportsRipple: boolean;
  supportsMotionSync: boolean;
}

// SUPPORT_* macros from driver_sensor.h
const MODE_SELECT = new Set(['3395', '3311', '3370', '3335', '3950']);
const LOD_CAL = new Set(['3395', '3370', '3399', '3335', '3950']);
const RIPPLE = new Set(['3395', '3311', '3370', '3335', '3950']);
const MOTION_SYNC = new Set(['3395', '3950']);

export function sensorProfile(name: string, min = 50, max = 26000, step = 50): SensorProfile {
  const key = name.replace(/[^0-9]/g, '');
  return {
    name,
    minDpi: min,
    maxDpi: max,
    stepDpi: step,
    supportsModeSelect: MODE_SELECT.has(key),
    supportsLodCal: LOD_CAL.has(key),
    supportsRipple: RIPPLE.has(key),
    supportsMotionSync: MOTION_SYNC.has(key),
  };
}

export function dpiToRegister(sensor: string, dpi: number, step = 50): number {
  const key = sensor.replace(/[^0-9]/g, '');
  const table = DPI_REGISTER_TABLES[key];
  if (table) {
    // snap to the nearest tabulated DPI
    let best = -1;
    let bestErr = Infinity;
    for (const d of Object.keys(table)) {
      const err = Math.abs(Number(d) - dpi);
      if (err < bestErr) {
        bestErr = err;
        best = Number(d);
      }
    }
    return table[best]!;
  }
  return Math.max(0, Math.round(dpi / step));
}

export function registerToDpi(sensor: string, reg: number, step = 50): number {
  const key = sensor.replace(/[^0-9]/g, '');
  const table = DPI_REGISTER_TABLES[key];
  if (table) {
    for (const [d, r] of Object.entries(table)) if (r === reg) return Number(d);
  }
  return reg * step;
}
