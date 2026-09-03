import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FAN_MODE_TO_VALUE,
  HOMEKIT_TO_SYS,
  SYS_TO_TARGET_MODE,
  celsiusToFahrenheit,
  deriveCurrentState,
  fahrenheitToCelsius,
  fanValueToMode,
  numberOrNull,
  selectTargetSetpointF,
} from '../src/state/modeMap.js';

test('sys maps round-trip for every HomeKit target mode', () => {
  for (const mode of [0, 1, 2, 3] as const) {
    assert.equal(SYS_TO_TARGET_MODE[HOMEKIT_TO_SYS[mode]], mode);
  }
});

test('sys polarity stays inverted: 1 is cool and 2 is heat', () => {
  assert.equal(SYS_TO_TARGET_MODE[1], 2, 'device sys=1 is COOL');
  assert.equal(SYS_TO_TARGET_MODE[2], 1, 'device sys=2 is HEAT');
  assert.equal(HOMEKIT_TO_SYS[1], 2, 'HomeKit HEAT commands sys=2');
  assert.equal(HOMEKIT_TO_SYS[2], 1, 'HomeKit COOL commands sys=1');
});

test('deriveCurrentState reports Off when the thermostat is off', () => {
  // Regression: sys=0 used to map to null, which meant the characteristic was
  // never updated and the Home app kept showing "Heating" for a unit that was
  // switched off.
  assert.equal(deriveCurrentState(0, 70, 68, 74), 0);
});

test('deriveCurrentState maps the verified cool/heat polarity', () => {
  assert.equal(deriveCurrentState(1, 70, 68, 74), 2, 'sys=1 is COOL');
  assert.equal(deriveCurrentState(2, 70, 68, 74), 1, 'sys=2 is HEAT');
});

test('deriveCurrentState infers the active stage in auto mode', () => {
  assert.equal(deriveCurrentState(3, 76, 68, 74), 2, 'at or above cool setpoint -> cooling');
  assert.equal(deriveCurrentState(3, 66, 68, 74), 1, 'at or below heat setpoint -> heating');
  assert.equal(deriveCurrentState(3, 71, 68, 74), 0, 'inside the deadband -> idle');
});

test('deriveCurrentState returns null when auto cannot be resolved', () => {
  assert.equal(deriveCurrentState(3, null, 68, 74), null, 'no ambient reading');
  assert.equal(deriveCurrentState(3, 70, null, null), null, 'no setpoints');
  assert.equal(deriveCurrentState(null, 70, 68, 74), null, 'no sys value');
  assert.equal(deriveCurrentState(9, 70, 68, 74), null, 'unknown sys value');
});

test('deriveCurrentState never returns auto, which HAP rejects on the current characteristic', () => {
  for (const sys of [0, 1, 2, 3, 4, null]) {
    const state = deriveCurrentState(sys, 70, 68, 74);
    assert.ok(state === null || state === 0 || state === 1 || state === 2, `sys=${sys} produced ${state}`);
  }
});

test('selectTargetSetpointF picks the setpoint for the active mode', () => {
  assert.equal(selectTargetSetpointF(1, 70, 68, 74), 68, 'heat shows the heat setpoint');
  assert.equal(selectTargetSetpointF(2, 70, 68, 74), 74, 'cool shows the cool setpoint');
  assert.equal(selectTargetSetpointF(0, 70, 68, 74), 68, 'off falls back to the heat setpoint');
  assert.equal(selectTargetSetpointF(3, 76, 68, 74), 74, 'auto above the cool setpoint shows cool');
  assert.equal(selectTargetSetpointF(3, 66, 68, 74), 68, 'auto below the cool setpoint shows heat');
});

test('temperature conversion round-trips within rounding tolerance', () => {
  for (const fahrenheit of [45, 68, 70, 71.6, 90]) {
    const celsius = fahrenheitToCelsius(fahrenheit);
    assert.ok(Math.abs(celsiusToFahrenheit(celsius) - fahrenheit) < 0.1, `${fahrenheit}F round-trip`);
  }
  assert.equal(fahrenheitToCelsius(32), 0);
  assert.equal(celsiusToFahrenheit(22), 71.6);
});

test('numberOrNull rejects non-finite and non-numeric shadow values', () => {
  assert.equal(numberOrNull(70), 70);
  assert.equal(numberOrNull(0), 0);
  assert.equal(numberOrNull('70'), null);
  assert.equal(numberOrNull(NaN), null);
  assert.equal(numberOrNull(Infinity), null);
  assert.equal(numberOrNull(undefined), null);
  assert.equal(numberOrNull(null), null);
});

test('fan values map to the two fan modes and round-trip', () => {
  assert.equal(fanValueToMode(FAN_MODE_TO_VALUE.auto), 'auto');
  assert.equal(fanValueToMode(FAN_MODE_TO_VALUE.on), 'on');
  assert.notEqual(FAN_MODE_TO_VALUE.auto, FAN_MODE_TO_VALUE.on);
});

test('fan polarity stays inverted: 0 is on (continuous) and 1 is auto', () => {
  // Verified live 2026-09-03: writing fan=1 put the thermostat in Auto and
  // fan=0 ran the blower continuously, the opposite of the naive guess.
  assert.equal(fanValueToMode(0), 'on', 'device fan=0 is ON (continuous)');
  assert.equal(fanValueToMode(1), 'auto', 'device fan=1 is AUTO');
  assert.equal(FAN_MODE_TO_VALUE.on, 0, 'fan ON commands fan=0');
  assert.equal(FAN_MODE_TO_VALUE.auto, 1, 'fan AUTO commands fan=1');
});

test('fan mode is unknown for an absent or unrecognised fan value', () => {
  assert.equal(fanValueToMode(null), null);
  assert.equal(fanValueToMode(42), null);
});
