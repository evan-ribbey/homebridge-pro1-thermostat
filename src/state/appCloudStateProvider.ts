/**
 * Thermostat state provider backed by the PRO1 Connect app-cloud REST API
 * (https://api.pro1iaq.com) with AWS Cognito SRP authentication.
 *
 * Auth model (reverse-engineered from the PRO1 Connect app):
 *   - Cognito user pool `us-west-2_oplIqH10t`, app client `7j9nbbjq21320p3borim8t41er`.
 *   - Access tokens are sent in the `jwt` header (never `Authorization`).
 *   - The Cognito user's `sub` claim is the ownerId used for device discovery;
 *     the discovered IoT thing name doubles as the REST thingId.
 *
 * Token lifecycle (in-memory only, per M3 constraints):
 *   - First operation performs a full SRP login (authenticateUser).
 *   - Subsequent operations reuse the cached access token until it is within
 *     60s of expiry, then transparently refresh via the refresh token.
 *   - If refresh fails, a full SRP re-login is attempted.
 *
 * Security: passwords, tokens, and the account email are never logged; error
 * messages are sanitized before being surfaced or logged.
 */
import {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserPool,
  CognitoUserSession,
} from 'amazon-cognito-identity-js';
import type { Logging } from 'homebridge';

import {
  StateProviderUnavailableError,
  ThermostatStateProvider,
  ThermostatStateSnapshot,
} from './stateProvider.js';

/** Base URL of the PRO1 Connect app-cloud REST API. */
const API_BASE_URL = 'https://api.pro1iaq.com';

/** Timeout for all app-cloud HTTP requests. */
const HTTP_TIMEOUT_MS = 10_000;

/** Access-token safety margin: refresh when closer than 60s to expiry. */
const TOKEN_EXPIRY_MARGIN_MS = 60_000;

/** Cognito user pool / app client constants (from the PRO1 Connect app). */
const COGNITO_POOL_DATA = {
  UserPoolId: 'us-west-2_oplIqH10t',
  ClientId: '7j9nbbjq21320p3borim8t41er',
} as const;

/** Configuration for the app-cloud provider. */
export interface AppCloudProviderConfig {
  /** PRO1 Connect account email (used for Cognito SRP login). */
  email: string;
  /** PRO1 Connect account password (used for Cognito SRP login). */
  password: string;
  /** Thermostat ID override; default 'discover' resolves via the account device list. */
  thingId?: string;
}

/** Raw shadow state fields returned by the app-cloud API (Fahrenheit). */
interface ShadowState {
  at?: number; // ambient temperature (F)
  hs?: number; // heat setpoint (F)
  cs?: number; // cool setpoint (F)
  sys?: number; // 0=off 1=heat 2=cool 3=auto
  fan?: number; // fan mode
  hum?: number; // humidity
}

/** Shadow payload nested inside a thing's response. */
interface ShadowResponse {
  state?: {
    reported?: ShadowState;
    desired?: ShadowState;
  } & Partial<ShadowState>; // flat fallback
}

/** One entry of the account device list. */
interface ThingListItem {
  thingId?: string;
  thingName?: string;
  shadow?: ShadowResponse;
}

/** Generic app-cloud response envelope; `data` may be base64-wrapped. */
interface AppCloudResponse<T> {
  statusCode?: number;
  success?: boolean;
  data?: T | string;
  things?: T;
}

/**
 * PROVISIONAL sys → HomeKit target mode map (mirrors cloudStateProvider).
 * Real device observation showed sys=1 during heat demand; off/cool/auto
 * behavior is not yet verified.
 */
const SYS_TO_TARGET_MODE: Readonly<Record<number, 0 | 1 | 2 | 3 | null>> = {
  0: 0, // OFF
  1: 2, // COOL (verified live: Home Cool -> device sys=1)
  2: 1, // HEAT (verified live: Home Heat -> device sys=2)
  3: 3, // AUTO
};

/**
 * PROVISIONAL sys → HomeKit current mode map (mirrors cloudStateProvider).
 * Verified live on the T855iSHv2: sys=1 = COOL, sys=2 = HEAT (inverted vs
 * the T705 convention). Off and auto report null until verified.
 */
const SYS_TO_CURRENT_MODE: Readonly<Record<number, 0 | 1 | 2 | 3 | null>> = {
  1: 2, // COOL
  2: 1, // HEAT
};

/** PROVISIONAL HomeKit target mode → sys map (mirrors cloudStateProvider). */
const HOMEKIT_TO_SYS: Readonly<Record<0 | 1 | 2 | 3, number>> = {
  0: 0, // OFF
  1: 2, // HEAT -> sys 2 (verified live)
  2: 1, // COOL -> sys 1 (verified live)
  3: 3, // AUTO
};

/** Fahrenheit → Celsius, rounded to 2 decimals (mirrors cloudStateProvider). */
function fahrenheitToCelsius(fahrenheit: number): number {
  return Math.round((((fahrenheit - 32) * 5) / 9) * 100) / 100;
}

/** Celsius → Fahrenheit, rounded to 1 decimal (mirrors cloudStateProvider). */
function celsiusToFahrenheit(celsius: number): number {
  return Math.round(((celsius * 9) / 5 + 32) * 10) / 10;
}

/**
 * A ThermostatStateProvider backed by the PRO1 Connect app-cloud REST API.
 *
 * Credentials are supplied via {@link AppCloudProviderConfig}; login is lazy
 * (first `readState()`/command triggers Cognito SRP auth) and the token cache
 * lives only in memory for the lifetime of this provider instance.
 */
export class AppCloudStateProvider implements ThermostatStateProvider {
  private readonly config: AppCloudProviderConfig;
  private readonly log: Logging;
  private readonly cognitoUser: CognitoUser;
  private session: CognitoUserSession | null = null;
  private accessTokenExpiryMs = 0;
  private thingId: string | null = null;

  constructor(config: AppCloudProviderConfig, log: Logging) {
    this.config = config;
    this.log = log;
    this.cognitoUser = new CognitoUser({
      Username: config.email,
      Pool: new CognitoUserPool(COGNITO_POOL_DATA),
    });
  }

  /**
   * Read the current shadow state from the app-cloud API.
   *
   * @throws {StateProviderUnavailableError} when login, discovery, or the
   *   thermostat GET fails, or the response has no readable shadow.
   */
  public async readState(): Promise<ThermostatStateSnapshot> {
    const thingId = await this.resolveThingId();
    const body = await this.apiGet<ShadowResponse>(`/v3/thermostats/${encodeURIComponent(thingId)}`);
    const shadow = this.extractShadow(body);
    return this.convertShadowToSnapshot(shadow, Date.now());
  }

  /**
   * Set the target temperature for the currently active mode. The mode is
   * read from the shadow first so a cool-mode setpoint change only touches
   * `cs` (and heat only `hs`); auto writes both. Off throws — there is no
   * meaningful setpoint while the thermostat is off.
   *
   * @throws {StateProviderUnavailableError} when the thermostat is off or
   *   any API exchange fails.
   */
  public async setTargetTemperature(targetTemperatureCelsius: number): Promise<void> {
    const thingId = await this.resolveThingId();
    const snapshot = await this.readShadowState(thingId);
    const mode = snapshot.targetHeatingCoolingState;
    const fahrenheit = celsiusToFahrenheit(targetTemperatureCelsius);

    let desired: Record<string, unknown>;
    if (mode === 2) {
      // COOL → cool setpoint only
      desired = { cs: fahrenheit };
    } else if (mode === 3) {
      // AUTO → both setpoints (HomeKit single-setpoint convention)
      desired = { hs: fahrenheit, cs: fahrenheit };
    } else if (mode === 1) {
      // HEAT → heat setpoint only
      desired = { hs: fahrenheit };
    } else {
      // OFF / unknown mode → cannot command a setpoint
      throw new StateProviderUnavailableError(
        'App cloud setTargetTemperature failed: thermostat is off (sys=0); cannot set a target temperature',
      );
    }

    await this.writeShadow(thingId, desired);
  }

  /**
   * Set the target mode via the device `sys` field. Mode map is
   * provisional — verify off/cool/auto behavior against the device.
   *
   * @throws {StateProviderUnavailableError} when the shadow write fails.
   */
  public async setTargetHeatingCoolingState(targetHeatingCoolingState: 0 | 1 | 2 | 3): Promise<void> {
    const thingId = await this.resolveThingId();
    await this.writeShadow(thingId, { sys: HOMEKIT_TO_SYS[targetHeatingCoolingState] });
  }

  /**
   * Return a cached session when its access token is still valid (60s
   * safety margin); otherwise refresh via the refresh token, falling back
   * to a full SRP login when refresh fails.
   *
   * @throws {StateProviderUnavailableError} when login ultimately fails.
   */
  private async ensureSession(): Promise<CognitoUserSession> {
    if (this.session !== null && Date.now() < this.accessTokenExpiryMs - TOKEN_EXPIRY_MARGIN_MS) {
      return this.session;
    }
    if (this.session === null) {
      return await this.login();
    }
    try {
      return await this.refreshSession();
    } catch (error) {
      this.log.warn(`AppCloudStateProvider: token refresh failed (${this.sanitizeError(error)}); re-authenticating`);
      return await this.login();
    }
  }

  /**
   * Full SRP login via Cognito `authenticateUser` (callback-based), wrapped
   * in a Promise. Caches the session and its access-token expiry on success.
   *
   * @throws {StateProviderUnavailableError} with a sanitized message on any
   *   auth failure.
   */
  private async login(): Promise<CognitoUserSession> {
    const authenticationDetails = new AuthenticationDetails({
      Username: this.config.email,
      Password: this.config.password,
    });

    try {
      const session = await new Promise<CognitoUserSession>((resolve, reject) => {
        this.cognitoUser.authenticateUser(authenticationDetails, {
          onSuccess: (result: CognitoUserSession): void => {
            resolve(result);
          },
          onFailure: (err: unknown): void => {
            reject(err instanceof Error ? err : new Error(String(err)));
          },
        });
      });
      this.cacheSession(session);
      return session;
    } catch (error) {
      throw new StateProviderUnavailableError(`App cloud login failed: ${this.sanitizeError(error)}`);
    }
  }

  /**
   * Refresh the cached session via its refresh token.
   *
   * @throws {Error} when there is no cached session or refresh fails (caller
   *   falls back to a full SRP login).
   */
  private async refreshSession(): Promise<CognitoUserSession> {
    if (this.session === null) {
      throw new Error('cannot refresh without a cached session');
    }
    const refreshToken = this.session.getRefreshToken();
    const session = await new Promise<CognitoUserSession>((resolve, reject) => {
      this.cognitoUser.refreshSession(refreshToken, (err: unknown, refreshed: CognitoUserSession) => {
        if (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        resolve(refreshed);
      });
    });
    this.cacheSession(session);
    return session;
  }

  /** Cache a session and derive the access-token expiry (epoch seconds → ms). */
  private cacheSession(session: CognitoUserSession): void {
    this.session = session;
    const payload = session.getAccessToken().decodePayload();
    const exp = typeof payload.exp === 'number' ? payload.exp : Number(payload.exp);
    this.accessTokenExpiryMs = Number.isFinite(exp) ? exp * 1000 : Date.now() + TOKEN_EXPIRY_MARGIN_MS;
  }

  /**
   * Resolve the REST thingId: use `config.thingId` when set (and not
   * 'discover'), otherwise discover it from the account device list using
   * the Cognito `sub` claim as ownerId. The resolved id is cached.
   *
   * @throws {StateProviderUnavailableError} when discovery fails.
   */
  private async resolveThingId(): Promise<string> {
    const configured = this.config.thingId;
    if (configured !== undefined && configured !== '' && configured !== 'discover') {
      return configured;
    }
    if (this.thingId !== null) {
      return this.thingId;
    }

    const session = await this.ensureSession();
    const sub = session.getIdToken().decodePayload().sub;
    if (typeof sub !== 'string' || sub === '') {
      throw new StateProviderUnavailableError('App cloud discovery failed: id token has no sub claim');
    }

    const body = await this.apiGet<ThingListItem[]>(
      `/v3/thermostats?ownerId=${encodeURIComponent(sub)}&sortFilter=thingName`,
    );
    const things = body.things;
    const first = Array.isArray(things) ? things[0] : undefined;
    const found = first?.thingName;
    if (typeof found !== 'string' || found === '') {
      throw new StateProviderUnavailableError('App cloud discovery failed: device list has no thingId');
    }

    this.thingId = found;
    return found;
  }

  /** GET an app-cloud endpoint with the cached access token. */
  private async apiGet<T>(path: string): Promise<AppCloudResponse<T>> {
    return await this.apiRequest<T>('GET', path);
  }

  /** PUT an app-cloud endpoint with the cached access token. */
  private async apiPut<T>(path: string, body?: Record<string, unknown>): Promise<AppCloudResponse<T>> {
    return await this.apiRequest<T>('PUT', path, body);
  }

  /**
   * Shared HTTP helper: ensure a session, send the request with the access
   * token in the `jwt` header, check the HTTP status, parse the JSON body,
   * and unwrap base64-wrapped `data` fields.
   *
   * @throws {StateProviderUnavailableError} on network failure, HTTP status
   *   >= 300, or unparseable bodies.
   */
  private async apiRequest<T>(
    method: 'GET' | 'PUT',
    path: string,
    body?: Record<string, unknown>,
  ): Promise<AppCloudResponse<T>> {
    const session = await this.ensureSession();
    const headers: Record<string, string> = {
      jwt: session.getAccessToken().getJwtToken(),
      'Content-Type': 'application/json',
    };
    const requestInit: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    };
    if (body !== undefined) {
      requestInit.body = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await fetch(`${API_BASE_URL}${path}`, requestInit);
    } catch (error) {
      throw new StateProviderUnavailableError(
        `App cloud ${method} ${path} failed: ${this.sanitizeError(error)}`,
      );
    }

    if (response.status >= 300) {
      this.log.debug(`AppCloudStateProvider: ${method} ${path} returned HTTP ${response.status}`);
      throw new StateProviderUnavailableError(`App cloud ${method} ${path} returned HTTP ${response.status}`);
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch (error) {
      throw new StateProviderUnavailableError(
        `App cloud ${method} ${path} returned a non-JSON body: ${this.sanitizeError(error)}`,
      );
    }

    return this.unwrapBase64Data(parsed) as unknown as AppCloudResponse<T>;
  }

  /**
   * The API base64-wraps the JSON payload for some endpoints: the envelope
   * `data` field is a base64 string of the real JSON. Decode it in place;
   * leave non-string `data` fields untouched.
   *
   * @throws {StateProviderUnavailableError} when the body is not an object.
   */
  private unwrapBase64Data(parsed: unknown): AppCloudResponse<unknown> {
    if (typeof parsed !== 'object' || parsed === null) {
      throw new StateProviderUnavailableError('App cloud returned a non-object response body');
    }
    const response = parsed as Record<string, unknown>;
    const data = response.data;
    if (typeof data !== 'string') {
      return response as unknown as AppCloudResponse<unknown>;
    }
    const decoded = Buffer.from(data, 'base64').toString('utf8');
    let decodedData: unknown = decoded;
    try {
      decodedData = JSON.parse(decoded) as unknown;
    } catch {
      // Decoded payload is not JSON — keep the raw decoded string as data.
    }
    response.data = decodedData;
    return response as unknown as AppCloudResponse<unknown>;
  }

  /**
   * Extract the shadow state object from a thermostat detail response,
   * preferring `state.reported`, then `state.desired`, then a flat state.
   *
   * @throws {StateProviderUnavailableError} when the response has no shadow.
   */
  private extractShadow(body: AppCloudResponse<unknown>): Record<string, unknown> {
    const data = body.data;
    if (typeof data !== 'object' || data === null) {
      throw new StateProviderUnavailableError('App cloud read failed: response data is missing');
    }
    const shadow = (data as Record<string, unknown>).shadow;
    if (typeof shadow !== 'object' || shadow === null) {
      throw new StateProviderUnavailableError('App cloud read failed: response has no shadow');
    }
    const state = (shadow as Record<string, unknown>).state;
    if (typeof state !== 'object' || state === null) {
      throw new StateProviderUnavailableError('App cloud read failed: shadow has no state');
    }
    const stateObject = state as Record<string, unknown>;
    const reported = stateObject.reported;
    const desired = stateObject.desired;
    if (typeof reported === 'object' && reported !== null) {
      return reported as Record<string, unknown>;
    }
    if (typeof desired === 'object' && desired !== null) {
      return desired as Record<string, unknown>;
    }
    return stateObject;
  }

  /**
   * Read the raw shadow state for a known thingId and convert it to a
   * snapshot. Shared by readState() and setTargetTemperature().
   */
  private async readShadowState(thingId: string): Promise<ThermostatStateSnapshot> {
    const body = await this.apiGet<ShadowResponse>(`/v3/thermostats/${encodeURIComponent(thingId)}`);
    const shadow = this.extractShadow(body);
    return this.convertShadowToSnapshot(shadow, Date.now());
  }

  /**
   * Write shadow fields via PUT /v3/shadow (payload in the URL-encoded
   * `shadowNewValue` query parameter, per the verified API protocol).
   *
   * @throws {StateProviderUnavailableError} when the API does not confirm
   *   `success === true`.
   */
  private async writeShadow(thingId: string, desired: Record<string, unknown>): Promise<void> {
    const path = `/v3/shadow?thingId=${encodeURIComponent(thingId)}&shadowNewValue=${encodeURIComponent(
      JSON.stringify(desired),
    )}`;
    const body = await this.apiPut<unknown>(path);
    if (body.success !== true) {
      throw new StateProviderUnavailableError('App cloud write failed: API did not confirm success');
    }
  }

  /**
   * Convert a raw shadow state object into a ThermostatStateSnapshot
   * (same mapping logic as CloudStateProvider). HomeKit exposes a single
   * TargetTemperature, so the setpoint for the active mode is chosen: cool
   * uses the cool setpoint, auto shows whichever stage is calling.
   */
  private convertShadowToSnapshot(
    state: Record<string, unknown>,
    readTimestampMs: number,
  ): ThermostatStateSnapshot {
    const numberOrNull = (value: unknown): number | null =>
      typeof value === 'number' && Number.isFinite(value) ? value : null;

    const at = numberOrNull(state.at);
    const hs = numberOrNull(state.hs);
    const cs = numberOrNull(state.cs);
    const sys = numberOrNull(state.sys);
    const hum = numberOrNull(state.hum);

    const mode = sys === null ? null : (SYS_TO_TARGET_MODE[sys] ?? null);

    let targetFahrenheit: number | null = hs;
    if (mode === 2) {
      targetFahrenheit = cs;
    } else if (mode === 3 && cs !== null && at !== null && at >= cs) {
      targetFahrenheit = cs;
    }

    return {
      currentTemperatureCelsius: at === null ? null : fahrenheitToCelsius(at),
      targetTemperatureCelsius: targetFahrenheit === null ? null : fahrenheitToCelsius(targetFahrenheit),
      currentHeatingCoolingState: sys === null ? null : (SYS_TO_CURRENT_MODE[sys] ?? null),
      targetHeatingCoolingState: mode,
      currentRelativeHumidityPercent: hum,
      isOnline: true,
      readTimestampMs,
    };
  }

  /**
   * Sanitize an error message before logging or surfacing it: redact the
   * configured password and email (Cognito errors can echo the username).
   */
  private sanitizeError(error: unknown): string {
    let sanitized = error instanceof Error ? error.message : String(error);
    if (this.config.password !== '') {
      sanitized = sanitized.split(this.config.password).join('[REDACTED]');
    }
    if (this.config.email !== '') {
      sanitized = sanitized.split(this.config.email).join('[REDACTED]');
    }
    return sanitized;
  }
}
