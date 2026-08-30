import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { Pro1ThermostatDeviceConfig, Pro1ThermostatPlatform } from './platform.js';
import { Pro1Client } from './pro1Client.js';

// HomeKit HeatingCoolingState values (OFF / HEAT / COOL / AUTO)
const HK_STATE_OFF = 0;

/**
 * Platform Accessory
 * Exposes a Pro1 thermostat as a HomeKit Thermostat service.
 */
export class Pro1ThermostatAccessory {
  private readonly service: Service;
  private readonly client: Pro1Client;

  // Placeholder state — replace with real reads from Pro1Client once the
  // AWS IoT / cloud integration is implemented (see pro1Client.ts).
  private readonly state = {
    currentTemperature: 21.0,
    targetTemperature: 21.0,
    currentMode: HK_STATE_OFF,
    targetMode: HK_STATE_OFF,
    currentHumidity: 45,
    displayUnits: 0, // 0 = Celsius
  };

  constructor(
    private readonly platform: Pro1ThermostatPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly device: Pro1ThermostatDeviceConfig = accessory.context.device,
  ) {
    this.client = new Pro1Client(this.device.host, this.device.port ?? 80);

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

    // Fire-and-forget connectivity check: proves the local API is reachable and
    // logs the device's system info. Does not block accessory registration.
    void this.client.getSystemInfo()
      .then((info) => this.platform.log.info(
        `Pro1 ${this.device.host}: connected — ${JSON.stringify(info).slice(0, 200)}`,
      ))
      .catch((err: unknown) => this.platform.log.warn(
        `Pro1 ${this.device.host}: local API unreachable — ${err instanceof Error ? err.message : String(err)}`,
      ));

    // TODO(real integration): poll Pro1Client.readState() every
    // (device.pollingInterval ?? 60) seconds and push values to HomeKit with
    // service.updateCharacteristic(...) so the Home app stays live.
  }

  /**
   * Handle "GET" requests from HomeKit.
   * GET requests should return as fast as possible; prefer pushing updates
   * asynchronously with `updateCharacteristic` (see the TODO above).
   */
  async getCurrentHeatingCoolingState(): Promise<CharacteristicValue> {
    return this.state.currentMode;
  }

  async getTargetHeatingCoolingState(): Promise<CharacteristicValue> {
    return this.state.targetMode;
  }

  /**
   * Handle "SET" requests from HomeKit (user changes the mode on the Home app).
   */
  async setTargetHeatingCoolingState(value: CharacteristicValue) {
    this.state.targetMode = value as number;
    // TODO(real integration): await this.client.setMode(value as number);
    this.platform.log.debug('Set TargetHeatingCoolingState ->', value);
  }

  async getCurrentTemperature(): Promise<CharacteristicValue> {
    return this.state.currentTemperature;
  }

  async getTargetTemperature(): Promise<CharacteristicValue> {
    return this.state.targetTemperature;
  }

  async setTargetTemperature(value: CharacteristicValue) {
    this.state.targetTemperature = value as number;
    // TODO(real integration): await this.client.setTargetTemperature(value as number);
    this.platform.log.debug('Set TargetTemperature ->', value);
  }

  async getTemperatureDisplayUnits(): Promise<CharacteristicValue> {
    return this.state.displayUnits;
  }

  async setTemperatureDisplayUnits(value: CharacteristicValue) {
    this.state.displayUnits = value as number;
    this.platform.log.debug('Set TemperatureDisplayUnits ->', value);
  }

  async getCurrentRelativeHumidity(): Promise<CharacteristicValue> {
    return this.state.currentHumidity;
  }
}
