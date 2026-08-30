import type { API, Characteristic, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service } from 'homebridge';

import { Pro1ThermostatAccessory } from './platformAccessory.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

export interface Pro1ThermostatDeviceConfig {
  /** Display name shown in HomeKit (e.g. "Living Room"). */
  name: string;
  /** IP address or hostname of the thermostat on the LAN. */
  host: string;
  /** HTTP port of the local API (default 80). */
  port?: number;
  /** Model used for AccessoryInformation (default "T705"). */
  model?: string;
  /** Polling interval in seconds (default 60). */
  pollingInterval?: number;
}

export interface Pro1PlatformConfig extends PlatformConfig {
  thermostats?: Pro1ThermostatDeviceConfig[];
}

/**
 * HomebridgePlatform
 * Registers one Thermostat accessory per configured Pro1 thermostat.
 */
export class Pro1ThermostatPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  // this is used to track restored cached accessories
  public readonly accessories: Map<string, PlatformAccessory> = new Map();
  public readonly discoveredCacheUUIDs: string[] = [];

  constructor(
    public readonly log: Logging,
    public readonly config: Pro1PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.log.debug('Finished initializing platform:', this.config.name);

    // When this event is fired Homebridge has restored all cached accessories
    // from disk. Dynamic Platform plugins should only register new accessories
    // after this event, to ensure they weren't added to homebridge already.
    this.api.on('didFinishLaunching', () => {
      log.debug('Executed didFinishLaunching callback');
      this.discoverDevices();
    });
  }

  /**
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.set(accessory.UUID, accessory);
  }

  /**
   * Registers one Thermostat accessory per entry in `config.thermostats`.
   * Accessories must only be registered once — previously created accessories
   * must not be registered again to prevent "duplicate UUID" errors.
   */
  discoverDevices() {
    const devices = this.config.thermostats ?? [];

    for (const device of devices) {
      // generate a unique id from something globally unique, but constant — the host/IP
      const uuid = this.api.hap.uuid.generate(device.host);

      const existingAccessory = this.accessories.get(uuid);

      if (existingAccessory) {
        this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);

        // refresh the stored device config
        existingAccessory.context.device = device;
        this.api.updatePlatformAccessories([existingAccessory]);

        new Pro1ThermostatAccessory(this, existingAccessory);
      } else {
        this.log.info('Adding new accessory:', device.name);

        const accessory = new this.api.platformAccessory(device.name, uuid);

        // store a copy of the device config in the accessory context
        accessory.context.device = device;

        new Pro1ThermostatAccessory(this, accessory);

        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }

      this.discoveredCacheUUIDs.push(uuid);
    }

    // remove cached accessories that are no longer present in the config
    for (const [uuid, accessory] of this.accessories) {
      if (!this.discoveredCacheUUIDs.includes(uuid)) {
        this.log.info('Removing existing accessory from cache:', accessory.displayName);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }
  }
}
