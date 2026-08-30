import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Pro1ThermostatAccessory } from '../src/platformAccessory.js';
import type { Pro1ThermostatPlatform } from '../src/platform.js';
import type { PlatformAccessory } from 'homebridge';
import {
  StateProviderNotImplementedError,
  StateProviderUnavailableError,
  ThermostatStateProvider,
  ThermostatStateSnapshot,
} from '../src/state/index.js';

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

const DEVICE = { name: 'Living Room', host: '192.0.2.1', pollingInterval: 60 };

function makePlatform(): Pro1ThermostatPlatform {
  const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
  const Service = { AccessoryInformation: 'AccessoryInformation', Thermostat: 'Thermostat' };
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
  };
  const { thermostat } = makeAccessory(provider);
  await thermostat.startPolling();
  assert.equal(await thermostat.getCurrentTemperature(), 22);
  await thermostat.startPolling();
  assert.equal(await thermostat.getCurrentTemperature(), 22);
});
