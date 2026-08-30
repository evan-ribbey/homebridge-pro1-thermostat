import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import type { API, Logging } from 'homebridge';

import { Pro1ThermostatPlatform } from '../src/platform.js';

const realFetch = globalThis.fetch;

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

function makeLog(): Logging {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as unknown as Logging;
}

interface ApiMock {
  api: API;
  fireDidFinishLaunching: () => void;
  registered: Array<{ plugin: string; platform: string; accessories: FakeAccessory[] }>;
}

function makeApiMock(): ApiMock {
  const didFinishLaunchingCallbacks: Array<() => void> = [];
  const registered: ApiMock['registered'] = [];

  const api = {
    hap: {
      Service: { AccessoryInformation: 'AccessoryInformation', Thermostat: 'Thermostat' },
      Characteristic: {
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
      },
      uuid: { generate: (value: string) => `uuid-${value}` },
    },
    platformAccessory: function (name: string, uuid: string) {
      return new FakeAccessory(name, uuid);
    },
    on: (event: string, callback: () => void) => {
      if (event === 'didFinishLaunching') {
        didFinishLaunchingCallbacks.push(callback);
      }
    },
    registerPlatformAccessories: (plugin: string, platform: string, accessories: FakeAccessory[]) => {
      registered.push({ plugin, platform, accessories });
    },
    updatePlatformAccessories: () => {},
    unregisterPlatformAccessories: () => {},
  } as unknown as API;

  return {
    api,
    fireDidFinishLaunching: () => didFinishLaunchingCallbacks.forEach((callback) => callback()),
    registered,
  };
}

function makeConfig(thermostats: Array<{ name: string; host: string }>) {
  return { platform: 'Pro1Thermostat', name: 'Pro1', thermostats };
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

test('registers an accessory for each valid thermostat entry', () => {
  globalThis.fetch = (async () => {
    throw new Error('network unreachable');
  }) as typeof fetch;

  const { api, fireDidFinishLaunching, registered } = makeApiMock();
  new Pro1ThermostatPlatform(makeLog(), makeConfig([
    { name: 'Living Room', host: '192.0.2.1' },
    { name: 'Bedroom', host: '192.0.2.2' },
  ]), api);

  fireDidFinishLaunching();

  assert.equal(registered.length, 2);
  assert.equal(registered[0].accessories[0].displayName, 'Living Room');
  assert.equal(registered[1].accessories[0].displayName, 'Bedroom');
});

test('skips entries with a missing or empty name/host', () => {
  globalThis.fetch = (async () => {
    throw new Error('network unreachable');
  }) as typeof fetch;

  const { api, fireDidFinishLaunching, registered } = makeApiMock();
  new Pro1ThermostatPlatform(makeLog(), makeConfig([
    { name: '', host: '192.0.2.1' },
    { name: 'Bedroom', host: '' },
    { name: 'Kitchen', host: '192.0.2.3' },
  ]), api);

  fireDidFinishLaunching();

  assert.equal(registered.length, 1);
  assert.equal(registered[0].accessories[0].displayName, 'Kitchen');
});
