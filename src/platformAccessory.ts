import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { Pro1ThermostatDeviceConfig, Pro1ThermostatPlatform } from './platform.js';
import {
  FanMode,
  StateProviderNotImplementedError,
  StateProviderUnavailableError,
  ThermostatStateProvider,
  ThermostatStateSnapshot,
} from './state/index.js';

// HomeKit defaults shown until the first successful poll (Celsius).
const DEFAULT_TEMPERATURE = 20;
const DEFAULT_HEATING_COOLING_STATE = 0; // Off
const DEFAULT_RELATIVE_HUMIDITY = 50;
const DEFAULT_FAN_ACTIVE = 0; // Auto

/**
 * The Fan v2 `Active` characteristic carries the Pro1 fan mode: 1 (active)
 * is the app's "On" — the blower runs continuously — and 0 (inactive) is
 * "Auto", where it runs only with a heat or cool call. The thermostat has no
 * fan-off setting, so "off" in the Home app means auto, and the tile reads
 * as "on" only while the fan is forced on.
 */
const FAN_ACTIVE_TO_MODE: Readonly<Record<0 | 1, FanMode>> = { 0: 'auto', 1: 'on' };
const FAN_MODE_TO_ACTIVE: Readonly<Record<FanMode, 0 | 1>> = { auto: 0, on: 1 };

/**
 * TargetTemperature bounds, in Celsius. HomeKit defaults to 10–38 °C, but Pro1
 * thermostats accept setpoints from roughly 45 °F (7.2 °C) — the usual freeze
 * protection / away setting. Without widening the range, HomeKit clamps such a
 * setpoint and Homebridge logs a characteristic warning on every poll.
 */
const TARGET_TEMPERATURE_MIN_C = 7;
const TARGET_TEMPERATURE_MAX_C = 35;
/** The device works in whole °F (~0.56 °C); 0.5 °C is the closest HomeKit step. */
const TARGET_TEMPERATURE_STEP_C = 0.5;

/**
 * How long a value written by the user is trusted over what polling reports.
 *
 * A shadow write can take up to ~2 minutes to come back in `reported`. Until
 * it does, polling still returns the pre-change value, and pushing that to
 * HomeKit snaps the user's adjustment back — so the Home app appears to
 * discard the change and the user makes it again. The pending value is
 * dropped as soon as the device confirms it, so this is a ceiling rather
 * than a fixed delay.
 */
const PENDING_WRITE_TTL_MS = 120_000;

/**
 * How close a polled setpoint must be to the commanded one to count as the
 * device confirming it, in Celsius. The write goes out in °F and the device
 * may keep only whole degrees, so 24 °C (75.2 °F) can come back as 75 °F
 * (23.89 °C). An exact comparison never matched in that case, so the hold ran
 * for the full window and masked any change made at the wall meanwhile.
 * Half a °F is 0.28 °C; this allows for that plus the 2-decimal rounding.
 */
const SETPOINT_CONFIRM_TOLERANCE_C = 0.3;

/**
 * Consecutive failed polls before the accessory reports "No Response" instead
 * of continuing to serve stale readings as though they were live. Three polls
 * avoids flapping on a single transient network blip.
 */
const FAILURES_BEFORE_NO_RESPONSE = 3;

/**
 * `HAPStatus.SERVICE_COMMUNICATION_FAILURE`. Spelled out as a literal because
 * homebridge exports HAPStatus as a `const enum`, which cannot be referenced
 * through a value expression. This code is fixed by the HAP specification.
 */
const HAP_STATUS_SERVICE_COMMUNICATION_FAILURE = -70402;

/** A user-commanded value awaiting confirmation from the device. */
interface PendingWrite {
  value: number;
  expiresAtMs: number;
}

/** Characteristics a user can command, and which therefore may be pending. */
type CommandedCharacteristic = 'TargetTemperature' | 'TargetHeatingCoolingState' | 'FanActive';

/**
 * Platform Accessory
 * Exposes a Pro1 thermostat as a HomeKit Thermostat service plus a Fan v2
 * service for the fan mode (see FAN_ACTIVE_TO_MODE).
 *
 * All state is read from the injected ThermostatStateProvider on a polling
 * loop (config.pollingInterval seconds) and pushed to HomeKit via
 * `updateCharacteristic`. GET handlers serve the last snapshot with sensible
 * defaults until the first poll completes.
 */
export class Pro1ThermostatAccessory {
  private readonly service: Service;
  private readonly fanService: Service;
  private readonly stateProvider: ThermostatStateProvider;
  private lastSnapshot: ThermostatStateSnapshot | null = null;
  private pollingTimer: NodeJS.Timeout | null = null;
  private readonly pollingIntervalMs: number;
  private consecutiveFailures = 0;
  /** Last value pushed per characteristic, to suppress redundant updates. */
  private readonly lastPushedValues = new Map<string, number>();
  private readonly pendingWrites = new Map<CommandedCharacteristic, PendingWrite>();
  /** Display unit preference; HomeKit owns this, the device is unaffected. */
  private temperatureDisplayUnits: CharacteristicValue = 1; // 1 = Fahrenheit

  constructor(
    private readonly platform: Pro1ThermostatPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly device: Pro1ThermostatDeviceConfig = accessory.context.device,
    stateProvider: ThermostatStateProvider,
  ) {
    this.stateProvider = stateProvider;
    this.pollingIntervalMs = (device.pollingInterval ?? 60) * 1000; // seconds → ms

    // set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Pro1 Technologies')
      .setCharacteristic(this.platform.Characteristic.Model, this.device.model ?? 'T705')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, this.device.host ?? this.device.name);

    // get the Thermostat service if it exists, otherwise create a new one
    this.service = this.accessory.getService(this.platform.Service.Thermostat)
      || this.accessory.addService(this.platform.Service.Thermostat);

    // this is what is displayed as the default name on the Home app
    this.service.setCharacteristic(this.platform.Characteristic.Name, this.device.name);

    // register handlers for the Thermostat characteristics
    this.service.getCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState)
      .onGet(this.getCurrentHeatingCoolingState.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState)
      .onGet(this.getTargetHeatingCoolingState.bind(this))
      .onSet(this.setTargetHeatingCoolingState.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(this.getCurrentTemperature.bind(this));

    const targetTemperature = this.service.getCharacteristic(this.platform.Characteristic.TargetTemperature)
      .onGet(this.getTargetTemperature.bind(this))
      .onSet(this.setTargetTemperature.bind(this));
    // setProps is absent from the lightweight characteristic stubs used in tests.
    targetTemperature.setProps?.({
      minValue: TARGET_TEMPERATURE_MIN_C,
      maxValue: TARGET_TEMPERATURE_MAX_C,
      minStep: TARGET_TEMPERATURE_STEP_C,
    });

    this.service.getCharacteristic(this.platform.Characteristic.TemperatureDisplayUnits)
      .onGet(this.getTemperatureDisplayUnits.bind(this))
      .onSet(this.setTemperatureDisplayUnits.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity)
      .onGet(this.getCurrentRelativeHumidity.bind(this));

    // Fan mode lives on a Fan v2 service; the Thermostat service has no fan characteristic.
    this.fanService = this.accessory.getService(this.platform.Service.Fanv2)
      || this.accessory.addService(this.platform.Service.Fanv2);
    this.fanService.setCharacteristic(this.platform.Characteristic.Name, `${this.device.name} Fan`);
    this.fanService.getCharacteristic(this.platform.Characteristic.Active)
      .onGet(this.getFanActive.bind(this))
      .onSet(this.setFanActive.bind(this));
  }

  /**
   * Start the polling loop: an immediate read, then periodic reads on
   * `config.pollingInterval` seconds. The timer is unref'd so polling alone
   * never keeps the Node process alive. Calling this more than once will not
   * stack timers.
   */
  public async startPolling(): Promise<void> {
    await this.pollOnce();
    if (this.pollingTimer !== null) {
      return;
    }
    this.pollingTimer = setInterval(() => {
      void this.pollOnce();
    }, this.pollingIntervalMs);
    this.pollingTimer.unref();
  }

  /** Stop the polling loop. Safe to call when polling was never started. */
  public stopPolling(): void {
    if (this.pollingTimer !== null) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }
  }

  /**
   * Read a snapshot from the provider and push it to HomeKit.
   * Never throws — provider errors are logged (debug) and last-known state
   * is retained so the accessory degrades gracefully.
   */
  private async pollOnce(): Promise<void> {
    try {
      const snapshot = await this.stateProvider.readState();
      this.lastSnapshot = snapshot;
      if (this.isUnreachable()) {
        // Coming back from "No Response": re-publish everything, since
        // controllers may have discarded the values they last saw.
        this.lastPushedValues.clear();
        this.platform.log.info(`[${this.device.name}] Reachable again; resuming updates.`);
      }
      this.consecutiveFailures = 0;
      this.pushSnapshot(snapshot);
    } catch (error) {
      if (error instanceof StateProviderUnavailableError) {
        this.consecutiveFailures += 1;
        this.platform.log.debug(
          `[${this.device.name}] Poll failed (provider unavailable): ${error.message}. `
          + `Keeping last known state (${this.consecutiveFailures} consecutive failure(s)).`,
        );
        if (this.consecutiveFailures === FAILURES_BEFORE_NO_RESPONSE) {
          this.platform.log.warn(
            `[${this.device.name}] Unreachable after ${this.consecutiveFailures} polls; reporting "No Response" `
            + 'in the Home app until contact is restored.',
          );
        }
      } else if (error instanceof StateProviderNotImplementedError) {
        this.platform.log.debug(`[${this.device.name}] Provider not implemented: ${error.message}. No state pushed.`);
        // No state to push; HomeKit will show "No Response" for this accessory.
      } else {
        this.consecutiveFailures += 1;
        this.platform.log.debug(`[${this.device.name}] Unexpected poll error: ${error instanceof Error ? error.message : String(error)}`);
      }
      // Never crash; the interval continues.
    }
  }

  /**
   * Push every non-null field of a snapshot to HomeKit via updateCharacteristic,
   * except a target the user has just changed and the device has not yet
   * confirmed — see PENDING_WRITE_TTL_MS.
   */
  private pushSnapshot(snapshot: ThermostatStateSnapshot): void {
    this.pushIfChanged('CurrentTemperature', this.platform.Characteristic.CurrentTemperature, snapshot.currentTemperatureCelsius);
    this.pushIfChanged('CurrentHeatingCoolingState', this.platform.Characteristic.CurrentHeatingCoolingState, snapshot.currentHeatingCoolingState);
    this.pushIfChanged('CurrentRelativeHumidity', this.platform.Characteristic.CurrentRelativeHumidity, snapshot.currentRelativeHumidityPercent);

    if (snapshot.targetTemperatureCelsius !== null
      && !this.isSupersededByPendingWrite('TargetTemperature', snapshot.targetTemperatureCelsius)) {
      this.pushIfChanged('TargetTemperature', this.platform.Characteristic.TargetTemperature, snapshot.targetTemperatureCelsius);
    }
    if (snapshot.targetHeatingCoolingState !== null
      && !this.isSupersededByPendingWrite('TargetHeatingCoolingState', snapshot.targetHeatingCoolingState)) {
      this.pushIfChanged('TargetHeatingCoolingState', this.platform.Characteristic.TargetHeatingCoolingState, snapshot.targetHeatingCoolingState);
    }
    if (snapshot.fanMode !== null) {
      const active = FAN_MODE_TO_ACTIVE[snapshot.fanMode];
      if (!this.isSupersededByPendingWrite('FanActive', active)) {
        this.pushIfChanged('FanActive', this.platform.Characteristic.Active, active, this.fanService);
      }
    }
  }

  /**
   * Push a value only when it differs from the last one pushed.
   *
   * A thermostat is mostly idle, so re-sending all five characteristics on
   * every poll produced a steady stream of identical HAP change events to
   * every subscribed controller, plus matching Homebridge log noise, for no
   * new information. Null (unknown) is never pushed and never remembered, so
   * a value reappearing after a gap is always sent.
   */
  private pushIfChanged(
    key: string,
    characteristic: Parameters<Service['updateCharacteristic']>[0],
    value: number | null,
    service: Service = this.service,
  ): void {
    if (value === null || this.lastPushedValues.get(key) === value) {
      return;
    }
    this.lastPushedValues.set(key, value);
    service.updateCharacteristic(characteristic, value);
  }

  /**
   * Decide whether a polled value should be withheld because the user has
   * commanded a different one that the device has not acknowledged yet.
   * Clears the pending write once the device agrees or the window lapses.
   *
   * @returns true when the polled value must not be pushed to HomeKit.
   */
  private isSupersededByPendingWrite(
    characteristic: CommandedCharacteristic,
    polledValue: number,
  ): boolean {
    const pending = this.readPendingWrite(characteristic);
    if (pending === null) {
      return false;
    }
    const confirmed = characteristic === 'TargetTemperature'
      ? Math.abs(pending.value - polledValue) <= SETPOINT_CONFIRM_TOLERANCE_C
      : pending.value === polledValue;
    if (confirmed) {
      // The device has caught up; stop overriding.
      this.setPendingWrite(characteristic, null);
      return false;
    }
    this.platform.log.debug(
      `[${this.device.name}] Holding ${characteristic} at the commanded ${pending.value}; `
      + `device still reports ${polledValue}.`,
    );
    return true;
  }

  /** Read a pending write, expiring it if the window has elapsed. */
  private readPendingWrite(characteristic: CommandedCharacteristic): PendingWrite | null {
    const pending = this.pendingWrites.get(characteristic);
    if (pending === undefined) {
      return null;
    }
    if (Date.now() >= pending.expiresAtMs) {
      this.platform.log.debug(
        `[${this.device.name}] ${characteristic} was not confirmed by the device within `
        + `${PENDING_WRITE_TTL_MS / 1000}s; deferring to the device from now on.`,
      );
      this.setPendingWrite(characteristic, null);
      return null;
    }
    return pending;
  }

  /**
   * Record a value the user just commanded from the Home app.
   *
   * HomeKit already holds that value, so it also becomes the "last pushed"
   * value. Without this, the dedupe in pushIfChanged still remembered the
   * pre-command reading: if the device never applied the command, the
   * unchanged reading was skipped as a duplicate once the hold lapsed, and
   * HomeKit kept showing the commanded value indefinitely.
   */
  private recordCommand(characteristic: CommandedCharacteristic, value: number): void {
    this.setPendingWrite(characteristic, { value, expiresAtMs: Date.now() + PENDING_WRITE_TTL_MS });
    this.lastPushedValues.set(characteristic, value);
  }

  private setPendingWrite(characteristic: CommandedCharacteristic, pending: PendingWrite | null): void {
    if (pending === null) {
      this.pendingWrites.delete(characteristic);
    } else {
      this.pendingWrites.set(characteristic, pending);
    }
  }

  /**
   * Build the error HomeKit expects when the accessory cannot be reached, so
   * the Home app shows "No Response" rather than a stale reading presented as
   * current. Falls back to a plain Error where HAP status codes are not
   * available (the lightweight platform stubs used in tests).
   */
  private communicationFailure(): Error {
    const hap = this.platform.api?.hap;
    if (hap?.HapStatusError !== undefined) {
      return new hap.HapStatusError(HAP_STATUS_SERVICE_COMMUNICATION_FAILURE);
    }
    return new Error(`${this.device.name} is not responding`);
  }

  /** True once the provider has failed enough consecutive polls to give up. */
  private isUnreachable(): boolean {
    return this.consecutiveFailures >= FAILURES_BEFORE_NO_RESPONSE;
  }

  /**
   * Handle "GET" requests from HomeKit.
   * GET requests should return as fast as possible; prefer pushing updates
   * asynchronously with `updateCharacteristic` (see pollOnce above).
   */
  async getCurrentHeatingCoolingState(): Promise<CharacteristicValue> {
    if (this.isUnreachable()) {
      throw this.communicationFailure();
    }
    return this.lastSnapshot?.currentHeatingCoolingState ?? DEFAULT_HEATING_COOLING_STATE;
  }

  async getTargetHeatingCoolingState(): Promise<CharacteristicValue> {
    if (this.isUnreachable()) {
      throw this.communicationFailure();
    }
    return this.readPendingWrite('TargetHeatingCoolingState')?.value
      ?? this.lastSnapshot?.targetHeatingCoolingState
      ?? DEFAULT_HEATING_COOLING_STATE;
  }

  /**
   * Handle "SET" requests from HomeKit (user changes the mode on the Home app).
   */
  async setTargetHeatingCoolingState(value: CharacteristicValue) {
    const mode = value as 0 | 1 | 2 | 3;
    try {
      await this.stateProvider.setTargetHeatingCoolingState(mode);
    } catch (error) {
      if (error instanceof StateProviderNotImplementedError) {
        this.platform.log.debug(`[${this.device.name}] setTargetHeatingCoolingState not supported by provider: ${error.message}`);
        return; // Do not crash; HomeKit keeps the previous value.
      }
      throw error;
    }
    this.recordCommand('TargetHeatingCoolingState', mode);
  }

  async getCurrentTemperature(): Promise<CharacteristicValue> {
    if (this.isUnreachable()) {
      throw this.communicationFailure();
    }
    return this.lastSnapshot?.currentTemperatureCelsius ?? DEFAULT_TEMPERATURE;
  }

  async getTargetTemperature(): Promise<CharacteristicValue> {
    if (this.isUnreachable()) {
      throw this.communicationFailure();
    }
    return this.readPendingWrite('TargetTemperature')?.value
      ?? this.lastSnapshot?.targetTemperatureCelsius
      ?? DEFAULT_TEMPERATURE;
  }

  async setTargetTemperature(value: CharacteristicValue) {
    const celsius = value as number;
    try {
      await this.stateProvider.setTargetTemperature(celsius);
    } catch (error) {
      if (error instanceof StateProviderNotImplementedError) {
        this.platform.log.debug(`[${this.device.name}] setTargetTemperature not supported by provider: ${error.message}`);
        return; // Do not crash; HomeKit keeps the previous value.
      }
      throw error;
    }
    this.recordCommand('TargetTemperature', celsius);
  }

  async getTemperatureDisplayUnits(): Promise<CharacteristicValue> {
    return this.temperatureDisplayUnits;
  }

  /**
   * Display units are a HomeKit-side preference and do not reach the
   * thermostat. Remember the choice so the Home app does not revert it.
   */
  async setTemperatureDisplayUnits(value: CharacteristicValue) {
    this.platform.log.debug('Set TemperatureDisplayUnits ->', value);
    this.temperatureDisplayUnits = value;
  }

  async getCurrentRelativeHumidity(): Promise<CharacteristicValue> {
    if (this.isUnreachable()) {
      throw this.communicationFailure();
    }
    return this.lastSnapshot?.currentRelativeHumidityPercent ?? DEFAULT_RELATIVE_HUMIDITY;
  }

  /** Fan v2 Active: 1 while the fan is forced on, 0 in auto (see FAN_ACTIVE_TO_MODE). */
  async getFanActive(): Promise<CharacteristicValue> {
    if (this.isUnreachable()) {
      throw this.communicationFailure();
    }
    const pending = this.readPendingWrite('FanActive')?.value;
    if (pending !== undefined) {
      return pending;
    }
    const fanMode = this.lastSnapshot?.fanMode ?? null;
    return fanMode === null ? DEFAULT_FAN_ACTIVE : FAN_MODE_TO_ACTIVE[fanMode];
  }

  /** Fan v2 Active set from the Home app: on forces the fan, off returns it to auto. */
  async setFanActive(value: CharacteristicValue) {
    const active: 0 | 1 = value === 1 || value === true ? 1 : 0;
    try {
      await this.stateProvider.setFanMode(FAN_ACTIVE_TO_MODE[active]);
    } catch (error) {
      if (error instanceof StateProviderNotImplementedError) {
        this.platform.log.debug(`[${this.device.name}] setFanMode not supported by provider: ${error.message}`);
        return; // Do not crash; HomeKit keeps the previous value.
      }
      throw error;
    }
    this.recordCommand('FanActive', active);
  }
}
