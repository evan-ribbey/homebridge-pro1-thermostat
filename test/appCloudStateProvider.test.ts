import { createRequire } from 'node:module';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';

import type { Logging } from 'homebridge';

// Type-only imports — erased at compile time, so they never load the real
// amazon-cognito-identity-js at runtime (the provider module itself is
// imported dynamically below, after the Cognito mock is installed). Aliased
// because the runtime values are destructured from the dynamic import.
import type {
  AppCloudProviderConfig as AppCloudProviderConfigType,
  AppCloudStateProvider as AppCloudStateProviderType,
} from '../src/state/index.js';

const realFetch = globalThis.fetch;

// ---------------------------------------------------------------------------
// Cognito module mocking
//
// AppCloudStateProvider imports { AuthenticationDetails, CognitoUser,
// CognitoUserPool } from the CommonJS package 'amazon-cognito-identity-js'.
// Node's ESM→CJS interop exposes those named exports as *live* bindings over
// module.exports, so swapping the exports via require() before (dynamically)
// importing the provider stubs out SRP auth entirely: no real network calls,
// and we can count authenticateUser / refreshSession invocations.
// ---------------------------------------------------------------------------

interface CognitoCallbacks {
  onSuccess: (session: FakeCognitoUserSession) => void;
  onFailure: (error: Error) => void;
}

const cognitoMock = {
  authenticateUserCalls: 0,
  refreshSessionCalls: 0,
  /** Session exp (epoch seconds) minted for login-created sessions. */
  loginSessionExpSeconds: 0,
  /** Session exp (epoch seconds) minted for refresh-created sessions. */
  refreshSessionExpSeconds: 0,
  /** id token `sub` claim used for device discovery. */
  idTokenSub: 'user-sub-123',
  /** When true, authenticateUser invokes onFailure with loginError. */
  loginShouldFail: false,
  /** Error message the fake Cognito surfaces on login failure. */
  loginError: 'NotAuthorizedException: Incorrect username or password.',
  /** When true, refreshSession invokes the error callback. */
  refreshShouldFail: false,
};

function futureExpSeconds(): number {
  return Math.floor(Date.now() / 1000) + 3600;
}

function resetCognitoMock(): void {
  cognitoMock.authenticateUserCalls = 0;
  cognitoMock.refreshSessionCalls = 0;
  cognitoMock.loginSessionExpSeconds = futureExpSeconds();
  cognitoMock.refreshSessionExpSeconds = futureExpSeconds();
  cognitoMock.idTokenSub = 'user-sub-123';
  cognitoMock.loginShouldFail = false;
  cognitoMock.loginError = 'NotAuthorizedException: Incorrect username or password.';
  cognitoMock.refreshShouldFail = false;
}

class FakeAccessToken {
  public constructor(private readonly payload: { exp: number }) {}

  public getJwtToken(): string {
    return 'fake-access-token';
  }

  public decodePayload(): { exp: number } {
    return this.payload;
  }
}

class FakeIdToken {
  public constructor(private readonly payload: { sub: string }) {}

  public decodePayload(): { sub: string } {
    return this.payload;
  }
}

class FakeRefreshToken {
  public getToken(): string {
    return 'fake-refresh-token';
  }
}

/** Minimal CognitoUserSession: access/id/refresh tokens with canned payloads. */
class FakeCognitoUserSession {
  public constructor(
    private readonly expSeconds: number,
    private readonly sub: string,
  ) {}

  public getAccessToken(): FakeAccessToken {
    return new FakeAccessToken({ exp: this.expSeconds });
  }

  public getIdToken(): FakeIdToken {
    return new FakeIdToken({ sub: this.sub });
  }

  public getRefreshToken(): FakeRefreshToken {
    return new FakeRefreshToken();
  }
}

/** Fake CognitoUser: counts calls and drives the callback API synchronously. */
class FakeCognitoUser {
  public constructor(private readonly config: { Username: string; Pool: unknown }) {
    void this.config;
  }

  public authenticateUser(_details: unknown, callbacks: CognitoCallbacks): void {
    cognitoMock.authenticateUserCalls += 1;
    if (cognitoMock.loginShouldFail) {
      callbacks.onFailure(new Error(cognitoMock.loginError));
      return;
    }
    callbacks.onSuccess(new FakeCognitoUserSession(cognitoMock.loginSessionExpSeconds, cognitoMock.idTokenSub));
  }

  public refreshSession(
    _token: unknown,
    callback: (error: Error | null, session?: FakeCognitoUserSession) => void,
  ): void {
    cognitoMock.refreshSessionCalls += 1;
    if (cognitoMock.refreshShouldFail) {
      callback(new Error('Token has expired and cannot be refreshed'));
      return;
    }
    callback(null, new FakeCognitoUserSession(cognitoMock.refreshSessionExpSeconds, cognitoMock.idTokenSub));
  }
}

const require = createRequire(import.meta.url);
const realCognito = require('amazon-cognito-identity-js') as {
  AuthenticationDetails: unknown;
  CognitoUser: unknown;
  CognitoUserPool: unknown;
};

const originalCognito = {
  AuthenticationDetails: realCognito.AuthenticationDetails,
  CognitoUser: realCognito.CognitoUser,
  CognitoUserPool: realCognito.CognitoUserPool,
};

/** Replace the Cognito exports with fakes before the provider module loads. */
function installCognitoMock(): void {
  realCognito.AuthenticationDetails = class FakeAuthenticationDetails {
    public constructor(private readonly details: { Username: string; Password: string }) {
      void this.details;
    }
  };
  realCognito.CognitoUser = FakeCognitoUser;
  realCognito.CognitoUserPool = class FakeCognitoUserPool {
    public constructor(private readonly poolData: { UserPoolId: string; ClientId: string }) {
      void this.poolData;
    }
  };
}

installCognitoMock();
resetCognitoMock();

// Import the provider only after the Cognito mock is in place.
const { AppCloudStateProvider, StateProviderUnavailableError } = await import('../src/state/index.js');

// ---------------------------------------------------------------------------
// fetch mocking (mirrors test/cloudStateProvider.test.ts)
// ---------------------------------------------------------------------------

interface MockEntry {
  status: number;
  body: string;
}

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
}

/** Install a fetch mock keyed by URL pathname; records method + headers. */
function installFetchMock(responses: Record<string, MockEntry>): { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, method: init?.method ?? 'GET', headers });
    const entry = responses[new URL(url).pathname];
    if (entry === undefined) {
      return new Response('Not Found', { status: 404 });
    }
    return new Response(entry.body, { status: entry.status });
  }) as typeof fetch;
  return { calls };
}

const fakeLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as unknown as Logging;

/** Detail-response envelope for GET /v3/thermostats/{thingId}. */
function detailResponse(shadow: Record<string, unknown>): MockEntry {
  return {
    status: 200,
    body: JSON.stringify({
      statusCode: 200,
      success: true,
      data: { shadow: { state: { reported: shadow } } },
    }),
  };
}

function makeProvider(overrides: Partial<AppCloudProviderConfigType> = {}): AppCloudStateProviderType {
  return new AppCloudStateProvider(
    {
      email: 'user@example.com',
      password: 'hunter2-secret',
      thingId: 't-123',
      ...overrides,
    },
    fakeLog,
  );
}

afterEach(() => {
  globalThis.fetch = realFetch;
  realCognito.AuthenticationDetails = originalCognito.AuthenticationDetails;
  realCognito.CognitoUser = originalCognito.CognitoUser;
  realCognito.CognitoUserPool = originalCognito.CognitoUserPool;
  resetCognitoMock();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('readState logs in once and reuses the cached session across reads', async () => {
  const fetchMock = installFetchMock({
    '/v3/thermostats/t-123': detailResponse({ at: 70, hs: 70, cs: 70, sys: 1, hum: 40 }),
  });
  const provider = makeProvider();

  await provider.readState();
  await provider.readState();
  await provider.readState();

  assert.equal(cognitoMock.authenticateUserCalls, 1, 'SRP login must happen at most once per process');
  assert.equal(cognitoMock.refreshSessionCalls, 0);
  assert.equal(fetchMock.calls.length, 3, 'one GET per read');
  for (const call of fetchMock.calls) {
    assert.equal(call.headers.jwt, 'fake-access-token');
    assert.equal(call.headers.authorization, undefined, 'access token goes in the jwt header, never Authorization');
  }
});

test('readState parses the nested reported shadow into a snapshot', async () => {
  installFetchMock({
    '/v3/thermostats/t-123': detailResponse({ at: 72, hs: 68, cs: 74, sys: 1, hum: 45 }),
  });
  const provider = makeProvider();

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
  installFetchMock({
    '/v3/thermostats/t-123': detailResponse({ at: 80, hs: 65, cs: 75, sys: 2, hum: 40 }),
  });
  const provider = makeProvider();

  const snapshot = await provider.readState();

  assert.ok(Math.abs((snapshot.currentTemperatureCelsius ?? 0) - 26.67) < 0.01); // 80°F
  assert.ok(Math.abs((snapshot.targetTemperatureCelsius ?? 0) - 23.89) < 0.01); // 75°F = cs, not hs
  assert.equal(snapshot.targetHeatingCoolingState, 2); // COOL
  assert.equal(snapshot.currentHeatingCoolingState, 2);
});

test('setTargetTemperature in heat mode writes only the heat setpoint', async () => {
  const fetchMock = installFetchMock({
    '/v3/thermostats/t-123': detailResponse({ sys: 1 }),
    '/v3/shadow': { status: 200, body: JSON.stringify({ success: true }) },
  });
  const provider = makeProvider();

  await provider.setTargetTemperature(22);

  const put = fetchMock.calls.find((call) => call.method === 'PUT');
  assert.ok(put !== undefined, 'expected a PUT to /v3/shadow');
  const url = new URL(put.url);
  assert.equal(url.pathname, '/v3/shadow');
  assert.equal(url.searchParams.get('thingId'), 't-123');
  const desired = JSON.parse(url.searchParams.get('shadowNewValue') ?? '{}') as Record<string, unknown>;
  assert.equal(desired.hs, 71.6);
  assert.equal(desired.cs, undefined, 'cool setpoint must not be touched in heat mode');
});

test('setTargetTemperature in cool mode writes only the cool setpoint', async () => {
  const fetchMock = installFetchMock({
    '/v3/thermostats/t-123': detailResponse({ sys: 2 }),
    '/v3/shadow': { status: 200, body: JSON.stringify({ success: true }) },
  });
  const provider = makeProvider();

  await provider.setTargetTemperature(22);

  const put = fetchMock.calls.find((call) => call.method === 'PUT');
  assert.ok(put !== undefined, 'expected a PUT to /v3/shadow');
  const desired = JSON.parse(new URL(put.url).searchParams.get('shadowNewValue') ?? '{}') as Record<string, unknown>;
  assert.equal(desired.cs, 71.6);
  assert.equal(desired.hs, undefined, 'heat setpoint must not be touched in cool mode');
});

test('setTargetTemperature in auto mode writes both setpoints', async () => {
  const fetchMock = installFetchMock({
    '/v3/thermostats/t-123': detailResponse({ sys: 3 }),
    '/v3/shadow': { status: 200, body: JSON.stringify({ success: true }) },
  });
  const provider = makeProvider();

  await provider.setTargetTemperature(22);

  const put = fetchMock.calls.find((call) => call.method === 'PUT');
  assert.ok(put !== undefined, 'expected a PUT to /v3/shadow');
  const desired = JSON.parse(new URL(put.url).searchParams.get('shadowNewValue') ?? '{}') as Record<string, unknown>;
  assert.equal(desired.hs, 71.6);
  assert.equal(desired.cs, 71.6);
});

test('setTargetTemperature while off throws StateProviderUnavailableError', async () => {
  installFetchMock({
    '/v3/thermostats/t-123': detailResponse({ sys: 0 }),
  });
  const provider = makeProvider();

  await assert.rejects(() => provider.setTargetTemperature(22), StateProviderUnavailableError);
});

test('setTargetHeatingCoolingState writes the mapped sys field', async () => {
  const fetchMock = installFetchMock({
    '/v3/shadow': { status: 200, body: JSON.stringify({ success: true }) },
  });
  const provider = makeProvider();

  for (const mode of [0, 1, 2, 3] as const) {
    await provider.setTargetHeatingCoolingState(mode);

    const puts = fetchMock.calls.filter((call) => call.method === 'PUT');
    assert.equal(puts.length, mode + 1);
    const desired = JSON.parse(new URL(puts[mode].url).searchParams.get('shadowNewValue') ?? '{}') as Record<string, unknown>;
    assert.equal(desired.sys, mode);
  }
});

test('readState rejects with StateProviderUnavailableError on HTTP 500', async () => {
  installFetchMock({
    '/v3/thermostats/t-123': { status: 500, body: 'Internal Server Error' },
  });
  const provider = makeProvider();

  await assert.rejects(() => provider.readState(), StateProviderUnavailableError);
});

test('readState unwraps a base64-encoded data payload', async () => {
  const inner = JSON.stringify({ shadow: { state: { reported: { at: 70, hs: 68, cs: 72, sys: 1, hum: 38 } } } });
  installFetchMock({
    '/v3/thermostats/t-123': {
      status: 200,
      body: JSON.stringify({ statusCode: 200, success: true, data: Buffer.from(inner).toString('base64') }),
    },
  });
  const provider = makeProvider();

  const snapshot = await provider.readState();

  assert.ok(Math.abs((snapshot.currentTemperatureCelsius ?? 0) - 21.11) < 0.01);
  assert.ok(Math.abs((snapshot.targetTemperatureCelsius ?? 0) - 20) < 0.01);
  assert.equal(snapshot.currentRelativeHumidityPercent, 38);
});

test('readState discovers the thingId from the account device list when unconfigured', async () => {
  const fetchMock = installFetchMock({
    '/v3/thermostats': {
      status: 200,
      body: JSON.stringify({
        statusCode: 200,
        success: true,
        things: [{ thingName: 't-123', shadow: { state: { reported: { sys: 1 } } } }],
      }),
    },
    '/v3/thermostats/t-123': detailResponse({ at: 71, hs: 69, cs: 73, sys: 1, hum: 40 }),
  });
  const provider = makeProvider({ thingId: undefined });

  await provider.readState();
  await provider.readState();

  const listCalls = fetchMock.calls.filter((call) => call.url.includes('ownerId='));
  assert.equal(listCalls.length, 1, 'resolved thingId must be cached after the first read');
  assert.ok(listCalls[0].url.includes('ownerId=user-sub-123'), 'ownerId comes from the id token sub claim');
  assert.ok(listCalls[0].url.includes('sortFilter=thingName'));
  assert.equal(fetchMock.calls.length, 3, 'one list call + two detail calls');
});

test('readState transparently refreshes an expired session', async () => {
  installFetchMock({
    '/v3/thermostats/t-123': detailResponse({ at: 70, sys: 1 }),
  });
  cognitoMock.loginSessionExpSeconds = Math.floor(Date.now() / 1000) - 60; // already expired
  const provider = makeProvider();

  await provider.readState(); // full SRP login, expired token cached
  await provider.readState(); // refresh via refresh token
  await provider.readState(); // refreshed session is valid — cached

  assert.equal(cognitoMock.authenticateUserCalls, 1);
  assert.equal(cognitoMock.refreshSessionCalls, 1);
});

test('login failure rejects with StateProviderUnavailableError and redacted credentials', async () => {
  installFetchMock({});
  cognitoMock.loginShouldFail = true;
  // The fake Cognito error echoes the credentials; they must be redacted.
  cognitoMock.loginError = 'NotAuthorizedException: invalid password hunter2-secret for user@example.com';
  const provider = makeProvider();

  await assert.rejects(
    () => provider.readState(),
    (error: unknown) => {
      assert.ok(error instanceof StateProviderUnavailableError);
      const message = error instanceof Error ? error.message : String(error);
      assert.ok(!message.includes('hunter2-secret'), 'password must be redacted');
      assert.ok(!message.includes('user@example.com'), 'email must be redacted');
      assert.ok(message.includes('[REDACTED]'));
      return true;
    },
  );
});
