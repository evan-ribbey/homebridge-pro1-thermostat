import { randomBytes, createHmac } from 'node:crypto';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';

import type { Logging } from 'homebridge';

import { AppCloudStateProvider, CognitoSrpClient, StateProviderUnavailableError } from '../src/state/index.js';
import type { AppCloudProviderConfig } from '../src/state/index.js';

const realFetch = globalThis.fetch;

// ---------------------------------------------------------------------------
// Cognito stubbing
//
// The provider now authenticates through the native CognitoSrpClient, so
// instead of swapping out a library's exports this drives a *real* client
// against a stubbed Cognito endpoint. The genuine SRP exchange therefore runs
// on every test that logs in, and the counters below observe it from outside.
// ---------------------------------------------------------------------------

const cognitoMock = {
  authenticateUserCalls: 0,
  refreshSessionCalls: 0,
  /** `exp` (epoch seconds) minted for login-created access tokens. */
  loginSessionExpSeconds: 0,
  /** `exp` (epoch seconds) minted for refresh-created access tokens. */
  refreshSessionExpSeconds: 0,
  /** id token `sub` claim used for device discovery. */
  idTokenSub: 'user-sub-123',
  /** When true, InitiateAuth fails with loginError. */
  loginShouldFail: false,
  /** Error message the stubbed Cognito surfaces on login failure. */
  loginError: 'NotAuthorizedException: Incorrect username or password.',
  /** When true, the refresh exchange fails. */
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

/** Mint an unsigned JWT with the given claims (the provider never verifies). */
function mintJwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  const body = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(claims)}`;
  return `${body}.${createHmac('sha256', 'test').update(body).digest('base64url')}`;
}

function authResult(expSeconds: number, withRefreshToken: boolean): string {
  return JSON.stringify({
    AuthenticationResult: {
      AccessToken: mintJwt(
        Number.isFinite(expSeconds) ? { exp: expSeconds, token_use: 'access' } : { token_use: 'access' },
      ),
      IdToken: mintJwt({ sub: cognitoMock.idTokenSub, token_use: 'id' }),
      ...(withRefreshToken ? { RefreshToken: 'stub-refresh-token' } : {}),
    },
  });
}

function cognitoError(message: string): Response {
  return new Response(
    JSON.stringify({ __type: 'NotAuthorizedException', message }),
    { status: 400, headers: { 'x-amzn-errortype': 'NotAuthorizedException:' } },
  );
}

/** A CognitoSrpClient wired to a stubbed user pool endpoint. */
function makeCognitoClient(): CognitoSrpClient {
  const stubFetch = (async (_url: unknown, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string>;
    const target = headers['X-Amz-Target'].split('.')[1];
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;

    if (target === 'InitiateAuth' && body.AuthFlow === 'REFRESH_TOKEN_AUTH') {
      cognitoMock.refreshSessionCalls += 1;
      if (cognitoMock.refreshShouldFail) {
        return cognitoError('Token has expired and cannot be refreshed');
      }
      // A refresh never reissues the refresh token.
      return new Response(authResult(cognitoMock.refreshSessionExpSeconds, false), { status: 200 });
    }

    if (target === 'InitiateAuth') {
      cognitoMock.authenticateUserCalls += 1;
      if (cognitoMock.loginShouldFail) {
        return cognitoError(cognitoMock.loginError);
      }
      return new Response(JSON.stringify({
        ChallengeName: 'PASSWORD_VERIFIER',
        ChallengeParameters: {
          SRP_B: randomBytes(384).toString('hex'),
          SALT: randomBytes(16).toString('hex'),
          SECRET_BLOCK: randomBytes(64).toString('base64'),
          USER_ID_FOR_SRP: cognitoMock.idTokenSub,
        },
      }), { status: 200 });
    }

    // RespondToAuthChallenge — the SRP maths already ran to get here.
    return new Response(authResult(cognitoMock.loginSessionExpSeconds, true), { status: 200 });
  }) as typeof fetch;

  return new CognitoSrpClient('us-west-2_oplIqH10t', 'test-client-id', stubFetch);
}

resetCognitoMock();

// ---------------------------------------------------------------------------
// fetch mocking for the app-cloud REST API
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

function makeProvider(overrides: Partial<AppCloudProviderConfig> = {}): AppCloudStateProvider {
  return new AppCloudStateProvider(
    {
      email: 'user@example.com',
      password: 'hunter2-secret',
      thingId: 't-123',
      ...overrides,
    },
    fakeLog,
    makeCognitoClient(),
  );
}

afterEach(() => {
  globalThis.fetch = realFetch;
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
    assert.match(call.headers.jwt, /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/, 'a JWT access token must be sent');
    assert.equal(call.headers.authorization, undefined, 'access token goes in the jwt header, never Authorization');
  }
});

test('readState parses the nested reported shadow into a snapshot', async () => {
  installFetchMock({
    '/v3/thermostats/t-123': detailResponse({ at: 72, hs: 68, cs: 74, sys: 2, hum: 45 }),
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
    '/v3/thermostats/t-123': detailResponse({ at: 80, hs: 65, cs: 75, sys: 1, hum: 40 }),
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
    '/v3/thermostats/t-123': detailResponse({ sys: 2 }), // HEAT on this firmware
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
    '/v3/thermostats/t-123': detailResponse({ sys: 1 }), // COOL on this firmware
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
    // HomeKit mode -> device sys: heat(1)->2, cool(2)->1 (verified live)
    assert.equal(desired.sys, [0, 2, 1, 3][mode]);
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
  const inner = JSON.stringify({ shadow: { state: { reported: { at: 70, hs: 68, cs: 72, sys: 2, hum: 38 } } } });
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

/** Capture log lines by level. */
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

test('a token with no usable exp claim does not trigger a refresh on every request', async () => {
  installFetchMock({
    '/v3/thermostats/t-123': detailResponse({ at: 70, sys: 1 }),
  });
  // Regression: the fallback expiry used to equal the refresh margin, so the
  // freshness check failed immediately and every request dragged a refresh.
  cognitoMock.loginSessionExpSeconds = Number.NaN;
  const provider = makeProvider();

  await provider.readState();
  await provider.readState();
  await provider.readState();

  assert.equal(cognitoMock.authenticateUserCalls, 1);
  assert.equal(cognitoMock.refreshSessionCalls, 0, 'a missing exp must not cause a refresh storm');
});

test('discovery warns when the account holds more than one thermostat', async () => {
  installFetchMock({
    '/v3/thermostats': {
      status: 200,
      body: JSON.stringify({
        statusCode: 200,
        success: true,
        things: [{ thingName: 't-aaa' }, { thingName: 't-bbb' }],
      }),
    },
    '/v3/thermostats/t-aaa': detailResponse({ at: 70, sys: 1 }),
  });
  const { log, lines } = makeCapturingLog();
  const provider = new AppCloudStateProvider(
    { email: 'user@example.com', password: 'hunter2-secret', thingId: undefined },
    log,
    makeCognitoClient(),
  );

  await provider.readState();

  const warning = lines.find((line) => line.startsWith('warn:'));
  assert.ok(warning !== undefined, 'a multi-thermostat account must not silently pick one');
  assert.ok(warning.includes('t-aaa') && warning.includes('t-bbb'), 'the warning should list the choices');
  assert.ok(warning.includes('thingId'), 'the warning should name the setting that resolves it');
});

test('discovery rejects a malformed device list', async () => {
  installFetchMock({
    '/v3/thermostats': {
      status: 200,
      body: JSON.stringify({ statusCode: 200, success: true, things: { nope: true } }),
    },
  });
  const provider = makeProvider({ thingId: undefined });

  await assert.rejects(() => provider.readState(), StateProviderUnavailableError);
});

test('readState reports Off as the current state when sys=0', async () => {
  installFetchMock({
    '/v3/thermostats/t-123': detailResponse({ at: 70, hs: 68, cs: 74, sys: 0 }),
  });
  const provider = makeProvider();

  const snapshot = await provider.readState();

  // Regression: sys=0 produced null, leaving the Home app showing the last
  // active mode for a thermostat that is switched off.
  assert.equal(snapshot.currentHeatingCoolingState, 0);
  assert.equal(snapshot.targetHeatingCoolingState, 0);
});

test('GET requests do not declare a JSON body they are not sending', async () => {
  const fetchMock = installFetchMock({
    '/v3/thermostats/t-123': detailResponse({ at: 70, sys: 1 }),
  });
  const provider = makeProvider();

  await provider.readState();

  const get = fetchMock.calls.find((call) => call.method === 'GET');
  assert.ok(get !== undefined);
  assert.equal(get.headers['Content-Type'], undefined);
  assert.match(get.headers.jwt, /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/);
});

test('readState maps the shadow fan field to a fan mode', async () => {
  installFetchMock({
    '/v3/thermostats/t-123': detailResponse({ at: 72, hs: 68, cs: 74, sys: 2, fan: 0 }),
  });
  const provider = makeProvider();

  const snapshot = await provider.readState();

  assert.equal(snapshot.fanMode, 'auto');
});

test('setFanMode writes the device fan field', async () => {
  const fetchMock = installFetchMock({
    '/v3/shadow': { status: 200, body: JSON.stringify({ success: true }) },
  });
  const provider = makeProvider();

  await provider.setFanMode('on');
  await provider.setFanMode('auto');

  const puts = fetchMock.calls.filter((call) => call.method === 'PUT');
  assert.equal(puts.length, 2);
  const desired = puts.map((put) => JSON.parse(new URL(put.url).searchParams.get('shadowNewValue') ?? '{}') as Record<string, unknown>);
  assert.deepEqual(desired, [{ fan: 1 }, { fan: 0 }]);
});
