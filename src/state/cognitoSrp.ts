/**
 * Minimal AWS Cognito SRP (Secure Remote Password) authentication.
 *
 * This replaces `amazon-cognito-identity-js`, which is a browser-oriented
 * library: it pulled in `isomorphic-unfetch` → `node-fetch@2` (end-of-life),
 * a `buffer@4.9.2` polyfill and `js-cookie`, none of which a Node-only
 * Homebridge plugin needs. Node has had global `fetch`, `BigInt` and a full
 * `crypto` module for years, so the whole flow is a few hundred lines here.
 *
 * Implements the USER_SRP_AUTH flow against the Cognito Identity Provider
 * JSON API, byte-for-byte compatible with the reference library (see
 * test/cognitoSrp.test.ts, which differentially tests every derivation step
 * against `amazon-cognito-identity-js` itself):
 *
 *   1. InitiateAuth(USER_SRP_AUTH) with SRP_A = g^a mod N
 *   2. Server replies with the PASSWORD_VERIFIER challenge (SRP_B, SALT,
 *      SECRET_BLOCK, USER_ID_FOR_SRP)
 *   3. Derive the session key and sign the secret block
 *   4. RespondToAuthChallenge(PASSWORD_VERIFIER) → tokens
 *
 * Refresh uses the far simpler REFRESH_TOKEN_AUTH flow.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** RFC 5054 3072-bit group prime, as used by Cognito. */
const N_HEX =
  'FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD1'
  + '29024E088A67CC74020BBEA63B139B22514A08798E3404DD'
  + 'EF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245'
  + 'E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED'
  + 'EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3D'
  + 'C2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F'
  + '83655D23DCA3AD961C62F356208552BB9ED529077096966D'
  + '670C354E4ABC9804F1746C08CA18217C32905E462E36CE3B'
  + 'E39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9'
  + 'DE2BCBF6955817183995497CEA956AE515D2261898FA0510'
  + '15728E5A8AAAC42DAD33170D04507A33A85521ABDF1CBA64'
  + 'ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7'
  + 'ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6B'
  + 'F12FFA06D98A0864D87602733EC86A64521F2B18177B200C'
  + 'BBE117577A615D6C770988C0BAD946E208E24FA074E5AB31'
  + '43DB5BFCE0FD108E4B82D120A93AD2CAFFFFFFFFFFFFFFFF';

const N = BigInt(`0x${N_HEX}`);
const G = 2n;

/** HKDF info string Cognito derives the session key with. */
const INFO_BITS = Buffer.from('Caldera Derived Key', 'utf8');

/** Timeout for Cognito HTTP calls. */
const COGNITO_TIMEOUT_MS = 10_000;

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEK_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Tokens returned by a successful authentication. */
export interface CognitoTokens {
  accessToken: string;
  idToken: string;
  /** Absent on a refresh: Cognito does not reissue the refresh token. */
  refreshToken?: string;
}

/** Thrown for any Cognito-side failure; carries the Cognito error type. */
export class CognitoAuthError extends Error {
  public readonly code: string;

  constructor(message: string, code = 'CognitoError') {
    super(message);
    this.name = 'CognitoAuthError';
    this.code = code;
  }
}

/**
 * Even-length hex of a non-negative integer, prefixed with `00` when the most
 * significant bit is set. This mirrors Java's `BigInteger.toByteArray()` sign
 * handling, which Cognito's hashes depend on — dropping the pad silently
 * produces a valid-looking but wrong signature.
 */
export function padHex(value: bigint): string {
  if (value < 0n) {
    throw new Error('padHex: negative values are not used in this flow');
  }
  let hex = value.toString(16);
  if (hex.length % 2 !== 0) {
    hex = `0${hex}`;
  }
  if (/^[89a-f]/i.test(hex)) {
    hex = `00${hex}`;
  }
  return hex.toUpperCase();
}

/** SHA-256 of a buffer or utf8 string, as lowercase hex. */
export function hashHex(input: Buffer | string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** SHA-256 of the bytes a hex string represents. */
export function hexHash(hex: string): string {
  return hashHex(Buffer.from(hex, 'hex'));
}

/** HKDF(SHA-256) truncated to the 16-byte key Cognito signs with. */
export function computeHkdf(ikm: Buffer, salt: Buffer): Buffer {
  const prk = createHmac('sha256', salt).update(ikm).digest();
  const info = Buffer.concat([INFO_BITS, Buffer.from([1])]);
  return createHmac('sha256', prk).update(info).digest().subarray(0, 16);
}

/** Modular exponentiation; Node has no built-in bigint modPow. */
export function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let b = base % modulus;
  if (b < 0n) {
    b += modulus;
  }
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) {
      result = (result * b) % modulus;
    }
    e >>= 1n;
    b = (b * b) % modulus;
  }
  return result;
}

/** k = H(N | g), the SRP-6a multiplier. */
const K = BigInt(`0x${hexHash(`${padHex(N)}${padHex(G)}`)}`);

/** Cognito's timestamp format: `ddd MMM D HH:mm:ss UTC YYYY` (day unpadded). */
export function formatCognitoTimestamp(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${WEEK_NAMES[now.getUTCDay()]} ${MONTH_NAMES[now.getUTCMonth()]} ${now.getUTCDate()} `
    + `${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())} UTC ${now.getUTCFullYear()}`;
}

/**
 * Derive the 16-byte password authentication key from the server's challenge.
 * Exported for the differential test against the reference library.
 */
export function getPasswordAuthenticationKey(params: {
  poolName: string;
  username: string;
  password: string;
  smallA: bigint;
  largeA: bigint;
  serverB: bigint;
  salt: bigint;
}): Buffer {
  const { poolName, username, password, smallA, largeA, serverB, salt } = params;

  if (serverB % N === 0n) {
    throw new CognitoAuthError('SRP error: server public value B cannot be zero');
  }
  const u = BigInt(`0x${hexHash(`${padHex(largeA)}${padHex(serverB)}`)}`);
  if (u === 0n) {
    throw new CognitoAuthError('SRP error: computed u cannot be zero');
  }

  const usernamePasswordHash = hashHex(`${poolName}${username}:${password}`);
  const x = BigInt(`0x${hexHash(`${padHex(salt)}${usernamePasswordHash}`)}`);

  // S = (B - k * g^x) ^ (a + u * x) mod N. The base can be negative, so it is
  // normalised into [0, N) first — exactly what the reference library's
  // BigInteger.mod() does before reducing.
  let base = (serverB - K * modPow(G, x, N)) % N;
  if (base < 0n) {
    base += N;
  }
  const s = modPow(base, smallA + u * x, N);

  return computeHkdf(Buffer.from(padHex(s), 'hex'), Buffer.from(padHex(u), 'hex'));
}

/** Base64 signature over poolName | username | secretBlock | timestamp. */
export function signSecretBlock(params: {
  key: Buffer;
  poolName: string;
  username: string;
  secretBlockBase64: string;
  timestamp: string;
}): string {
  const message = Buffer.concat([
    Buffer.from(params.poolName, 'utf8'),
    Buffer.from(params.username, 'utf8'),
    Buffer.from(params.secretBlockBase64, 'base64'),
    Buffer.from(params.timestamp, 'utf8'),
  ]);
  return createHmac('sha256', params.key).update(message).digest('base64');
}

/** Decode a JWT payload without verifying it (the transport is TLS to Cognito). */
export function decodeJwtPayload(token: string): Record<string, unknown> {
  const segments = token.split('.');
  if (segments.length < 2) {
    throw new CognitoAuthError('Malformed JWT: expected at least two segments');
  }
  const decoded = Buffer.from(segments[1], 'base64url').toString('utf8');
  const parsed: unknown = JSON.parse(decoded);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new CognitoAuthError('Malformed JWT: payload is not an object');
  }
  return parsed as Record<string, unknown>;
}

interface InitiateAuthResponse {
  ChallengeName?: string;
  ChallengeParameters?: Record<string, string>;
  AuthenticationResult?: {
    AccessToken?: string;
    IdToken?: string;
    RefreshToken?: string;
  };
}

/**
 * A Cognito user pool client that authenticates over SRP using only Node
 * built-ins. One instance per pool; stateless between calls.
 */
export class CognitoSrpClient {
  private readonly region: string;
  private readonly poolName: string;
  private readonly endpoint: string;

  /** Seam for tests: defaults to global fetch. */
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly userPoolId: string,
    private readonly clientId: string,
    fetchImpl?: typeof fetch,
  ) {
    const [region, poolName] = userPoolId.split('_');
    if (region === undefined || poolName === undefined || poolName === '') {
      throw new CognitoAuthError(`Malformed Cognito user pool id: ${userPoolId}`);
    }
    this.region = region;
    this.poolName = poolName;
    this.endpoint = `https://cognito-idp.${region}.amazonaws.com/`;
    this.fetchImpl = fetchImpl ?? ((input, init) => fetch(input, init));
  }

  /** Full SRP login. @throws {CognitoAuthError} on any failure. */
  public async authenticate(username: string, password: string): Promise<CognitoTokens> {
    // a is a random 128-byte value; N is 3072-bit so no reduction is needed.
    const smallA = BigInt(`0x${randomBytes(128).toString('hex')}`);
    const largeA = modPow(G, smallA, N);
    if (largeA % N === 0n) {
      throw new CognitoAuthError('SRP error: computed A mod N cannot be zero');
    }

    const challenge = await this.call<InitiateAuthResponse>('InitiateAuth', {
      AuthFlow: 'USER_SRP_AUTH',
      ClientId: this.clientId,
      AuthParameters: { USERNAME: username, SRP_A: largeA.toString(16) },
    });

    if (challenge.ChallengeName !== 'PASSWORD_VERIFIER') {
      throw new CognitoAuthError(
        `Unsupported Cognito challenge "${challenge.ChallengeName ?? 'none'}"; `
        + 'this plugin only implements plain SRP password login',
        challenge.ChallengeName ?? 'NoChallenge',
      );
    }

    const parameters = challenge.ChallengeParameters ?? {};
    const { SRP_B: srpB, SALT: saltHex, SECRET_BLOCK: secretBlock, USER_ID_FOR_SRP: userIdForSrp } = parameters;
    if (!srpB || !saltHex || !secretBlock || !userIdForSrp) {
      throw new CognitoAuthError('Cognito PASSWORD_VERIFIER challenge was missing required parameters');
    }

    // Cognito echoes back the canonical username; the key derivation must use
    // that value, not whatever the user typed in the config.
    const key = getPasswordAuthenticationKey({
      poolName: this.poolName,
      username: userIdForSrp,
      password,
      smallA,
      largeA,
      serverB: BigInt(`0x${srpB}`),
      salt: BigInt(`0x${saltHex}`),
    });

    const timestamp = formatCognitoTimestamp(new Date());
    const signature = signSecretBlock({
      key,
      poolName: this.poolName,
      username: userIdForSrp,
      secretBlockBase64: secretBlock,
      timestamp,
    });

    const result = await this.call<InitiateAuthResponse>('RespondToAuthChallenge', {
      ChallengeName: 'PASSWORD_VERIFIER',
      ClientId: this.clientId,
      ChallengeResponses: {
        USERNAME: userIdForSrp,
        PASSWORD_CLAIM_SECRET_BLOCK: secretBlock,
        PASSWORD_CLAIM_SIGNATURE: signature,
        TIMESTAMP: timestamp,
      },
    });

    return this.extractTokens(result);
  }

  /** Exchange a refresh token for a fresh access/id token pair. */
  public async refresh(refreshToken: string): Promise<CognitoTokens> {
    const result = await this.call<InitiateAuthResponse>('InitiateAuth', {
      AuthFlow: 'REFRESH_TOKEN_AUTH',
      ClientId: this.clientId,
      AuthParameters: { REFRESH_TOKEN: refreshToken },
    });
    return this.extractTokens(result);
  }

  private extractTokens(response: InitiateAuthResponse): CognitoTokens {
    const result = response.AuthenticationResult;
    if (result?.AccessToken === undefined || result.IdToken === undefined) {
      throw new CognitoAuthError('Cognito did not return an authentication result');
    }
    return {
      accessToken: result.AccessToken,
      idToken: result.IdToken,
      refreshToken: result.RefreshToken,
    };
  }

  /** POST one Cognito Identity Provider JSON operation. */
  private async call<T>(operation: string, body: Record<string, unknown>): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-amz-json-1.1',
          'X-Amz-Target': `AWSCognitoIdentityProviderService.${operation}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(COGNITO_TIMEOUT_MS),
      });
    } catch (error) {
      throw new CognitoAuthError(
        `Cognito ${operation} request failed: ${error instanceof Error ? error.message : String(error)}`,
        'NetworkError',
      );
    }

    const text = await response.text();
    let parsed: Record<string, unknown> = {};
    if (text !== '') {
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        parsed = {};
      }
    }

    if (!response.ok) {
      // Cognito reports the error type in a header and/or __type.
      const headerType = response.headers.get('x-amzn-errortype')?.split(':')[0];
      const bodyType = typeof parsed.__type === 'string' ? parsed.__type.split('#').pop() : undefined;
      const code = headerType ?? bodyType ?? `HTTP${response.status}`;
      const message = typeof parsed.message === 'string' ? parsed.message : `HTTP ${response.status}`;
      throw new CognitoAuthError(`Cognito ${operation} failed (${code}): ${message}`, code);
    }

    return parsed as T;
  }

  /** The user pool's short name, as used in SRP hashing. */
  public getPoolName(): string {
    return this.poolName;
  }

  /** The AWS region derived from the user pool id. */
  public getRegion(): string {
    return this.region;
  }

  /** Constant-time compare, exposed for tests that verify derived material. */
  public static equalSecrets(a: Buffer, b: Buffer): boolean {
    return a.length === b.length && timingSafeEqual(a, b);
  }
}

export { N as SRP_N, G as SRP_G };
