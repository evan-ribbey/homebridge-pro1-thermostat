import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { Pro1ThermostatDeviceConfig, Pro1ThermostatPlatform } from './platform.js';
import {
  StateProviderNotImplementedError,
  StateProviderUnavailableError,
  ThermostatStateProvider,
  ThermostatStateSnapshot,
} from './state/index.js';

// HomeKit defaults shown until the first successful poll (Celsius).
const DEFAULT_TEMPERATURE = 20;
const DEFAULT_HEATING_COOLING_STATE = 0; // Off
const DEFAULT_RELATIVE_HUMIDITY = 50;

/**
 * Platform Accessory
 * Exposes a Pro1 thermostat as a HomeKit Thermostat service.
 *
 * All state is read from the injected ThermostatStateProvider on a polling
 * loop (config.pollingInterval seconds, default 60) and pushed to HomeKit
 * via `updateCharacteristic`. GET handlers serve the last snapshot with
 * sensible defaults until the first poll completes.
 */
export class Pro1ThermostatAccessory {
  private readonly service: Service;
  private readonly stateProvider: ThermostatStateProvider;
  private lastSnapshot: ThermostatStateSnapshot | null = null;
  private pollingTimer: NodeJS.Timeout | null = null;
  private readonly pollingIntervalMs: number;

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
      .setCharacteristic(this.platform.Characteristic.SerialNumber, this.device.host);

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

    this.service.getCharacteristic(this.platform.Characteristic.TargetTemperature)
      .onGet(this.getTargetTemperature.bind(this))
      .onSet(this.setTargetTemperature.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.TemperatureDisplayUnits)
      .onGet(this.getTemperatureDisplayUnits.bind(this))
      .onSet(this.setTemperatureDisplayUnits.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity)
      .onGet(this.getCurrentRelativeHumidity.bind(this));
  }

  /**
   * Start the polling loop: an immediate read, then periodic reads on
   * `config.pollingInterval` seconds. The timer is unref'd so polling alone
   * never keeps the Node process alive.
   */
  public async startPolling(): Promise<void> {
    await this.pollOnce();
    this.pollingTimer = setInterval(() => {
      void this.pollOnce();
    }, this.pollingIntervalMs);
    this.pollingTimer.unref();
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
      this.pushSnapshot(snapshot);
    } catch (error) {
      if (error instanceof StateProviderUnavailableError) {
        this.platform.log.debug(`[${this.device.name}] Poll failed (provider unavailable): ${error.message}. Keeping last known state.`);
        // Keep lastSnapshot as-is; optionally mark isOnline=false.
        if (this.lastSnapshot) {
          // Push an updated snapshot with isOnline=false, preserving all other fields.
          this.pushSnapshot({ ...this.lastSnapshot, isOnline: false, readTimestampMs: Date.now() });
        }
      } else if (error instanceof StateProviderNotImplementedError) {
        this.platform.log.debug(`[${this.device.name}] Provider not implemented: ${error.message}. No state pushed.`);
        // No state to push; HomeKit will show "No Response" for this accessory.
      } else {
        this.platform.log.debug(`[${this.device.name}] Unexpected poll error: ${error instanceof Error ? error.message : String(error)}`);
      }
      // Never crash; the interval continues.
    }
  }

  /**
   * Push every non-null field of a snapshot to HomeKit via updateCharacteristic.
   */
  private pushSnapshot(snapshot: ThermostatStateSnapshot): void {
    if (snapshot.currentTemperatureCelsius !== null) {
      this.service.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, snapshot.currentTemperatureCelsius);
    }
    if (snapshot.targetTemperatureCelsius !== null) {
      this.service.updateCharacteristic(this.platform.Characteristic.TargetTemperature, snapshot.targetTemperatureCelsius);
    }
    if (snapshot.currentHeatingCoolingState !== null) {
      this.service.updateCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState, snapshot.currentHeatingCoolingState);
    }
    if (snapshot.targetHeatingCoolingState !== null) {
      this.service.updateCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState, snapshot.targetHeatingCoolingState);
    }
    if (snapshot.currentRelativeHumidityPercent !== null) {
      this.service.updateCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity, snapshot.currentRelativeHumidityPercent);
    }
  }

  /**
   * Handle "GET" requests from HomeKit.
   * GET requests should return as fast as possible; prefer pushing updates
   * asynchronously with `updateCharacteristic` (see pollOnce above).
   */
  async getCurrentHeatingCoolingState(): Promise<CharacteristicValue> {
    return this.lastSnapshot?.currentHeatingCoolingState ?? DEFAULT_HEATING_COOLING_STATE;
  }

  async getTargetHeatingCoolingState(): Promise<CharacteristicValue> {
    return this.lastSnapshot?.targetHeatingCoolingState ?? DEFAULT_HEATING_COOLING_STATE;
  }

  /**
   * Handle "SET" requests from HomeKit (user changes the mode on the Home app).
   */
  async setTargetHeatingCoolingState(value: CharacteristicValue) {
    try {
      await this.stateProvider.setTargetHeatingCoolingState(value as 0 | 1 | 2 | 3);
    } catch (error) {
      if (error instanceof StateProviderNotImplementedError) {
        this.platform.log.debug(`[${this.device.name}] setTargetHeatingCoolingState not supported by provider: ${error.message}`);
        return; // Do not crash; HomeKit keeps the previous value.
      }
      throw error;
    }
  }

  async getCurrentTemperature(): Promise<CharacteristicValue> {
    return this.lastSnapshot?.currentTemperatureCelsius ?? DEFAULT_TEMPERATURE;
  }

  async getTargetTemperature(): Promise<CharacteristicValue> {
    return this.lastSnapshot?.targetTemperatureCelsius ?? DEFAULT_TEMPERATURE;
  }

  async setTargetTemperature(value: CharacteristicValue) {
    try {
      await this.stateProvider.setTargetTemperature(value as number);
    } catch (error) {
      if (error instanceof StateProviderNotImplementedError) {
        this.platform.log.debug(`[${this.device.name}] setTargetTemperature not supported by provider: ${error.message}`);
        return; // Do not crash; HomeKit keeps the previous value.
      }
      throw error;
    }
  }

  async getTemperatureDisplayUnits(): Promise<CharacteristicValue> {
    return 0; // 0 = Celsius
  }

  async setTemperatureDisplayUnits(value: CharacteristicValue) {
    this.platform.log.debug('Set TemperatureDisplayUnits ->', value);
  }

  async getCurrentRelativeHumidity(): Promise<CharacteristicValue> {
    return this.lastSnapshot?.currentRelativeHumidityPercent ?? DEFAULT_RELATIVE_HUMIDITY;
  }
}
