import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CloudStateProvider,
  MqttClient,
  MqttClientFactory,
  StateProviderUnavailableError,
} from '../src/state/index.js';

const realFetch = globalThis.fetch;

/**
 * Minimal in-memory MQTT client implementing the structural MqttClient
 * surface used by CloudStateProvider. Handlers are stored per event;
 * publish() records the topic/payload and, when `acceptedPayload` is set,
 * replays it on the `${topic}/accepted` topic via setImmediate.
 */
class FakeMqttClient implements MqttClient {
  private readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();

  public readonly published: Array<{ topic: string; payload: string }> = [];

  public ended = false;

  /** When non-null, publish() emits this payload on the accepted topic. */
  public acceptedPayload: unknown = null;

  // The structural MqttClient interface overloads `on` with three
  // heterogeneous callback shapes (connect/message/error) that have no
  // single safe supertype under TS's rest-param covariance rules, so the
  // internal dispatcher is untyped.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public on(event: string, cb: (...args: any[]) => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(cb);
    this.handlers.set(event, list);
    return this;
  }

  public subscribe(topic: string, cb?: (err?: Error) => void): this {
    void topic;
    cb?.();
    return this;
  }

  public publish(topic: string, payload: string | Buffer, cb?: (err?: Error) => void): this {
    this.published.push({ topic, payload: String(payload) });
    if (this.acceptedPayload !== null) {
      const acceptedTopic = `${topic}/accepted`;
      const body = Buffer.from(JSON.stringify(this.acceptedPayload));
      setImmediate(() => {
        this.emit('message', acceptedTopic, body);
      });
    }
    cb?.();
    return this;
  }

  public end(force?: boolean, cb?: () => void): this {
    void force;
    this.ended = true;
    cb?.();
    return this;
  }

  public emit(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(...args);
    }
  }

  /** Schedule the 'connect' event on the next turn, like mqtt.connect does. */
  public connectSoon(): void {
    setImmediate(() => {
      this.emit('connect');
    });
  }
}

type MockEntry = { status: number; body: string };

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Install a fetch mock keyed by URL pathname; returns the recorded call URLs. */
function installFetchMock(responses: Record<string, MockEntry>): { calls: string[] } {
  const calls: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    calls.push(url);
    const entry = responses[new URL(url).pathname];
    if (entry === undefined) {
      return new Response('Not Found', { status: 404 });
    }
    return new Response(entry.body, { status: entry.status });
  }) as typeof fetch;
  return { calls };
}

/** Install a fetch mock that serves all four /aws_iot/* provisioning endpoints. */
function installGoodFetchMock(): { calls: string[] } {
  return installFetchMock({
    '/aws_iot/thing': { status: 200, body: JSON.stringify({ thing: 't-123' }) },
    '/aws_iot/region': { status: 200, body: JSON.stringify({ region: 'us-west-2' }) },
    '/aws_iot/pubCert': {
      status: 200,
      body: JSON.stringify({ cert: '-----BEGIN CERTIFICATE-----\nFAKE' }),
    },
    '/aws_iot/privKey': {
      status: 200,
      body: JSON.stringify({ key: '-----BEGIN RSA PRIVATE KEY-----\nFAKE' }),
    },
  });
}

/**
 * Build a factory that returns a fresh connected FakeMqttClient per call,
 * each replying with `acceptedPayload` on the accepted topic.
 */
function makeFactory(clients: FakeMqttClient[], acceptedPayload: unknown): MqttClientFactory {
  return () => {
    const client = new FakeMqttClient();
    client.acceptedPayload = acceptedPayload;
    client.connectSoon();
    clients.push(client);
    return client;
  };
}

test('readState provisions once and reuses the cache on subsequent reads', async () => {
  const fetchMock = installGoodFetchMock();
  const clients: FakeMqttClient[] = [];
  const factory = makeFactory(clients, {
    state: { at: 70, hs: 70, cs: 70, sys: 1, hum: 40 },
  });
  const provider = new CloudStateProvider('192.0.2.1', 80, undefined, factory);

  await provider.readState();

  assert.equal(fetchMock.calls.length, 4);
  assert.ok(fetchMock.calls.some((url) => url.endsWith('/aws_iot/thing')));
  assert.ok(fetchMock.calls.some((url) => url.endsWith('/aws_iot/region')));
  assert.ok(fetchMock.calls.some((url) => url.endsWith('/aws_iot/pubCert')));
  assert.ok(fetchMock.calls.some((url) => url.endsWith('/aws_iot/privKey')));

  await provider.readState();

  assert.equal(fetchMock.calls.length, 4, 'second read must use the provisioning cache');
});

test('readState parses the shadow state into a snapshot', async () => {
  installGoodFetchMock();
  const clients: FakeMqttClient[] = [];
  const factory = makeFactory(clients, {
    state: { reported: { at: 72, hs: 68, cs: 74, sys: 2, hum: 45 } },
  });
  const provider = new CloudStateProvider('192.0.2.1', 80, undefined, factory);

  const snapshot = await provider.readState();

  assert.ok(Math.abs((snapshot.currentTemperatureCelsius ?? 0) - 22.22) < 0.01);
  assert.ok(Math.abs((snapshot.targetTemperatureCelsius ?? 0) - 20) < 0.01);
  assert.equal(snapshot.currentHeatingCoolingState, 1);
  assert.equal(snapshot.targetHeatingCoolingState, 1);
  assert.equal(snapshot.currentRelativeHumidityPercent, 45);
  assert.equal(snapshot.isOnline, true);
  assert.ok(snapshot.readTimestampMs > 0);
});

test('readState in cool mode maps the cool setpoint as the target', async () => {
  installGoodFetchMock();
  const clients: FakeMqttClient[] = [];
  const factory = makeFactory(clients, {
    state: { reported: { at: 80, hs: 65, cs: 75, sys: 1, hum: 40 } },
  });
  const provider = new CloudStateProvider('192.0.2.1', 80, undefined, factory);

  const snapshot = await provider.readState();

  assert.ok(Math.abs((snapshot.currentTemperatureCelsius ?? 0) - 26.67) < 0.01); // 80°F
  assert.ok(Math.abs((snapshot.targetTemperatureCelsius ?? 0) - 23.89) < 0.01); // 75°F = cs, not hs
  assert.equal(snapshot.targetHeatingCoolingState, 2); // COOL
  assert.equal(snapshot.currentHeatingCoolingState, 2);
  assert.equal(snapshot.currentRelativeHumidityPercent, 40);
});

test('setTargetTemperature in heat mode writes only the heat setpoint', async () => {
  installGoodFetchMock();
  const clients: FakeMqttClient[] = [];
  // shadow/get returns sys=2 (HEAT on this firmware)
  const factory = makeFactory(clients, { state: { reported: { sys: 2 } } });
  const provider = new CloudStateProvider('192.0.2.1', 80, undefined, factory);

  await provider.setTargetTemperature(22);

  assert.equal(clients.length, 2); // shadow/get then shadow/update
  const update = clients[1];
  assert.equal(update.published.length, 1);
  assert.ok(update.published[0].topic.endsWith('/shadow/update'));
  const parsed = JSON.parse(update.published[0].payload) as {
    state: { desired: { hs?: number; cs?: number } };
  };
  assert.equal(parsed.state.desired.hs, 72);
  assert.equal(parsed.state.desired.cs, undefined);
});

test('setTargetTemperature in cool mode writes only the cool setpoint', async () => {
  installGoodFetchMock();
  const clients: FakeMqttClient[] = [];
  // shadow/get returns sys=1 (COOL on this firmware)
  const factory = makeFactory(clients, { state: { reported: { sys: 1 } } });
  const provider = new CloudStateProvider('192.0.2.1', 80, undefined, factory);

  await provider.setTargetTemperature(22);

  assert.equal(clients.length, 2);
  const update = clients[1];
  assert.equal(update.published.length, 1);
  assert.ok(update.published[0].topic.endsWith('/shadow/update'));
  const parsed = JSON.parse(update.published[0].payload) as {
    state: { desired: { hs?: number; cs?: number } };
  };
  assert.equal(parsed.state.desired.cs, 72);
  assert.equal(parsed.state.desired.hs, undefined);
});

test('setTargetHeatingCoolingState maps HomeKit modes 0-3 to desired.sys', async () => {
  installGoodFetchMock();
  const clients: FakeMqttClient[] = [];
  const factory = makeFactory(clients, { state: {} });
  const provider = new CloudStateProvider('192.0.2.1', 80, undefined, factory);

  for (const mode of [0, 1, 2, 3] as const) {
    await provider.setTargetHeatingCoolingState(mode);

    const client = clients[clients.length - 1];
    assert.equal(client.published.length, 1);
    assert.ok(client.published[0].topic.endsWith('/shadow/update'));
    const parsed = JSON.parse(client.published[0].payload) as {
      state: { desired: { sys: number } };
    };
    // HomeKit mode -> device sys: heat(1)->2, cool(2)->1 (verified live)
    const expectedSys = [0, 2, 1, 3][mode];
    assert.equal(parsed.state.desired.sys, expectedSys);
  }
});

test('readState rejects with StateProviderUnavailableError on MQTT connect error', async () => {
  installGoodFetchMock();
  const factory: MqttClientFactory = () => {
    const client = new FakeMqttClient();
    setImmediate(() => {
      client.emit('error', new Error('boom'));
    });
    return client;
  };
  const provider = new CloudStateProvider('192.0.2.1', 80, undefined, factory);

  await assert.rejects(() => provider.readState(), StateProviderUnavailableError);
});

test('readState rejects with StateProviderUnavailableError when accepted message times out', async () => {
  installGoodFetchMock();
  const clients: FakeMqttClient[] = [];
  // acceptedPayload stays null: the client connects, subscribes, and
  // publishes, but never emits the accepted response.
  const factory = makeFactory(clients, null);
  const provider = new CloudStateProvider('192.0.2.1', 80, undefined, factory);

  await assert.rejects(() => provider.readState(), StateProviderUnavailableError);
});

test('readState rejects with StateProviderUnavailableError when provisioning fetch fails', async () => {
  installFetchMock({
    '/aws_iot/thing': { status: 404, body: 'Not Found' },
  });
  let factoryCalls = 0;
  const factory: MqttClientFactory = () => {
    factoryCalls += 1;
    return new FakeMqttClient();
  };
  const provider = new CloudStateProvider('192.0.2.1', 80, undefined, factory);

  await assert.rejects(() => provider.readState(), StateProviderUnavailableError);
  assert.equal(factoryCalls, 0, 'no MQTT client should be created when provisioning fails');
});

test('readState clears a desired entry the device has already satisfied', async () => {
  installGoodFetchMock();
  const clients: FakeMqttClient[] = [];
  // desired.hs matches reported.hs: the command landed, so the standing
  // desired now serves only to revert a later manual change at the wall.
  const factory = makeFactory(clients, {
    state: { reported: { at: 70, hs: 68, cs: 74, sys: 2 }, desired: { hs: 68 } },
  });
  const provider = new CloudStateProvider('192.0.2.1', 80, undefined, factory);

  const snapshot = await provider.readState();

  assert.equal(clients.length, 2, 'shadow/get then a shadow/update clearing the desired');
  const update = clients[1];
  assert.ok(update.published[0].topic.endsWith('/shadow/update'));
  const parsed = JSON.parse(update.published[0].payload) as {
    state: { desired: Record<string, unknown> };
  };
  assert.deepEqual(parsed.state.desired, { hs: null });
  // The read still returns the reported state.
  assert.ok(Math.abs((snapshot.targetTemperatureCelsius ?? 0) - 20) < 0.01);
});

test('readState leaves an in-flight desired entry alone', async () => {
  installGoodFetchMock();
  const clients: FakeMqttClient[] = [];
  // desired.hs differs from reported.hs: the command has not been applied yet
  // and clearing it would cancel the user's pending change.
  const factory = makeFactory(clients, {
    state: { reported: { at: 70, hs: 68, sys: 2 }, desired: { hs: 72 } },
  });
  const provider = new CloudStateProvider('192.0.2.1', 80, undefined, factory);

  await provider.readState();

  assert.equal(clients.length, 1, 'no housekeeping update should be sent');
});

test('readState issues no housekeeping update when the shadow has no desired', async () => {
  installGoodFetchMock();
  const clients: FakeMqttClient[] = [];
  const factory = makeFactory(clients, { state: { reported: { at: 70, hs: 68, sys: 2 } } });
  const provider = new CloudStateProvider('192.0.2.1', 80, undefined, factory);

  await provider.readState();

  assert.equal(clients.length, 1, 'steady state must add no MQTT traffic');
});

test('a failed desired-clear does not fail the read', async () => {
  installGoodFetchMock();
  let call = 0;
  const factory: MqttClientFactory = () => {
    call += 1;
    const client = new FakeMqttClient();
    if (call === 1) {
      client.acceptedPayload = { state: { reported: { at: 70, hs: 68, sys: 2 }, desired: { hs: 68 } } };
      client.connectSoon();
    } else {
      // The clearing update errors out.
      setImmediate(() => client.emit('error', new Error('boom')));
    }
    return client;
  };
  const provider = new CloudStateProvider('192.0.2.1', 80, undefined, factory);

  const snapshot = await provider.readState();

  assert.equal(snapshot.isOnline, true);
  assert.ok(Math.abs((snapshot.currentTemperatureCelsius ?? 0) - 21.11) < 0.01);
});

test('readState reports Off as the current state when sys=0', async () => {
  installGoodFetchMock();
  const clients: FakeMqttClient[] = [];
  const factory = makeFactory(clients, { state: { reported: { at: 70, hs: 68, cs: 74, sys: 0 } } });
  const provider = new CloudStateProvider('192.0.2.1', 80, undefined, factory);

  const snapshot = await provider.readState();

  assert.equal(snapshot.currentHeatingCoolingState, 0);
  assert.equal(snapshot.targetHeatingCoolingState, 0);
});

test('a setpoint write reuses the mode from a recent poll instead of re-reading', async () => {
  installGoodFetchMock();
  const clients: FakeMqttClient[] = [];
  const factory = makeFactory(clients, { state: { reported: { at: 70, hs: 68, cs: 74, sys: 1 } } });
  const provider = new CloudStateProvider('192.0.2.1', 80, undefined, factory);

  await provider.readState();
  assert.equal(clients.length, 1);

  await provider.setTargetTemperature(22);

  // Only the update connects: every MQTT exchange briefly displaces the
  // thermostat's own cloud link, so the extra read is worth avoiding.
  assert.equal(clients.length, 2, 'the setpoint write must not re-read the shadow');
  const update = clients[1];
  assert.ok(update.published[0].topic.endsWith('/shadow/update'));
  const parsed = JSON.parse(update.published[0].payload) as { state: { desired: { cs?: number; hs?: number } } };
  assert.equal(parsed.state.desired.cs, 72, 'sys=1 is COOL, so the cool setpoint is written');
  assert.equal(parsed.state.desired.hs, undefined);
});

test('a setpoint write re-reads the mode when the cache has gone stale', async () => {
  installGoodFetchMock();
  const clients: FakeMqttClient[] = [];
  const factory = makeFactory(clients, { state: { reported: { at: 70, hs: 68, cs: 74, sys: 1 } } });
  const provider = new CloudStateProvider('192.0.2.1', 80, undefined, factory);

  await provider.readState();

  const realNow = Date.now;
  Date.now = () => realNow() + 60_000; // beyond the mode cache TTL
  try {
    await provider.setTargetTemperature(22);
  } finally {
    Date.now = realNow;
  }

  assert.equal(clients.length, 3, 'stale cache must fall back to a fresh shadow/get');
});

test('commanding a mode primes the cache for a following setpoint write', async () => {
  installGoodFetchMock();
  const clients: FakeMqttClient[] = [];
  const factory = makeFactory(clients, { state: {} });
  const provider = new CloudStateProvider('192.0.2.1', 80, undefined, factory);

  await provider.setTargetHeatingCoolingState(1); // HomeKit HEAT
  await provider.setTargetTemperature(22);

  assert.equal(clients.length, 2, 'no shadow/get needed: the mode was just commanded');
  const parsed = JSON.parse(clients[1].published[0].payload) as { state: { desired: { hs?: number; cs?: number } } };
  assert.equal(parsed.state.desired.hs, 72, 'heat mode writes the heat setpoint');
  assert.equal(parsed.state.desired.cs, undefined);
});

test('readState maps the shadow fan field to a fan mode', async () => {
  installGoodFetchMock();
  const clients: FakeMqttClient[] = [];
  const factory = makeFactory(clients, {
    state: { reported: { at: 72, hs: 68, cs: 74, sys: 2, fan: 1 } },
  });
  const provider = new CloudStateProvider('192.0.2.1', 80, undefined, factory);

  const snapshot = await provider.readState();

  assert.equal(snapshot.fanMode, 'auto', 'fan=1 is AUTO (verified live)');
});

test('readState reports an unknown fan mode when the shadow has no fan field', async () => {
  installGoodFetchMock();
  const clients: FakeMqttClient[] = [];
  const factory = makeFactory(clients, { state: { reported: { at: 72, hs: 68, cs: 74, sys: 2 } } });
  const provider = new CloudStateProvider('192.0.2.1', 80, undefined, factory);

  const snapshot = await provider.readState();

  assert.equal(snapshot.fanMode, null);
});

test('setFanMode writes the device fan field for on and auto', async () => {
  installGoodFetchMock();
  const clients: FakeMqttClient[] = [];
  const factory = makeFactory(clients, { state: {} });
  const provider = new CloudStateProvider('192.0.2.1', 80, undefined, factory);

  await provider.setFanMode('on');
  await provider.setFanMode('auto');

  assert.equal(clients.length, 2, 'one shadow/update per command, no read first');
  const payloads = clients.map((client) => {
    assert.ok(client.published[0].topic.endsWith('/shadow/update'));
    return (JSON.parse(client.published[0].payload) as { state: { desired: { fan: number } } }).state.desired;
  });
  // Fan mode -> device fan: on->0, auto->1 (verified live; inverted polarity)
  assert.equal(payloads[0].fan, 0);
  assert.equal(payloads[1].fan, 1);
});

test('readState clears a satisfied desired fan entry like any other commanded key', async () => {
  installGoodFetchMock();
  const clients: FakeMqttClient[] = [];
  const factory = makeFactory(clients, {
    state: { reported: { at: 70, hs: 68, cs: 74, sys: 2, fan: 1 }, desired: { fan: 1 } },
  });
  const provider = new CloudStateProvider('192.0.2.1', 80, undefined, factory);

  await provider.readState();

  assert.equal(clients.length, 2, 'a standing desired.fan would undo a fan change made at the wall');
  const parsed = JSON.parse(clients[1].published[0].payload) as { state: { desired: Record<string, unknown> } };
  assert.deepEqual(parsed.state.desired, { fan: null });
});

test('a failed MQTT exchange discards cached provisioning so new credentials are picked up', async () => {
  const fetchMock = installGoodFetchMock();
  let failNext = true;
  const clients: FakeMqttClient[] = [];
  const goodFactory = makeFactory(clients, { state: { at: 70, hs: 70, sys: 2 } });
  const factory: MqttClientFactory = (options) => {
    if (failNext) {
      failNext = false;
      const client = new FakeMqttClient();
      setImmediate(() => {
        client.emit('error', new Error('certificate rejected'));
      });
      return client;
    }
    return goodFactory(options);
  };
  const provider = new CloudStateProvider('192.0.2.1', 80, undefined, factory);

  await assert.rejects(() => provider.readState(), StateProviderUnavailableError);
  const fetchesAfterFailure = fetchMock.calls.length;
  assert.equal(fetchesAfterFailure, 4);

  await provider.readState();
  assert.equal(fetchMock.calls.length, 8, 'provisioning must be re-fetched from the device after a failed exchange');

  await provider.readState();
  assert.equal(fetchMock.calls.length, 8, 'a healthy exchange keeps using the cache');
});
