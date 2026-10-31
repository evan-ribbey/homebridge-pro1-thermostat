import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Pro1ThermostatAccessory } from '../src/platformAccessory.js';
import type { Pro1ThermostatPlatform } from '../src/platform.js';
import type { PlatformAccessory } from 'homebridge';
import {
  FanMode,
  StateProviderNotImplementedError,
  StateProviderUnavailableError,
  ThermostatStateProvider,
  ThermostatStateSnapshot,
} from '../src/state/index.js';

interface FakeProps {
  minValue: number;
  maxValue: number;
  minStep: number;
}

class FakeCharacteristic {
  public readonly updatedValues: unknown[] = [];

  onGet(fn: () => unknown): this {
    this.onGetFn = fn;
    return this;
  }

  onSet(fn: (value: unknown) => unknown): this {
    this.onSetFn = fn;
    return this;
  }

  setProps(props: FakeProps): this {
    this.props = props;
    return this;
  }

  public props: FakeProps | null = null;
  public onGetFn: (() => unknown) | null = null;
  public onSetFn: ((value: unknown) => unknown) | null = null;
}

class FakeService {
  private readonly characteristics = new Map<string, FakeCharacteristic>();

  getCharacteristic(key: string): FakeCharacteristic {
    let characteristic = this.characteristics.get(key);
    if (!characteristic) {
      characteristic = new FakeCharacteristic();
      this.characteristics.set(key, characteristic);
    }
    return characteristic;
  }

  setCharacteristic(key: string, _value: unknown): this {
    void _value;
    this.getCharacteristic(key);
    return this;
  }

  updateCharacteristic(key: string, value: unknown): void {
    this.getCharacteristic(key).updatedValues.push(value);
  }
}

class FakeAccessory {
  public readonly context: Record<string, unknown> = {};
  private readonly services = new Map<string, FakeService>();

  public constructor(
    public readonly displayName: string,
    public readonly UUID: string,
  ) {
    this.services.set('AccessoryInformation', new FakeService());
  }

  getService(key: string): FakeService | undefined {
    return this.services.get(key);
  }

  addService(key: string): FakeService {
    const service = new FakeService();
    this.services.set(key, service);
    return service;
  }
}

const DEVICE = { name: 'Living Room', host: '192.0.2.1', pollingInterval: 60 };

function makePlatform(): Pro1ThermostatPlatform {
  const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
  const Service = { AccessoryInformation: 'AccessoryInformation', Thermostat: 'Thermostat', Fanv2: 'Fanv2' };
  const Characteristic = {
    Manufacturer: 'Manufacturer',
    Model: 'Model',
    SerialNumber: 'SerialNumber',
    Name: 'Name',
    CurrentHeatingCoolingState: 'CurrentHeatingCoolingState',
    TargetHeatingCoolingState: 'TargetHeatingCoolingState',
    CurrentTemperature: 'CurrentTemperature',
    TargetTemperature: 'TargetTemperature',
    TemperatureDisplayUnits: 'TemperatureDisplayUnits',
    CurrentRelativeHumidity: 'CurrentRelativeHumidity',
    Active: 'Active',
  };
  return { log, Service, Characteristic } as unknown as Pro1ThermostatPlatform;
}

function makeAccessory(provider: ThermostatStateProvider) {
  const accessory = new FakeAccessory('Living Room', 'uuid-192.0.2.1');
  const platform = makePlatform();
  const thermostat = new Pro1ThermostatAccessory(platform, accessory as unknown as PlatformAccessory, DEVICE, provider);
  return { accessory, thermostat };
}

function snapshot(overrides: Partial<ThermostatStateSnapshot> = {}): ThermostatStateSnapshot {
  return {
    currentTemperatureCelsius: null,
    targetTemperatureCelsius: null,
    currentHeatingCoolingState: null,
    targetHeatingCoolingState: null,
    currentRelativeHumidityPercent: null,
    fanMode: null,
    isOnline: true,
    readTimestampMs: Date.now(),
    ...overrides,
  };
}

function staticProvider(): ThermostatStateProvider {
  return {
    readState: async () => snapshot(),
    setTargetTemperature: async () => {},
    setTargetHeatingCoolingState: async () => {},
    setFanMode: async () => {},
  };
}

test('serves defaults before the first poll', async () => {
  const { thermostat } = makeAccessory(staticProvider());
  assert.equal(await thermostat.getCurrentTemperature(), 20);
  assert.equal(await thermostat.getTargetTemperature(), 20);
  assert.equal(await thermostat.getCurrentHeatingCoolingState(), 0);
  assert.equal(await thermostat.getTargetHeatingCoolingState(), 0);
  assert.equal(await thermostat.getCurrentRelativeHumidity(), 50);
});

test('serves polled snapshot values and pushes them via updateCharacteristic', async () => {
  const provider: ThermostatStateProvider = {
    readState: async () => snapshot({
      currentTemperatureCelsius: 23.5,
      targetTemperatureCelsius: 21,
      currentHeatingCoolingState: 1,
      targetHeatingCoolingState: 1,
      currentRelativeHumidityPercent: 42,
    }),
    setTargetTemperature: async () => {},
    setTargetHeatingCoolingState: async () => {},
    setFanMode: async () => {},
  };
  const { accessory, thermostat } = makeAccessory(provider);
  await thermostat.startPolling();

  assert.equal(await thermostat.getCurrentTemperature(), 23.5);
  assert.equal(await thermostat.getTargetTemperature(), 21);
  assert.equal(await thermostat.getCurrentHeatingCoolingState(), 1);
  assert.equal(await thermostat.getCurrentRelativeHumidity(), 42);

  const service = accessory.getService('Thermostat');
  assert.ok(service);
  const currentTemp = service.getCharacteristic('CurrentTemperature');
  assert.ok(currentTemp.updatedValues.includes(23.5));
  const targetTemp = service.getCharacteristic('TargetTemperature');
  assert.ok(targetTemp.updatedValues.includes(21));
});

test('setTargetTemperature delegates to the provider', async () => {
  let received: number | null = null;
  const provider: ThermostatStateProvider = {
    readState: async () => snapshot(),
    setTargetTemperature: async (value: number) => {
      received = value;
    },
    setTargetHeatingCoolingState: async () => {},
    setFanMode: async () => {},
  };
  const { thermostat } = makeAccessory(provider);
  await thermostat.setTargetTemperature(24);
  assert.equal(received, 24);
});

test('setTargetTemperature swallows StateProviderNotImplementedError', async () => {
  const provider: ThermostatStateProvider = {
    readState: async () => snapshot(),
    setTargetTemperature: async () => {
      throw new StateProviderNotImplementedError('not supported');
    },
    setTargetHeatingCoolingState: async () => {},
    setFanMode: async () => {},
  };
  const { thermostat } = makeAccessory(provider);
  await assert.doesNotReject(() => thermostat.setTargetTemperature(24));
});

test('setTargetHeatingCoolingState swallows StateProviderNotImplementedError', async () => {
  const provider: ThermostatStateProvider = {
    readState: async () => snapshot(),
    setTargetTemperature: async () => {},
    setTargetHeatingCoolingState: async () => {
      throw new StateProviderNotImplementedError('not supported');
    },
    setFanMode: async () => {},
  };
  const { thermostat } = makeAccessory(provider);
  await assert.doesNotReject(() => thermostat.setTargetHeatingCoolingState(1));
});

test('keeps last known state when a poll fails', async () => {
  let calls = 0;
  const provider: ThermostatStateProvider = {
    readState: async () => {
      calls += 1;
      if (calls === 1) {
        return snapshot({ currentTemperatureCelsius: 22 });
      }
      throw new StateProviderUnavailableError('down');
    },
    setTargetTemperature: async () => {},
    setTargetHeatingCoolingState: async () => {},
    setFanMode: async () => {},
  };
  const { thermostat } = makeAccessory(provider);
  await thermostat.startPolling();
  assert.equal(await thermostat.getCurrentTemperature(), 22);
  await thermostat.startPolling();
  assert.equal(await thermostat.getCurrentTemperature(), 22);
});

/** A provider whose snapshot can be swapped between polls. */
function mutableProvider(initial: Partial<ThermostatStateSnapshot>) {
  const state = { snapshot: snapshot(initial), failures: 0, sets: [] as number[], modes: [] as number[], fans: [] as FanMode[] };
  const provider: ThermostatStateProvider = {
    readState: async () => {
      if (state.failures > 0) {
        state.failures -= 1;
        throw new StateProviderUnavailableError('down');
      }
      return state.snapshot;
    },
    setTargetTemperature: async (value: number) => {
      state.sets.push(value);
    },
    setTargetHeatingCoolingState: async (value: number) => {
      state.modes.push(value);
    },
    setFanMode: async (value: FanMode) => {
      state.fans.push(value);
    },
  };
  return { provider, state };
}

test('a polled value does not snap back a target the user just set', async () => {
  const { provider, state } = mutableProvider({ targetTemperatureCelsius: 21 });
  const { accessory, thermostat } = makeAccessory(provider);

  await thermostat.startPolling();
  await thermostat.setTargetTemperature(24);
  assert.deepEqual(state.sets, [24]);

  // The first poll legitimately published 21; only pushes after the user's
  // change matter here.
  const pushed = accessory.getService('Thermostat')!.getCharacteristic('TargetTemperature').updatedValues;
  const pushCountAtSet = pushed.length;

  // The device has not applied the change yet and still reports 21.
  await thermostat.startPolling();

  assert.equal(await thermostat.getTargetTemperature(), 24, 'the commanded value must win');
  assert.deepEqual(
    pushed.slice(pushCountAtSet),
    [],
    'the stale device value must not be pushed back to HomeKit',
  );
});

test('the commanded target is released once the device confirms it', async () => {
  const { provider, state } = mutableProvider({ targetTemperatureCelsius: 21 });
  const { thermostat } = makeAccessory(provider);

  await thermostat.startPolling();
  await thermostat.setTargetTemperature(24);

  // Device applies the change.
  state.snapshot = snapshot({ targetTemperatureCelsius: 24 });
  await thermostat.startPolling();
  assert.equal(await thermostat.getTargetTemperature(), 24);

  // A later change made at the thermostat itself must now come through.
  state.snapshot = snapshot({ targetTemperatureCelsius: 19 });
  await thermostat.startPolling();
  assert.equal(await thermostat.getTargetTemperature(), 19, 'a manual change at the wall must not be suppressed');
});

test('a manual change wins once the pending window lapses', async () => {
  const { provider, state } = mutableProvider({ targetTemperatureCelsius: 21 });
  const { thermostat } = makeAccessory(provider);

  await thermostat.startPolling();
  await thermostat.setTargetTemperature(24);

  // The command was never applied; simulate the settle window elapsing.
  const realNow = Date.now;
  Date.now = () => realNow() + 130_000;
  try {
    state.snapshot = snapshot({ targetTemperatureCelsius: 19 });
    await thermostat.startPolling();
    assert.equal(await thermostat.getTargetTemperature(), 19, 'the plugin must stop overriding the device forever');
  } finally {
    Date.now = realNow;
  }
});

test('a commanded mode is held until the device confirms it', async () => {
  const { provider, state } = mutableProvider({ targetHeatingCoolingState: 1 });
  const { thermostat } = makeAccessory(provider);

  await thermostat.startPolling();
  await thermostat.setTargetHeatingCoolingState(2);
  assert.deepEqual(state.modes, [2]);

  await thermostat.startPolling(); // device still reports heat
  assert.equal(await thermostat.getTargetHeatingCoolingState(), 2);

  state.snapshot = snapshot({ targetHeatingCoolingState: 2 });
  await thermostat.startPolling();
  assert.equal(await thermostat.getTargetHeatingCoolingState(), 2);
});

test('reports No Response after three consecutive failed polls', async () => {
  const { provider, state } = mutableProvider({ currentTemperatureCelsius: 22 });
  const { thermostat } = makeAccessory(provider);

  await thermostat.startPolling();
  assert.equal(await thermostat.getCurrentTemperature(), 22);

  state.failures = 3;
  await thermostat.startPolling();
  assert.equal(await thermostat.getCurrentTemperature(), 22, 'one blip still serves last-known state');
  await thermostat.startPolling();
  assert.equal(await thermostat.getCurrentTemperature(), 22, 'two blips still serve last-known state');
  await thermostat.startPolling();

  await assert.rejects(() => thermostat.getCurrentTemperature());
  await assert.rejects(() => thermostat.getCurrentHeatingCoolingState());
  await assert.rejects(() => thermostat.getCurrentRelativeHumidity());
});

test('recovers from No Response once a poll succeeds again', async () => {
  const { provider, state } = mutableProvider({ currentTemperatureCelsius: 22 });
  const { thermostat } = makeAccessory(provider);

  state.failures = 3;
  await thermostat.startPolling();
  await thermostat.startPolling();
  await thermostat.startPolling();
  await assert.rejects(() => thermostat.getCurrentTemperature());

  await thermostat.startPolling(); // succeeds
  assert.equal(await thermostat.getCurrentTemperature(), 22);
});

test('TemperatureDisplayUnits remembers the HomeKit preference', async () => {
  const { thermostat } = makeAccessory(staticProvider());
  assert.equal(await thermostat.getTemperatureDisplayUnits(), 1, 'defaults to Fahrenheit');
  await thermostat.setTemperatureDisplayUnits(0);
  assert.equal(await thermostat.getTemperatureDisplayUnits(), 0, 'the choice must not revert');
});

test('startPolling is idempotent and stopPolling clears the timer', async () => {
  const { provider } = mutableProvider({ currentTemperatureCelsius: 22 });
  const { thermostat } = makeAccessory(provider);

  await thermostat.startPolling();
  await thermostat.startPolling();
  thermostat.stopPolling();
  thermostat.stopPolling(); // safe to repeat
});

test('TargetTemperature advertises a range covering the Pro1 setpoint span', async () => {
  const { accessory } = makeAccessory(staticProvider());
  const props = accessory.getService('Thermostat')!.getCharacteristic('TargetTemperature').props;
  assert.ok(props !== null, 'setProps must be called so HomeKit does not clamp low setpoints');
  // 45 °F freeze-protection setpoints are 7.2 °C, below HomeKit's 10 °C default.
  assert.ok(props.minValue <= 7.3, `minValue ${props.minValue} must reach a 45F setpoint`);
  assert.ok(props.maxValue >= 32.3, `maxValue ${props.maxValue} must reach a 90F setpoint`);
});

test('an unchanged reading is not re-pushed to HomeKit on every poll', async () => {
  const { provider } = mutableProvider({ currentTemperatureCelsius: 22, currentRelativeHumidityPercent: 40 });
  const { accessory, thermostat } = makeAccessory(provider);

  await thermostat.startPolling();
  await thermostat.startPolling();
  await thermostat.startPolling();

  const service = accessory.getService('Thermostat')!;
  // A thermostat is mostly idle; re-sending identical values every poll is
  // pure HAP event noise for every subscribed controller.
  assert.deepEqual(service.getCharacteristic('CurrentTemperature').updatedValues, [22]);
  assert.deepEqual(service.getCharacteristic('CurrentRelativeHumidity').updatedValues, [40]);
});

test('a changed reading is still pushed', async () => {
  const { provider, state } = mutableProvider({ currentTemperatureCelsius: 22 });
  const { accessory, thermostat } = makeAccessory(provider);

  await thermostat.startPolling();
  state.snapshot = snapshot({ currentTemperatureCelsius: 23 });
  await thermostat.startPolling();
  state.snapshot = snapshot({ currentTemperatureCelsius: 23 });
  await thermostat.startPolling();

  assert.deepEqual(accessory.getService('Thermostat')!.getCharacteristic('CurrentTemperature').updatedValues, [22, 23]);
});

test('everything is re-published after recovering from No Response', async () => {
  const { provider, state } = mutableProvider({ currentTemperatureCelsius: 22 });
  const { accessory, thermostat } = makeAccessory(provider);

  await thermostat.startPolling();
  state.failures = 3;
  await thermostat.startPolling();
  await thermostat.startPolling();
  await thermostat.startPolling();
  await assert.rejects(() => thermostat.getCurrentTemperature());

  // Same value as before the outage, but controllers may have dropped it.
  await thermostat.startPolling();
  assert.deepEqual(accessory.getService('Thermostat')!.getCharacteristic('CurrentTemperature').updatedValues, [22, 22]);
});

// ---------------------------------------------------------------------------
// Fan v2 service: Active = 1 means the fan runs continuously ("On" in the
// Pro1 app), Active = 0 means the fan only runs with a heat/cool call ("Auto").
// ---------------------------------------------------------------------------

test('exposes a Fan v2 service whose Active characteristic defaults to auto before the first poll', async () => {
  const { accessory, thermostat } = makeAccessory(staticProvider());
  const fan = accessory.getService('Fanv2');
  assert.ok(fan, 'a Fan v2 service must be added to the accessory');
  assert.ok(fan.getCharacteristic('Active').onGetFn, 'Active must have a GET handler');
  assert.ok(fan.getCharacteristic('Active').onSetFn, 'Active must have a SET handler');
  assert.equal(await thermostat.getFanActive(), 0);
});

test('a polled fan mode is served and pushed to the Fan v2 service', async () => {
  const { provider, state } = mutableProvider({ fanMode: 'on' });
  const { accessory, thermostat } = makeAccessory(provider);

  await thermostat.startPolling();
  assert.equal(await thermostat.getFanActive(), 1);
  const active = accessory.getService('Fanv2')!.getCharacteristic('Active');
  assert.deepEqual(active.updatedValues, [1]);

  state.snapshot = snapshot({ fanMode: 'auto' });
  await thermostat.startPolling();
  assert.equal(await thermostat.getFanActive(), 0);
  assert.deepEqual(active.updatedValues, [1, 0]);
});

test('an unknown fan mode is never pushed', async () => {
  const { provider } = mutableProvider({ fanMode: null });
  const { accessory, thermostat } = makeAccessory(provider);

  await thermostat.startPolling();

  assert.deepEqual(accessory.getService('Fanv2')!.getCharacteristic('Active').updatedValues, []);
});

test('setting Active commands the fan on or auto through the provider', async () => {
  const { provider, state } = mutableProvider({});
  const { thermostat } = makeAccessory(provider);

  await thermostat.setFanActive(1);
  await thermostat.setFanActive(0);

  assert.deepEqual(state.fans, ['on', 'auto']);
});

test('setFanActive swallows StateProviderNotImplementedError', async () => {
  const provider: ThermostatStateProvider = {
    ...staticProvider(),
    setFanMode: async () => {
      throw new StateProviderNotImplementedError('not supported');
    },
  };
  const { thermostat } = makeAccessory(provider);
  await assert.doesNotReject(() => thermostat.setFanActive(1));
});

test('a commanded fan mode is held until the device confirms it', async () => {
  const { provider, state } = mutableProvider({ fanMode: 'auto' });
  const { accessory, thermostat } = makeAccessory(provider);

  await thermostat.startPolling();
  await thermostat.setFanActive(1);
  const active = accessory.getService('Fanv2')!.getCharacteristic('Active');
  const pushCountAtSet = active.updatedValues.length;

  await thermostat.startPolling(); // device still reports auto
  assert.equal(await thermostat.getFanActive(), 1, 'the commanded value must win');
  assert.deepEqual(active.updatedValues.slice(pushCountAtSet), [], 'the stale device value must not snap the fan back');

  state.snapshot = snapshot({ fanMode: 'on' });
  await thermostat.startPolling();
  assert.equal(await thermostat.getFanActive(), 1);

  // A later change made at the thermostat itself must now come through.
  state.snapshot = snapshot({ fanMode: 'auto' });
  await thermostat.startPolling();
  assert.equal(await thermostat.getFanActive(), 0, 'a manual fan change at the wall must not be suppressed');
});

test('the fan reports No Response alongside the thermostat', async () => {
  const { provider, state } = mutableProvider({ fanMode: 'on' });
  const { thermostat } = makeAccessory(provider);

  await thermostat.startPolling();
  state.failures = 3;
  await thermostat.startPolling();
  await thermostat.startPolling();
  await thermostat.startPolling();

  await assert.rejects(() => thermostat.getFanActive());
});

test('a command the device never applied is corrected in HomeKit once the window lapses', async () => {
  const { provider } = mutableProvider({ targetTemperatureCelsius: 21 });
  const { accessory, thermostat } = makeAccessory(provider);

  await thermostat.startPolling(); // pushes 21
  await thermostat.setTargetTemperature(24); // HomeKit now shows 24

  const pushed = accessory.getService('Thermostat')!.getCharacteristic('TargetTemperature').updatedValues;
  const pushCountAtSet = pushed.length;

  // The device ignored the command and still reports 21 after the window.
  const realNow = Date.now;
  Date.now = () => realNow() + 130_000;
  try {
    await thermostat.startPolling();
  } finally {
    Date.now = realNow;
  }

  assert.deepEqual(
    pushed.slice(pushCountAtSet),
    [21],
    'HomeKit holds the commanded 24, so the device value must be re-pushed even though 21 was pushed before',
  );
});

test('a fan command the device never applied is corrected in HomeKit once the window lapses', async () => {
  const { provider } = mutableProvider({ fanMode: 'auto' });
  const { accessory, thermostat } = makeAccessory(provider);

  await thermostat.startPolling(); // pushes Active=0
  await thermostat.setFanActive(1);

  const pushed = accessory.getService('Fanv2')!.getCharacteristic('Active').updatedValues;
  const pushCountAtSet = pushed.length;

  const realNow = Date.now;
  Date.now = () => realNow() + 130_000;
  try {
    await thermostat.startPolling();
  } finally {
    Date.now = realNow;
  }

  assert.deepEqual(pushed.slice(pushCountAtSet), [0]);
});

test('a setpoint the device stores in whole degrees F still counts as confirmed', async () => {
  const { provider, state } = mutableProvider({ targetTemperatureCelsius: 21 });
  const { thermostat } = makeAccessory(provider);

  await thermostat.startPolling();
  await thermostat.setTargetTemperature(24); // 75.2 F on the wire

  // The device keeps whole degrees: 75 F reads back as 23.89 C.
  state.snapshot = snapshot({ targetTemperatureCelsius: 23.89 });
  await thermostat.startPolling();

  // That confirmed the command, so a wall change right after must come through.
  state.snapshot = snapshot({ targetTemperatureCelsius: 19 });
  await thermostat.startPolling();
  assert.equal(await thermostat.getTargetTemperature(), 19, 'the hold must release once the rounded value is reported');
});
