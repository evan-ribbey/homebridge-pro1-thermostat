import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import mqtt from 'mqtt';

import {
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

const AWS_IOT_ROOT_CA = readFileSync(
  resolveCertPath(),
  'utf8',
);

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
 * PROVISIONAL sys → HomeKit target mode map (verify against device).
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
 * PROVISIONAL sys → HomeKit current mode map (verify against device).
 * Verified live on the T855iSHv2: sys=1 = COOL, sys=2 = HEAT (inverted vs
 * the T705 convention). Off and auto report null until verified.
 */
const SYS_TO_CURRENT_MODE: Readonly<Record<number, 0 | 1 | 2 | 3 | null>> = {
  1: 2, // COOL
  2: 1, // HEAT
};

/** PROVISIONAL HomeKit target mode → sys map (verify against device). */
const HOMEKIT_TO_SYS: Readonly<Record<0 | 1 | 2 | 3, number>> = {
  0: 0, // OFF
  1: 2, // HEAT -> sys 2 (verified live)
  2: 1, // COOL -> sys 1 (verified live)
  3: 3, // AUTO
};

/** Fahrenheit → Celsius, rounded to 2 decimals. */
function fahrenheitToCelsius(fahrenheit: number): number {
  return Math.round((((fahrenheit - 32) * 5) / 9) * 100) / 100;
}

/** Celsius → Fahrenheit, rounded to 1 decimal. */
function celsiusToFahrenheit(celsius: number): number {
  return Math.round(((celsius * 9) / 5 + 32) * 10) / 10;
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
    await this.getProvisioning();
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
    const snapshot = await this.shadowGet();
    const mode = snapshot.targetHeatingCoolingState;

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
      ca: AWS_IOT_ROOT_CA,
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
    const reported = stateObject.reported;
    const desired = stateObject.desired;
    const flatState =
      typeof reported === 'object' && reported !== null
        ? (reported as Record<string, unknown>)
        : typeof desired === 'object' && desired !== null
          ? (desired as Record<string, unknown>)
          : stateObject;
    return this.convertShadowToSnapshot(flatState, Date.now());
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

        const fail = (message: string): void => {
          if (settled) {
            return;
          }
          settled = true;
          this.log?.error(`CloudStateProvider: ${message}`);
          reject(new StateProviderUnavailableError(message));
        };

        const timer = setTimeout(() => {
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
          clearTimeout(timer);
          try {
            const parsed: unknown = JSON.parse(payload.toString('utf8'));
            if (typeof parsed !== 'object' || parsed === null) {
              fail(`Malformed ${operation} accepted payload: expected JSON object`);
              return;
            }
            settled = true;
            resolve(parsed as Record<string, unknown>);
          } catch (error) {
            fail(`Malformed ${operation} accepted payload: ${error instanceof Error ? error.message : String(error)}`);
          }
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
    const numberOrNull = (value: unknown): number | null =>
      typeof value === 'number' && Number.isFinite(value) ? value : null;

    const at = numberOrNull(state.at);
    const hs = numberOrNull(state.hs);
    const cs = numberOrNull(state.cs);
    const sys = numberOrNull(state.sys);
    const hum = numberOrNull(state.hum);

    const mode = sys === null ? null : (SYS_TO_TARGET_MODE[sys] ?? null);

    // HomeKit exposes a single TargetTemperature, so pick the setpoint for the
    // active mode: cool uses the cool setpoint, auto shows whichever stage is
    // actually calling, everything else uses the heat setpoint.
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
}
