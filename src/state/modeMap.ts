/**
 * Shared Pro1 `sys` ⇄ HomeKit mode mapping and temperature conversion.
 *
 * These maps were duplicated in cloudStateProvider.ts and
 * appCloudStateProvider.ts, which meant a correction had to be made twice
 * (and the `sys` polarity has already been corrected once — see below).
 * Both providers now import from here so the two paths cannot drift.
 *
 * `sys` polarity is INVERTED relative to the naive reading, verified live on
 * a T855iSHv2: sys=1 is COOL and sys=2 is HEAT.
 */

import type { FanMode } from './stateProvider.js';

/**
 * Fan mode → device `fan` value.
 *
 * Like `sys`, the polarity is INVERTED relative to the naive reading.
 * Verified live 2026-09-03: fan=0 runs the blower continuously (the app's
 * "On") and fan=1 is "Auto". The 0.2.0 release shipped the naive guess and
 * had the Home app's fan switch backwards.
 */
export const FAN_MODE_TO_VALUE: Readonly<Record<FanMode, number>> = {
  on: 0, // continuous (verified live)
  auto: 1, // with heat/cool calls (verified live)
};

/** Device `fan` value → fan mode, or null when absent or unrecognised. */
export function fanValueToMode(value: number | null): FanMode | null {
  if (value === FAN_MODE_TO_VALUE.auto) {
    return 'auto';
  }
  if (value === FAN_MODE_TO_VALUE.on) {
    return 'on';
  }
  return null;
}

/** Device `sys` → HomeKit TargetHeatingCoolingState (0=Off 1=Heat 2=Cool 3=Auto). */
export const SYS_TO_TARGET_MODE: Readonly<Record<number, 0 | 1 | 2 | 3 | null>> = {
  0: 0, // OFF
  1: 2, // COOL (verified live: Home Cool -> device sys=1)
  2: 1, // HEAT (verified live: Home Heat -> device sys=2)
  3: 3, // AUTO
};

/** HomeKit TargetHeatingCoolingState → device `sys`. */
export const HOMEKIT_TO_SYS: Readonly<Record<0 | 1 | 2 | 3, number>> = {
  0: 0, // OFF
  1: 2, // HEAT -> sys 2 (verified live)
  2: 1, // COOL -> sys 1 (verified live)
  3: 3, // AUTO
};

/**
 * HomeKit CurrentHeatingCoolingState. Unlike the Target characteristic this
 * one has NO "auto" value — HAP permits only Off/Heat/Cool, so a provider
 * must never report 3 here.
 */
export type CurrentHeatingCoolingState = 0 | 1 | 2;

/**
 * Derive HomeKit CurrentHeatingCoolingState from the shadow.
 *
 * sys=0 (off) resolves to Off rather than "unknown". Reporting unknown left
 * the characteristic at its previous value, so a thermostat switched off kept
 * showing "Heating" in the Home app indefinitely.
 *
 * sys=3 (auto) is inferred from the setpoints, because the device reports the
 * configured mode rather than the active stage: at or above the cool setpoint
 * means cooling, at or below the heat setpoint means heating, and anything in
 * the deadband means idle. Returns null only when auto cannot be resolved for
 * lack of setpoint/ambient data.
 *
 * @param sys Raw device `sys` value, or null when absent from the shadow.
 * @param ambientF Ambient temperature in °F, or null.
 * @param heatSetpointF Heat setpoint in °F, or null.
 * @param coolSetpointF Cool setpoint in °F, or null.
 */
export function deriveCurrentState(
  sys: number | null,
  ambientF: number | null,
  heatSetpointF: number | null,
  coolSetpointF: number | null,
): CurrentHeatingCoolingState | null {
  switch (sys) {
  case 0:
    return 0; // OFF — unambiguous.
  case 1:
    return 2; // COOL (verified live)
  case 2:
    return 1; // HEAT (verified live)
  case 3:
    if (ambientF === null) {
      return null;
    }
    if (coolSetpointF !== null && ambientF >= coolSetpointF) {
      return 2;
    }
    if (heatSetpointF !== null && ambientF <= heatSetpointF) {
      return 1;
    }
    return heatSetpointF === null && coolSetpointF === null ? null : 0;
  default:
    return null;
  }
}

/**
 * Pick the setpoint HomeKit should show as TargetTemperature. HomeKit exposes
 * a single target, so cool mode shows the cool setpoint, auto shows whichever
 * stage is calling, and everything else shows the heat setpoint.
 *
 * @param targetMode HomeKit target mode, or null when unknown.
 * @returns The chosen setpoint in °F, or null when unavailable.
 */
export function selectTargetSetpointF(
  targetMode: 0 | 1 | 2 | 3 | null,
  ambientF: number | null,
  heatSetpointF: number | null,
  coolSetpointF: number | null,
): number | null {
  if (targetMode === 2) {
    return coolSetpointF;
  }
  if (targetMode === 3 && coolSetpointF !== null && ambientF !== null && ambientF >= coolSetpointF) {
    return coolSetpointF;
  }
  return heatSetpointF;
}

/** Fahrenheit → Celsius, rounded to 2 decimals. */
export function fahrenheitToCelsius(fahrenheit: number): number {
  return Math.round((((fahrenheit - 32) * 5) / 9) * 100) / 100;
}

/** Celsius → Fahrenheit, rounded to 1 decimal. */
export function celsiusToFahrenheit(celsius: number): number {
  return Math.round(((celsius * 9) / 5 + 32) * 10) / 10;
}

/**
 * Celsius → whole Fahrenheit, for setpoint writes.
 *
 * The device stores setpoints in whole °F. A fractional write (22 °C → 71.6)
 * comes back in `reported` as 72, so the shadow `desired` entry never matched
 * and was never cleared — leaving a standing order that could put the old
 * setpoint back after a change made at the thermostat.
 */
export function celsiusToWholeFahrenheit(celsius: number): number {
  return Math.round((celsius * 9) / 5 + 32);
}

/** Read a shadow field as a finite number, or null when absent/invalid. */
export function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
