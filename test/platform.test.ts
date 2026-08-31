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

interface DeviceEntry {
  name: string;
  host?: string;
  provider?: 'cloud' | 'local' | 'app';
  email?: string;
  password?: string;
  thingId?: string;
  pollingInterval?: number;
}

function makeDeviceConfig(thermostats: DeviceEntry[]) {
  return { platform: 'Pro1Thermostat', name: 'Pro1', thermostats };
}

/** Capture log lines by level so validation behaviour can be asserted. */
function makeCapturingLog(): { log: Logging; lines: string[] } {
  const lines: string[] = [];
  const record = (level: string) => (msg: unknown, ...rest: unknown[]) =>
    lines.push(`${level}: ${[msg, ...rest].join(' ')}`);
  const log = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
  } as unknown as Logging;
  return { log, lines };
}

test('registers an app-cloud thermostat that has no host', () => {
  // The app-cloud provider reaches the thermostat through the PRO1 account,
  // so requiring a LAN host made the documented app config unusable.
  const { api, fireDidFinishLaunching, registered } = makeApiMock();
  const { log } = makeCapturingLog();
  new Pro1ThermostatPlatform(log, makeDeviceConfig([
    { name: 'Living Room', provider: 'app', email: 'user@example.com', password: 'secret' },
  ]), api);

  fireDidFinishLaunching();

  assert.equal(registered.length, 1);
  assert.equal(registered[0].accessories[0].displayName, 'Living Room');
});

test('skips an app-cloud entry missing credentials instead of aborting the platform', () => {
  const { api, fireDidFinishLaunching, registered } = makeApiMock();
  const { log, lines } = makeCapturingLog();
  new Pro1ThermostatPlatform(log, makeDeviceConfig([
    { name: 'Bad', provider: 'app', email: 'user@example.com' },
    { name: 'Good', host: '192.0.2.9' },
  ]), api);

  // A throw here would run inside the didFinishLaunching handler and take
  // every following thermostat down with it.
  assert.doesNotThrow(() => fireDidFinishLaunching());

  assert.equal(registered.length, 1, 'the valid entry after the bad one must still register');
  assert.equal(registered[0].accessories[0].displayName, 'Good');
  assert.ok(lines.some((line) => line.startsWith('error:') && line.includes('Bad')));
});

test('never logs the configured password', () => {
  const { api, fireDidFinishLaunching } = makeApiMock();
  const { log, lines } = makeCapturingLog();
  new Pro1ThermostatPlatform(log, makeDeviceConfig([
    { name: 'Cloudy', provider: 'cloud', password: 'hunter2-secret' },
  ]), api);

  fireDidFinishLaunching();

  assert.ok(lines.length > 0);
  assert.ok(!lines.join('\n').includes('hunter2-secret'), 'password must be redacted from validation logs');
});

test('skips a duplicate entry rather than registering a colliding accessory id', () => {
  const { api, fireDidFinishLaunching, registered } = makeApiMock();
  const { log, lines } = makeCapturingLog();
  new Pro1ThermostatPlatform(log, makeDeviceConfig([
    { name: 'First', host: '192.0.2.1' },
    { name: 'Second', host: '192.0.2.1' },
  ]), api);

  fireDidFinishLaunching();

  assert.equal(registered.length, 1, 'a duplicate host would otherwise raise a duplicate-UUID error');
  assert.ok(lines.some((line) => line.startsWith('error:') && line.includes('Duplicate')));
});

test('clamps a polling interval below the provider minimum', () => {
  const { api, fireDidFinishLaunching, registered } = makeApiMock();
  const { log, lines } = makeCapturingLog();
  new Pro1ThermostatPlatform(log, makeDeviceConfig([
    { name: 'Fast', host: '192.0.2.1', provider: 'cloud', pollingInterval: 1 },
  ]), api);

  fireDidFinishLaunching();

  const stored = registered[0].accessories[0].context.device as { pollingInterval: number };
  assert.ok(stored.pollingInterval >= 60, `cloud polling must be floored, got ${stored.pollingInterval}s`);
  assert.ok(lines.some((line) => line.startsWith('warn:') && line.includes('minimum')));
});

test('defaults the cloud provider to a gentler polling interval than local', () => {
  const { api, fireDidFinishLaunching, registered } = makeApiMock();
  const { log } = makeCapturingLog();
  new Pro1ThermostatPlatform(log, makeDeviceConfig([
    { name: 'Cloudy', host: '192.0.2.1', provider: 'cloud' },
    { name: 'Localy', host: '192.0.2.2', provider: 'local' },
  ]), api);

  fireDidFinishLaunching();

  const cloud = registered[0].accessories[0].context.device as { pollingInterval: number };
  const local = registered[1].accessories[0].context.device as { pollingInterval: number };
  // Each cloud poll briefly displaces the thermostat's own AWS IoT connection.
  assert.ok(cloud.pollingInterval > local.pollingInterval);
});

test('rejects a non-numeric polling interval and falls back to the default', () => {
  const { api, fireDidFinishLaunching, registered } = makeApiMock();
  const { log, lines } = makeCapturingLog();
  new Pro1ThermostatPlatform(log, makeDeviceConfig([
    { name: 'Odd', host: '192.0.2.1', pollingInterval: 'soon' as unknown as number },
  ]), api);

  fireDidFinishLaunching();

  const stored = registered[0].accessories[0].context.device as { pollingInterval: number };
  assert.equal(stored.pollingInterval, 60);
  assert.ok(lines.some((line) => line.startsWith('warn:') && line.includes('pollingInterval')));
});
