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
 * Token lifecycle (in-memory only):
 *   - First operation performs a full SRP login.
 *   - Subsequent operations reuse the cached access token until it is within
 *     60s of expiry, then transparently refresh via the refresh token.
 *   - If refresh fails, a full SRP re-login is attempted.
 *
 * SRP is implemented natively in ./cognitoSrp.ts against Node's crypto and
 * global fetch, rather than via amazon-cognito-identity-js, which dragged in
 * an end-of-life node-fetch@2 and browser polyfills.
 *
 * Security: passwords, tokens, and the account email are never logged; error
 * messages are sanitized before being surfaced or logged.
 */
import type { Logging } from 'homebridge';

import {
  CognitoSrpClient,
  decodeJwtPayload,
  type CognitoTokens,
} from './cognitoSrp.js';
import {
  HOMEKIT_TO_SYS,
  SYS_TO_TARGET_MODE,
  FAN_MODE_TO_VALUE,
  celsiusToWholeFahrenheit,
  deriveCurrentState,
  fahrenheitToCelsius,
  fanValueToMode,
  numberOrNull,
  selectTargetSetpointF,
} from './modeMap.js';
import {
  FanMode,
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
  sys?: number; // 0=off 1=cool 2=heat 3=auto — verified live, see SYS_TO_TARGET_MODE
  fan?: number; // 0=on (continuous) 1=auto — verified live, see FAN_MODE_TO_VALUE
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
 * Assumed lifetime for an access token whose payload carries no usable `exp`.
 * Cognito access tokens are an hour by default; 15 minutes is conservative
 * without being so short that it churns.
 */
const ASSUMED_TOKEN_LIFETIME_MS = 15 * 60_000;

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
  private readonly cognito: CognitoSrpClient;
  private tokens: CognitoTokens | null = null;
  /** Kept separately: a refresh response does not reissue the refresh token. */
  private refreshToken: string | null = null;
  private accessTokenExpiryMs = 0;
  private thingId: string | null = null;

  /**
   * @param srpClient Test seam; defaults to a client for the PRO1 user pool.
   */
  constructor(config: AppCloudProviderConfig, log: Logging, srpClient?: CognitoSrpClient) {
    this.config = config;
    this.log = log;
    this.cognito = srpClient
      ?? new CognitoSrpClient(COGNITO_POOL_DATA.UserPoolId, COGNITO_POOL_DATA.ClientId);
  }

  /**
   * Read the current shadow state from the app-cloud API.
   *
   * @throws {StateProviderUnavailableError} when login, discovery, or the
   *   thermostat GET fails, or the response has no readable shadow.
   */
  public async readState(): Promise<ThermostatStateSnapshot> {
    return await this.readShadowState(await this.resolveThingId());
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
    const fahrenheit = celsiusToWholeFahrenheit(targetTemperatureCelsius);

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
   * Set the fan mode via the device `fan` field (0=on, 1=auto; verified
   * live, see FAN_MODE_TO_VALUE).
   *
   * @throws {StateProviderUnavailableError} when the shadow write fails.
   */
  public async setFanMode(fanMode: FanMode): Promise<void> {
    const thingId = await this.resolveThingId();
    await this.writeShadow(thingId, { fan: FAN_MODE_TO_VALUE[fanMode] });
  }

  /**
   * Return a cached session when its access token is still valid (60s
   * safety margin); otherwise refresh via the refresh token, falling back
   * to a full SRP login when refresh fails.
   *
   * @throws {StateProviderUnavailableError} when login ultimately fails.
   */
  private async ensureSession(): Promise<CognitoTokens> {
    if (this.tokens !== null && Date.now() < this.accessTokenExpiryMs - TOKEN_EXPIRY_MARGIN_MS) {
      return this.tokens;
    }
    if (this.tokens === null || this.refreshToken === null) {
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
   * Full SRP login. Caches the tokens and the access-token expiry on success.
   *
   * @throws {StateProviderUnavailableError} with a sanitized message on any
   *   auth failure.
   */
  private async login(): Promise<CognitoTokens> {
    try {
      const tokens = await this.cognito.authenticate(this.config.email, this.config.password);
      this.cacheSession(tokens);
      return tokens;
    } catch (error) {
      throw new StateProviderUnavailableError(`App cloud login failed: ${this.sanitizeError(error)}`);
    }
  }

  /**
   * Refresh the cached session via its refresh token.
   *
   * @throws {Error} when there is no refresh token or the refresh fails
   *   (caller falls back to a full SRP login).
   */
  private async refreshSession(): Promise<CognitoTokens> {
    if (this.refreshToken === null) {
      throw new Error('cannot refresh without a cached refresh token');
    }
    const tokens = await this.cognito.refresh(this.refreshToken);
    this.cacheSession(tokens);
    return tokens;
  }

  /**
   * Cache tokens and derive the access-token expiry (epoch seconds → ms).
   *
   * The fallback for a missing/unparseable `exp` must exceed the refresh
   * margin. Falling back to `now + TOKEN_EXPIRY_MARGIN_MS` made the freshness
   * check (`now < expiry - margin`) false immediately, so every single request
   * dragged a token refresh along with it.
   */
  private cacheSession(tokens: CognitoTokens): void {
    this.tokens = tokens;
    // A refresh response omits the refresh token; keep the one we have.
    this.refreshToken = tokens.refreshToken ?? this.refreshToken;

    let exp: number = Number.NaN;
    try {
      const payload = decodeJwtPayload(tokens.accessToken);
      exp = typeof payload.exp === 'number' ? payload.exp : Number(payload.exp);
    } catch {
      // Fall through to the assumed lifetime below.
    }
    // `exp` must be a positive finite number. `Number(null)` is 0, which is
    // finite — accepting it would pin the expiry to the epoch and refresh on
    // every single request.
    if (Number.isFinite(exp) && exp > 0) {
      this.accessTokenExpiryMs = exp * 1000;
      return;
    }
    this.log.debug('AppCloudStateProvider: access token has no usable exp claim; assuming a 15 minute lifetime');
    this.accessTokenExpiryMs = Date.now() + ASSUMED_TOKEN_LIFETIME_MS;
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
    const sub = decodeJwtPayload(session.idToken).sub;
    if (typeof sub !== 'string' || sub === '') {
      throw new StateProviderUnavailableError('App cloud discovery failed: id token has no sub claim');
    }

    const body = await this.apiGet<ThingListItem[]>(
      `/v3/thermostats?ownerId=${encodeURIComponent(sub)}&sortFilter=thingName`,
    );
    const things = body.things;
    if (!Array.isArray(things)) {
      throw new StateProviderUnavailableError('App cloud discovery failed: device list is not an array');
    }
    const names = things
      .map((thing) => (typeof thing?.thingName === 'string' ? thing.thingName : ''))
      .filter((name) => name !== '');
    if (names.length === 0) {
      throw new StateProviderUnavailableError('App cloud discovery failed: device list has no thingId');
    }
    // Auto-discovery can only ever pick one device. On a multi-thermostat
    // account every accessory that omits `thingId` would silently resolve to
    // this same first device and shadow each other, so say so loudly.
    if (names.length > 1) {
      this.log.warn(
        `AppCloudStateProvider: account has ${names.length} thermostats and no "thingId" is configured; `
        + `defaulting to "${names[0]}". Set "thingId" per accessory to choose deliberately. Available: ${names.join(', ')}`,
      );
    }

    this.thingId = names[0];
    return names[0];
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
      jwt: session.accessToken,
    };
    const requestInit: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    };
    if (body !== undefined) {
      // Only declare a JSON body when one is actually sent.
      headers['Content-Type'] = 'application/json';
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

    if (response.status === 401 || response.status === 403) {
      // The server rejected a token we still believe is valid (revoked, or
      // clock skew). Without this the same token was resent until its own
      // expiry, leaving the accessory "No Response" for up to an hour. Mark
      // it expired so the next request refreshes, falling back to a login.
      this.accessTokenExpiryMs = 0;
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
    const at = numberOrNull(state.at);
    const hs = numberOrNull(state.hs);
    const cs = numberOrNull(state.cs);
    const sys = numberOrNull(state.sys);
    const hum = numberOrNull(state.hum);
    const fan = numberOrNull(state.fan);

    const mode = sys === null ? null : (SYS_TO_TARGET_MODE[sys] ?? null);
    const targetFahrenheit = selectTargetSetpointF(mode, at, hs, cs);

    return {
      currentTemperatureCelsius: at === null ? null : fahrenheitToCelsius(at),
      targetTemperatureCelsius: targetFahrenheit === null ? null : fahrenheitToCelsius(targetFahrenheit),
      currentHeatingCoolingState: deriveCurrentState(sys, at, hs, cs),
      targetHeatingCoolingState: mode,
      currentRelativeHumidityPercent: hum,
      fanMode: fanValueToMode(fan),
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
    // Also strip anything shaped like a JWT. Cognito and the app-cloud API can
    // echo a token back in an error, and a leaked access token is as good as
    // the credentials until it expires.
    return sanitized.replace(/\beyJ[A-Za-z0-9_-]{4,}(?:\.[A-Za-z0-9_-]+){1,2}\b/g, '[REDACTED_TOKEN]');
  }
}
