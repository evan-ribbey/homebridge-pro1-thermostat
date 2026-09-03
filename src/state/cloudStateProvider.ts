import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import mqtt from 'mqtt';

import {
  HOMEKIT_TO_SYS,
  SYS_TO_TARGET_MODE,
  FAN_MODE_TO_VALUE,
  celsiusToFahrenheit,
  deriveCurrentState,
  fahrenheitToCelsius,
  fanValueToMode,
  numberOrNull,
  selectTargetSetpointF,
} from './modeMap.js';
import {
  FanMode,
  ThermostatStateProvider,
  ThermostatStateSnapshot,
  StateProviderUnavailableError,
} from './stateProvider.js';

/**
 * Trust anchor for the legacy AWS IoT data endpoints
 * (`data.iot.<region>.amazonaws.com`), which still present the Symantec /
 * VeriSign chain. Modern system CA stores (and Node) no longer ship the
 * VeriSign Class 3 G5 root, so the plugin bundles it.
 */
/**
 * Resolve the bundled root CA across the source (`src/state/`), main build
 * (`dist/state/`) and test build (`dist-test/src/state/`) directory layouts.
 */
function resolveCertPath(): URL {
  const candidates = [
    new URL('../../certs/aws-iot-classic-root.pem', import.meta.url),
    new URL('../../../certs/aws-iot-classic-root.pem', import.meta.url),
  ];
  const found = candidates.find((candidate) => existsSync(fileURLToPath(candidate)));
  if (!found) {
    throw new Error('Could not locate certs/aws-iot-classic-root.pem relative to module');
  }
  return found;
}

/**
 * Read the bundled root CA lazily and memoize it. Reading at module load meant
 * a missing/unreadable cert threw while importing the barrel, taking the local
 * and app-cloud providers down with it even though neither uses the cert.
 */
let awsIotRootCa: string | null = null;
function getAwsIotRootCa(): string {
  awsIotRootCa ??= readFileSync(resolveCertPath(), 'utf8');
  return awsIotRootCa;
}

/**
 * Minimal MQTT client surface used by CloudStateProvider. This is a
 * structural subset of mqtt.MqttClient so tests can inject fakes.
 */
export interface MqttClient {
  on(event: 'connect', cb: () => void): this;
  on(event: 'message', cb: (topic: string, payload: Buffer) => void): this;
  on(event: 'error', cb: (err: Error) => void): this;
  subscribe(topic: string, cb?: (err?: Error) => void): this;
  publish(topic: string, payload: string | Buffer, cb?: (err?: Error) => void): this;
  end(force?: boolean, cb?: () => void): this;
}

/** Factory seam for test injection. Default wraps mqtt.connect. */
export type MqttClientFactory = (options: Record<string, unknown>) => MqttClient;

/** Minimal logger surface accepted by CloudStateProvider (e.g. homebridge Logger). */
interface StateProviderLogger {
  debug: (msg: string, ...args: unknown[]) => void;
  info: (msg: string, ...args: unknown[]) => void;
  warn: (msg: string, ...args: unknown[]) => void;
  error: (msg: string, ...args: unknown[]) => void;
}

/** AWS IoT credentials self-provisioned from the device's local HTTP API. */
interface AwsIotProvisioning {
  thing: string;
  region: string;
  certPem: string;
  keyPem: string;
}

interface ProvisioningCache {
  provisioning: AwsIotProvisioning;
  fetchedAtMs: number;
}

/** Timeout for MQTT connect and shadow acceptance waits. */
const MQTT_TIMEOUT_MS = 5000;

/**
 * How long the mode read by a poll may be reused for a setpoint write before
 * re-reading. Kept well under the 60s minimum cloud polling interval so the
 * cached value is always from the most recent poll.
 */
const MODE_CACHE_TTL_MS = 45_000;

/** Shadow keys this provider commands, and therefore may need to clear. */
const MANAGED_DESIRED_KEYS = ['hs', 'cs', 'sys', 'fan'] as const;

/** Narrow an unknown shadow branch to a plain object, or null. */
function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/**
 * A ThermostatStateProvider backed by the Pro1's AWS IoT Classic Shadow,
 * driven over MQTT in poll mode: each operation opens one short-lived
 * connection, exchanges a single shadow message, then disconnects.
 *
 * AWS IoT credentials are self-provisioned from the device's local HTTP
 * API (unauthenticated on this firmware):
 *   GET /aws_iot/thing, /aws_iot/region, /aws_iot/pubCert, /aws_iot/privKey
 *
 * AWS IoT enforces a single connection per policy, so connecting kicks the
 * device's own cloud link; poll mode (connect → one message → disconnect)
 * keeps disruptions short (typically 1–2 seconds).
 */
export class CloudStateProvider implements ThermostatStateProvider {
  private readonly baseUrl: string;
  private readonly mqttConnect: MqttClientFactory;
  private readonly log?: StateProviderLogger;
  private provisioningCache: ProvisioningCache | null = null;
  /** Mode observed by the most recent shadow read, for setpoint writes. */
  private lastKnownMode: { mode: 0 | 1 | 2 | 3 | null; readAtMs: number } | null = null;

  constructor(
    deviceHost: string,
    devicePort: number = 80,
    log?: StateProviderLogger,
    mqttFactory?: MqttClientFactory,
  ) {
    this.baseUrl = `http://${deviceHost}:${devicePort}`;
    this.mqttConnect = mqttFactory ?? ((options) => mqtt.connect(options) as unknown as MqttClient);
    this.log = log;
  }

  /**
   * Read the current shadow state over a single short-lived connection.
   *
   * @throws {StateProviderUnavailableError} when provisioning or the
   *   shadow/get exchange fails.
   */
  public async readState(): Promise<ThermostatStateSnapshot> {
    // connectAndWaitForMessage() provisions before it opens a client, so
    // there is no need to force it first.
    return await this.shadowGet();
  }

  /**
   * Set the target temperature for the currently active mode. The mode is
   * read from the shadow first so a cool-mode setpoint change only touches
   * `cs` (and heat only `hs`), rather than silently rewriting both.
   *
   * @throws {StateProviderUnavailableError} when the shadow exchanges fail.
   */
  public async setTargetTemperature(targetTemperatureCelsius: number): Promise<void> {
    const fahrenheit = celsiusToFahrenheit(targetTemperatureCelsius);
    const mode = await this.getTargetModeForWrite();

    if (mode === 2) {
      // COOL → cool setpoint only
      await this.shadowUpdate({ desired: { cs: fahrenheit } });
    } else if (mode === 3) {
      // AUTO → both setpoints (HomeKit single-setpoint convention)
      await this.shadowUpdate({ desired: { hs: fahrenheit, cs: fahrenheit } });
    } else {
      // OFF / HEAT / unknown → heat setpoint only
      await this.shadowUpdate({ desired: { hs: fahrenheit } });
    }
  }

  /**
   * Set the target mode via the device `sys` field. Mode map is
   * provisional — verify off/cool/auto behavior against the device.
   *
   * @throws {StateProviderUnavailableError} when the shadow/update exchange fails.
   */
  public async setTargetHeatingCoolingState(targetHeatingCoolingState: 0 | 1 | 2 | 3): Promise<void> {
    await this.shadowUpdate({ desired: { sys: HOMEKIT_TO_SYS[targetHeatingCoolingState] } });
    // The commanded mode is now the one a following setpoint write should use.
    this.lastKnownMode = { mode: targetHeatingCoolingState, readAtMs: Date.now() };
  }

  /**
   * Set the fan mode via the device `fan` field (0=on, 1=auto; verified
   * live, see FAN_MODE_TO_VALUE).
   *
   * @throws {StateProviderUnavailableError} when the shadow/update exchange fails.
   */
  public async setFanMode(fanMode: FanMode): Promise<void> {
    await this.shadowUpdate({ desired: { fan: FAN_MODE_TO_VALUE[fanMode] } });
  }

  /**
   * The active mode, needed to decide whether a setpoint write touches `hs`
   * or `cs`. Reuses the mode from a recent poll when one is available.
   *
   * Every MQTT exchange briefly displaces the thermostat's own cloud
   * connection, so a setpoint change that always did get-then-update
   * interrupted the device twice. Polling has usually just read the mode
   * anyway — and it is the same value the user is looking at in the Home app,
   * since that is what was last pushed to HomeKit. The cache is only trusted
   * for MODE_CACHE_TTL_MS; beyond that it re-reads.
   */
  private async getTargetModeForWrite(): Promise<0 | 1 | 2 | 3 | null> {
    const cached = this.lastKnownMode;
    if (cached !== null && Date.now() - cached.readAtMs < MODE_CACHE_TTL_MS) {
      this.log?.debug(`CloudStateProvider: using the mode from the last poll (${cached.mode}) for this setpoint write`);
      return cached.mode;
    }
    return (await this.shadowGet()).targetHeatingCoolingState;
  }

  /**
   * Self-provision from the device's local HTTP API, caching the result
   * for the lifetime of the provider (no expiry for M2 — simplification).
   *
   * @throws {StateProviderUnavailableError} on any fetch/parse failure.
   */
  private async getProvisioning(): Promise<AwsIotProvisioning> {
    if (this.provisioningCache !== null) {
      return this.provisioningCache.provisioning;
    }
    const provisioning = await this.fetchProvisioningFromDevice();
    this.provisioningCache = { provisioning, fetchedAtMs: Date.now() };
    return provisioning;
  }

  /**
   * Fetch thing/region/cert/key from the device's local HTTP API and
   * validate them. Any failure is wrapped in StateProviderUnavailableError.
   */
  private async fetchProvisioningFromDevice(): Promise<AwsIotProvisioning> {
    try {
      const thing = this.parseJsonWrappedOrRaw(
        await this.fetchText(`${this.baseUrl}/aws_iot/thing`),
        'thing',
      );
      const region = this.parseJsonWrappedOrRaw(
        await this.fetchText(`${this.baseUrl}/aws_iot/region`),
        'region',
      );
      const certPem = this.parseJsonWrappedOrRaw(
        await this.fetchText(`${this.baseUrl}/aws_iot/pubCert`),
        'cert',
      );
      const keyPem = this.parseJsonWrappedOrRaw(
        await this.fetchText(`${this.baseUrl}/aws_iot/privKey`),
        'key',
      );

      if (thing === '' || region === '' || certPem === '' || keyPem === '') {
        throw new Error('empty provisioning value returned by device');
      }

      return { thing, region, certPem, keyPem };
    } catch (error) {
      const message = `Cloud provisioning failed: ${error instanceof Error ? error.message : String(error)}`;
      this.log?.error(`CloudStateProvider: ${message}`);
      throw new StateProviderUnavailableError(message);
    }
  }

  /** Fetch a URL and return its text body; throws on network/HTTP failure. */
  private async fetchText(url: string): Promise<string> {
    let response: Response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(MQTT_TIMEOUT_MS) });
    } catch (error) {
      throw new Error(
        `fetch failed for ${url}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    if (!response.ok) {
      throw new Error(`fetch failed for ${url}: HTTP ${response.status}`);
    }
    return await response.text();
  }

  /**
   * Defensive body parsing: the device returns either a JSON-wrapped value
   * (e.g. {"cert":"-----BEGIN CERTIFICATE-----..."}) or the raw string
   * (PEM for cert/key, plain for thing/region). Falls back to the trimmed
   * raw body when the body is not JSON or lacks the expected key.
   */
  private parseJsonWrappedOrRaw(body: string, key: string): string {
    const trimmed = body.trim();
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === 'object' && parsed !== null) {
        const value = (parsed as Record<string, unknown>)[key];
        if (typeof value === 'string') {
          return value.trim();
        }
      }
    } catch {
      // Not JSON — fall through to raw body handling below.
    }
    return trimmed;
  }

  /** Build the mqtt.connect options for AWS IoT from provisioning data. */
  private buildMqttOptions(p: AwsIotProvisioning): Record<string, unknown> {
    return {
      protocol: 'mqtts',
      host: `data.iot.${p.region}.amazonaws.com`,
      port: 8883,
      clientId: p.thing, // MUST be the exact IoT thing name
      rejectUnauthorized: true,
      connectTimeout: MQTT_TIMEOUT_MS,
      keepalive: 30,
      cert: p.certPem,
      key: p.keyPem,
      ca: getAwsIotRootCa(),
      clean: true,
    };
  }

  /**
   * shadow/get over a single short-lived connection.
   *
   * @throws {StateProviderUnavailableError} when the exchange fails or the
   *   accepted response is missing the .state object.
   */
  private async shadowGet(): Promise<ThermostatStateSnapshot> {
    const response = await this.connectAndWaitForMessage('get');
    const state: unknown = response.state;
    if (typeof state !== 'object' || state === null) {
      const message = 'shadow/get accepted response missing .state object';
      this.log?.error(`CloudStateProvider: ${message}`);
      throw new StateProviderUnavailableError(message);
    }
    const stateObject = state as Record<string, unknown>;
    // The live shadow/get payload nests values under `reported` (device state)
    // and `desired` (last commanded state). Prefer reported, fall back to
    // desired, then to a flat object for defense in depth.
    const reported = asObject(stateObject.reported);
    const desired = asObject(stateObject.desired);
    const flatState = reported ?? desired ?? stateObject;
    const snapshot = this.convertShadowToSnapshot(flatState, Date.now());
    this.lastKnownMode = { mode: snapshot.targetHeatingCoolingState, readAtMs: Date.now() };
    await this.clearSatisfiedDesired(reported, desired);
    return snapshot;
  }

  /**
   * Drop `desired` entries the device has already satisfied.
   *
   * An AWS IoT Classic Shadow keeps `desired` until it is explicitly nulled,
   * and the service publishes a delta whenever `desired` and `reported`
   * diverge. A setpoint this plugin wrote therefore lingers as a standing
   * order: change the temperature at the wall afterwards and the device gets
   * a delta putting the old value straight back — the plugin silently undoing
   * a manual adjustment.
   *
   * Clearing a desired entry that already equals `reported` cannot cancel an
   * in-flight command (an unsatisfied desired still differs from reported, so
   * it is left alone) and produces no delta of its own. In the steady state
   * there is nothing to clear and this issues no MQTT traffic at all.
   *
   * Failures here are logged and swallowed — a read must not fail because a
   * housekeeping write did.
   */
  private async clearSatisfiedDesired(
    reported: Record<string, unknown> | null,
    desired: Record<string, unknown> | null,
  ): Promise<void> {
    if (reported === null || desired === null) {
      return;
    }
    const toClear: Record<string, unknown> = {};
    for (const key of MANAGED_DESIRED_KEYS) {
      if (desired[key] !== undefined && desired[key] === reported[key]) {
        toClear[key] = null;
      }
    }
    if (Object.keys(toClear).length === 0) {
      return;
    }
    this.log?.debug(
      `CloudStateProvider: clearing satisfied shadow desired keys [${Object.keys(toClear).join(', ')}] `
      + 'so they cannot override a manual change at the thermostat',
    );
    try {
      await this.shadowUpdate({ desired: toClear });
    } catch (error) {
      this.log?.debug(
        `CloudStateProvider: could not clear satisfied desired keys: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * shadow/update over a single short-lived connection.
   *
   * @throws {StateProviderUnavailableError} when the exchange fails.
   */
  private async shadowUpdate(desired: Record<string, unknown>): Promise<void> {
    await this.connectAndWaitForMessage('update', desired);
  }

  /**
   * Shared MQTT session helper: one connection per operation (poll mode).
   * Connects, subscribes to the accepted topic, publishes the get/update
   * request, waits up to MQTT_TIMEOUT_MS for the accepted response, and
   * always disconnects via end() in finally.
   *
   * @throws {StateProviderUnavailableError} on connect/subscribe/publish
   *   errors, MQTT 'error' events, malformed payloads, or timeout.
   */
  private async connectAndWaitForMessage(
    operation: 'get' | 'update',
    desired?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const provisioning = await this.getProvisioning();
    const topicBase = `$aws/things/${provisioning.thing}/shadow`;
    const requestTopic = `${topicBase}/${operation}`;
    const acceptedTopic = `${topicBase}/${operation}/accepted`;

    let client: MqttClient;
    try {
      client = this.mqttConnect(this.buildMqttOptions(provisioning));
    } catch (error) {
      const message = `MQTT ${operation} client creation failed: ${error instanceof Error ? error.message : String(error)}`;
      this.log?.error(`CloudStateProvider: ${message}`);
      throw new StateProviderUnavailableError(message);
    }

    try {
      return await new Promise<Record<string, unknown>>((resolve, reject) => {
        let settled = false;
        let timer: NodeJS.Timeout | null = null;

        // Every exit path clears the timer. Clearing it only on the success
        // path left a live 5s timer behind after an error or timeout, holding
        // the event loop open past a rejection that had already been handled.
        const settle = (action: () => void): void => {
          if (settled) {
            return;
          }
          settled = true;
          if (timer !== null) {
            clearTimeout(timer);
            timer = null;
          }
          action();
        };

        const fail = (message: string): void => {
          settle(() => {
            this.log?.error(`CloudStateProvider: ${message}`);
            reject(new StateProviderUnavailableError(message));
          });
        };

        timer = setTimeout(() => {
          fail(`MQTT ${operation} timed out after ${MQTT_TIMEOUT_MS}ms waiting for ${acceptedTopic}`);
        }, MQTT_TIMEOUT_MS);

        client.on('connect', () => {
          if (settled) {
            return;
          }
          client.subscribe(acceptedTopic, (subscribeError?: Error | null) => {
            if (settled) {
              return;
            }
            if (subscribeError) {
              fail(`MQTT subscribe failed for ${acceptedTopic}: ${subscribeError.message}`);
              return;
            }
            const payload = operation === 'get' ? '' : JSON.stringify({ state: desired });
            client.publish(requestTopic, payload, (publishError?: Error | null) => {
              if (settled) {
                return;
              }
              if (publishError) {
                fail(`MQTT publish failed for ${requestTopic}: ${publishError.message}`);
              }
            });
          });
        });

        client.on('message', (topic: string, payload: Buffer) => {
          if (settled || topic !== acceptedTopic) {
            return;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(payload.toString('utf8'));
          } catch (error) {
            fail(`Malformed ${operation} accepted payload: ${error instanceof Error ? error.message : String(error)}`);
            return;
          }
          if (typeof parsed !== 'object' || parsed === null) {
            fail(`Malformed ${operation} accepted payload: expected JSON object`);
            return;
          }
          settle(() => resolve(parsed as Record<string, unknown>));
        });

        client.on('error', (err: Error) => {
          fail(`MQTT ${operation} error: ${err.message}`);
        });
      });
    } finally {
      client.end(true);
    }
  }

  /** Convert a raw shadow state object into a ThermostatStateSnapshot. */
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
}
