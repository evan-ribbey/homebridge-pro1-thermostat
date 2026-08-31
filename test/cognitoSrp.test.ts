import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CognitoAuthError,
  CognitoSrpClient,
  computeHkdf,
  decodeJwtPayload,
  formatCognitoTimestamp,
  getPasswordAuthenticationKey,
  hexHash,
  modPow,
  padHex,
  signSecretBlock,
  SRP_G,
  SRP_N,
} from '../src/state/cognitoSrp.js';

// ---------------------------------------------------------------------------
// Differential testing against amazon-cognito-identity-js.
//
// The native SRP implementation replaced that library at runtime, but it is
// kept as a devDependency purely as a test oracle: every derivation step below
// is checked against the reference implementation with identical inputs. A
// signature that is wrong in any byte fails Cognito login outright, and there
// is no way to notice that from a unit test written in isolation.
// ---------------------------------------------------------------------------

const require = createRequire(import.meta.url);
/* eslint-disable @typescript-eslint/no-explicit-any */
const AuthenticationHelper = require('amazon-cognito-identity-js/lib/AuthenticationHelper.js').default as any;
const BigIntegerCtor = require('amazon-cognito-identity-js/lib/BigInteger.js').default as any;
const DateHelper = require('amazon-cognito-identity-js/lib/DateHelper.js').default as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

const POOL_NAME = 'oplIqH10t';

test('padHex matches the reference BigInteger two-s-complement encoding', () => {
  const helper = new AuthenticationHelper(POOL_NAME);
  const values = ['1', '14', 'ec', 'c8', '100', 'ff', '7f', '80', 'abcdef0123456789'];
  for (const hex of values) {
    const expected = helper.padHex(new BigIntegerCtor(hex, 16)) as string;
    assert.equal(
      padHex(BigInt(`0x${hex}`)).toUpperCase(),
      expected.toUpperCase(),
      `padHex mismatch for 0x${hex}`,
    );
  }
});

test('hexHash matches the reference hash of hex-encoded bytes', () => {
  const helper = new AuthenticationHelper(POOL_NAME);
  for (const hex of ['00', 'deadbeef', 'FF14', '0102030405060708']) {
    assert.equal(hexHash(hex), helper.hexHash(hex));
  }
});

test('computeHkdf matches the reference HKDF', () => {
  const helper = new AuthenticationHelper(POOL_NAME);
  for (let i = 0; i < 5; i += 1) {
    const ikm = randomBytes(64);
    const salt = randomBytes(32);
    const expected = Buffer.from(helper.computehkdf(ikm, salt) as Uint8Array);
    assert.deepEqual(computeHkdf(ikm, salt), expected, 'HKDF output must match byte for byte');
  }
});

test('modPow matches the reference modular exponentiation', async () => {
  for (let i = 0; i < 3; i += 1) {
    const exponentHex = randomBytes(16).toString('hex');
    // This build's BigInteger.modPow is callback-based.
    const expected: string = await new Promise((resolve, reject) => {
      new BigIntegerCtor(SRP_G.toString(16), 16).modPow(
        new BigIntegerCtor(exponentHex, 16),
        new BigIntegerCtor(SRP_N.toString(16), 16),
        (err: Error | null, value: { toString(radix: number): string }) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(value.toString(16));
        },
      );
    });
    assert.equal(modPow(SRP_G, BigInt(`0x${exponentHex}`), SRP_N).toString(16), expected);
  }
});

test('the password authentication key matches the reference implementation', async () => {
  // Drive the reference helper with a fixed small `a` so both implementations
  // derive from identical inputs, then compare the 16-byte session keys.
  for (let round = 0; round < 3; round += 1) {
    const helper = new AuthenticationHelper(POOL_NAME);
    const smallAHex = randomBytes(128).toString('hex');
    helper.smallAValue = new BigIntegerCtor(smallAHex, 16);
    helper.largeAValue = undefined;
    const largeA: string = await new Promise((resolve, reject) => {
      helper.getLargeAValue((err: Error | null, value: { toString(radix: number): string }) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(value.toString(16));
      });
    });

    // A plausible server challenge.
    const serverBHex = randomBytes(384).toString('hex');
    const saltHex = randomBytes(16).toString('hex');
    const username = 'a1b2c3d4-0000-4444-8888-abcdefabcdef';
    const password = 'Correct-Horse-Battery-Staple-9';

    const expected: Buffer = await new Promise((resolve, reject) => {
      helper.getPasswordAuthenticationKey(
        username,
        password,
        new BigIntegerCtor(serverBHex, 16),
        new BigIntegerCtor(saltHex, 16),
        (err: Error | null, hkdf: Uint8Array) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(Buffer.from(hkdf));
        },
      );
    });

    const actual = getPasswordAuthenticationKey({
      poolName: POOL_NAME,
      username,
      password,
      smallA: BigInt(`0x${smallAHex}`),
      largeA: BigInt(`0x${largeA}`),
      serverB: BigInt(`0x${serverBHex}`),
      salt: BigInt(`0x${saltHex}`),
    });

    assert.deepEqual(actual, expected, `session key mismatch on round ${round}`);
    assert.ok(CognitoSrpClient.equalSecrets(actual, expected));
  }
});

test('the timestamp format matches the reference DateHelper', () => {
  const helper = new DateHelper();
  // Fixed instants that exercise unpadded day-of-month and padded time fields.
  const cases = [
    new Date(Date.UTC(2026, 7, 30, 9, 5, 3)),
    new Date(Date.UTC(2026, 0, 1, 23, 59, 59)),
    new Date(Date.UTC(2026, 11, 25, 0, 0, 0)),
  ];
  for (const instant of cases) {
    const realDate = Date;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).Date = class extends realDate {
      constructor() {
        super();
        return new realDate(instant.getTime()) as unknown as Date;
      }
    };
    let expected: string;
    try {
      expected = helper.getNowString() as string;
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).Date = realDate;
    }
    assert.equal(formatCognitoTimestamp(instant), expected);
  }
});

test('the secret block signature matches the reference construction', () => {
  const key = randomBytes(16);
  const username = 'a1b2c3d4-0000-4444-8888-abcdefabcdef';
  const secretBlockBase64 = randomBytes(512).toString('base64');
  const timestamp = 'Sun Aug 30 09:05:03 UTC 2026';

  // Reference construction, transcribed from CognitoUser.authenticateUserDefaultAuth.
  const { Sha256 } = require('@aws-crypto/sha256-js') as { Sha256: new (key: Buffer) => {
    update(buf: Buffer): void;
    digestSync(): Uint8Array;
  } };
  const concat = Buffer.concat([
    Buffer.from(POOL_NAME, 'utf8'),
    Buffer.from(username, 'utf8'),
    Buffer.from(secretBlockBase64, 'base64'),
    Buffer.from(timestamp, 'utf8'),
  ]);
  const reference = new Sha256(key);
  reference.update(concat);
  const expected = Buffer.from(reference.digestSync()).toString('base64');

  assert.equal(signSecretBlock({ key, poolName: POOL_NAME, username, secretBlockBase64, timestamp }), expected);
});

// ---------------------------------------------------------------------------
// Protocol-level tests against a stubbed Cognito endpoint.
// ---------------------------------------------------------------------------

test('authenticate performs the two-step SRP exchange and returns tokens', async () => {
  const requests: Array<{ target: string; body: Record<string, unknown> }> = [];
  const helper = new AuthenticationHelper(POOL_NAME);
  const saltHex = randomBytes(16).toString('hex');
  const serverBHex = randomBytes(384).toString('hex');

  const fakeFetch = (async (_url: unknown, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string>;
    const target = headers['X-Amz-Target'].split('.')[1];
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push({ target, body });

    if (target === 'InitiateAuth') {
      return new Response(JSON.stringify({
        ChallengeName: 'PASSWORD_VERIFIER',
        ChallengeParameters: {
          SRP_B: serverBHex,
          SALT: saltHex,
          SECRET_BLOCK: randomBytes(64).toString('base64'),
          USER_ID_FOR_SRP: 'canonical-user-id',
        },
      }), { status: 200 });
    }
    return new Response(JSON.stringify({
      AuthenticationResult: { AccessToken: 'access', IdToken: 'id', RefreshToken: 'refresh' },
    }), { status: 200 });
  }) as typeof fetch;

  const client = new CognitoSrpClient('us-west-2_oplIqH10t', 'clientid', fakeFetch);
  const tokens = await client.authenticate('user@example.com', 'secret');

  assert.deepEqual(tokens, { accessToken: 'access', idToken: 'id', refreshToken: 'refresh' });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].target, 'InitiateAuth');
  assert.equal(requests[0].body.AuthFlow, 'USER_SRP_AUTH');
  assert.ok(typeof (requests[0].body.AuthParameters as Record<string, string>).SRP_A === 'string');
  assert.equal(requests[1].target, 'RespondToAuthChallenge');
  assert.equal(requests[1].body.ChallengeName, 'PASSWORD_VERIFIER');

  // The canonical username from the challenge, not the typed email, is echoed.
  const responses = requests[1].body.ChallengeResponses as Record<string, string>;
  assert.equal(responses.USERNAME, 'canonical-user-id');
  assert.ok(responses.PASSWORD_CLAIM_SIGNATURE.length > 0);
  assert.ok(responses.TIMESTAMP.includes('UTC'));
  void helper;
});

test('refresh uses the REFRESH_TOKEN_AUTH flow', async () => {
  let captured: Record<string, unknown> = {};
  const fakeFetch = (async (_url: unknown, init?: RequestInit) => {
    captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      AuthenticationResult: { AccessToken: 'access2', IdToken: 'id2' },
    }), { status: 200 });
  }) as typeof fetch;

  const client = new CognitoSrpClient('us-west-2_oplIqH10t', 'clientid', fakeFetch);
  const tokens = await client.refresh('refresh-token');

  assert.equal(captured.AuthFlow, 'REFRESH_TOKEN_AUTH');
  assert.equal((captured.AuthParameters as Record<string, string>).REFRESH_TOKEN, 'refresh-token');
  assert.equal(tokens.accessToken, 'access2');
  assert.equal(tokens.refreshToken, undefined, 'Cognito does not reissue the refresh token');
});

test('a Cognito error surfaces its error type', async () => {
  const fakeFetch = (async () => new Response(
    JSON.stringify({ __type: 'NotAuthorizedException', message: 'Incorrect username or password.' }),
    { status: 400, headers: { 'x-amzn-errortype': 'NotAuthorizedException:' } },
  )) as typeof fetch;

  const client = new CognitoSrpClient('us-west-2_oplIqH10t', 'clientid', fakeFetch);

  await assert.rejects(
    () => client.authenticate('user@example.com', 'wrong'),
    (error: unknown) => {
      assert.ok(error instanceof CognitoAuthError);
      assert.equal(error.code, 'NotAuthorizedException');
      assert.ok(error.message.includes('Incorrect username or password.'));
      return true;
    },
  );
});

test('an unexpected challenge is reported rather than silently mishandled', async () => {
  const fakeFetch = (async () => new Response(
    JSON.stringify({ ChallengeName: 'NEW_PASSWORD_REQUIRED', ChallengeParameters: {} }),
    { status: 200 },
  )) as typeof fetch;

  const client = new CognitoSrpClient('us-west-2_oplIqH10t', 'clientid', fakeFetch);

  await assert.rejects(
    () => client.authenticate('user@example.com', 'secret'),
    (error: unknown) => {
      assert.ok(error instanceof CognitoAuthError);
      assert.equal(error.code, 'NEW_PASSWORD_REQUIRED');
      return true;
    },
  );
});

test('decodeJwtPayload reads standard claims', () => {
  const payload = { sub: 'user-sub-123', exp: 1893456000 };
  const token = `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;
  assert.deepEqual(decodeJwtPayload(token), payload);
  assert.throws(() => decodeJwtPayload('notajwt'), CognitoAuthError);
});

test('a malformed user pool id is rejected at construction', () => {
  assert.throws(() => new CognitoSrpClient('nounderscore', 'clientid'), CognitoAuthError);
});
