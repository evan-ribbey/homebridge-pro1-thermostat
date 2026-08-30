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
    state: { reported: { at: 72, hs: 68, cs: 74, sys: 1, hum: 45 } },
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

test('setTargetTemperature publishes a dual setpoint shadow/update', async () => {
  installGoodFetchMock();
  const clients: FakeMqttClient[] = [];
  const factory = makeFactory(clients, { state: {} });
  const provider = new CloudStateProvider('192.0.2.1', 80, undefined, factory);

  await provider.setTargetTemperature(22);

  assert.equal(clients.length, 1);
  const client = clients[0];
  assert.equal(client.published.length, 1);
  assert.ok(client.published[0].topic.endsWith('/shadow/update'));
  const parsed = JSON.parse(client.published[0].payload) as {
    state: { desired: { hs: number; cs: number } };
  };
  assert.equal(parsed.state.desired.hs, 71.6);
  assert.equal(parsed.state.desired.cs, 71.6);
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
    assert.equal(parsed.state.desired.sys, mode);
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
