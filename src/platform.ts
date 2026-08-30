import type { API, Characteristic, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service } from 'homebridge';

import { Pro1ThermostatAccessory } from './platformAccessory.js';
import { Pro1Client } from './pro1Client.js';
import { AppCloudStateProvider, CloudStateProvider, LocalApiStateProvider } from './state/index.js';
import type { ThermostatStateProvider } from './state/index.js';
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
  /** Email for the Pro1 app cloud account (required when provider === 'app'). */
  email?: string;
  /** Password for the Pro1 app cloud account (required when provider === 'app'). */
  password?: string;
  /** Override thermostat ID; if absent or 'discover', auto-discover from the account. */
  thingId?: string;
  /** State provider backend: 'cloud' (AWS IoT shadow via MQTT), 'app' (Pro1 app cloud REST), or 'local' (default, local HTTP API). */
  provider?: 'cloud' | 'local' | 'app';
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
   * Entries missing a valid `name` or `host` are logged and skipped.
   * Accessories must only be registered once — previously created accessories
   * must not be registered again to prevent "duplicate UUID" errors.
   */
  discoverDevices() {
    const devices = this.config.thermostats ?? [];

    for (const device of devices) {
      // Runtime config validation: skip entries with a missing/invalid name or host.
      if (!device.name || typeof device.name !== 'string' || device.name.trim() === '') {
        this.log.error(`Invalid thermostats entry: "name" is required and must be a non-empty string. Entry: ${JSON.stringify(device)}`);
        continue; // Skip this entry; do not register an accessory for it.
      }
      if (!device.host || typeof device.host !== 'string' || device.host.trim() === '') {
        this.log.error(`Invalid thermostats entry for "${device.name}": "host" is required and must be a non-empty string. Entry: ${JSON.stringify(device)}`);
        continue; // Skip this entry; do not register an accessory for it.
      }

      // App-cloud entries require account credentials; fail hard so the misconfiguration is visible.
      if (device.provider === 'app') {
        if (!device.email || typeof device.email !== 'string' || device.email.trim() === '') {
          throw new Error(`Invalid thermostats entry for "${device.name}": "email" is required and must be a non-empty string when provider is "app".`);
        }
        if (!device.password || typeof device.password !== 'string' || device.password.trim() === '') {
          throw new Error(`Invalid thermostats entry for "${device.name}": "password" is required and must be a non-empty string when provider is "app".`);
        }
      }

      // generate a unique id from something globally unique, but constant — the host/IP
      const uuid = this.api.hap.uuid.generate(device.host);

      // Select the state provider backend: 'cloud' uses the AWS IoT shadow via
      // MQTT (poll mode), 'app' uses the Pro1 app cloud REST API, and anything
      // else (default 'local') uses the local HTTP API.
      let stateProvider: ThermostatStateProvider;
      if (device.provider === 'cloud') {
        stateProvider = new CloudStateProvider(device.host, device.port ?? 80, this.log);
      } else if (device.provider === 'app') {
        // email/password validated as non-empty strings above when provider === 'app'
        stateProvider = new AppCloudStateProvider(
          {
            email: device.email as string,
            password: device.password as string,
            thingId: device.thingId || 'discover',
          },
          this.log,
        );
      } else {
        stateProvider = new LocalApiStateProvider(new Pro1Client(device.host, device.port ?? 80));
      }

      const existingAccessory = this.accessories.get(uuid);

      if (existingAccessory) {
        this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);

        // refresh the stored device config
        existingAccessory.context.device = device;
        this.api.updatePlatformAccessories([existingAccessory]);

        const accessory = new Pro1ThermostatAccessory(this, existingAccessory, device, stateProvider);
        void accessory.startPolling();
      } else {
        this.log.info('Adding new accessory:', device.name);

        const accessory = new this.api.platformAccessory(device.name, uuid);

        // store a copy of the device config in the accessory context
        accessory.context.device = device;

        const thermostatAccessory = new Pro1ThermostatAccessory(this, accessory, device, stateProvider);
        void thermostatAccessory.startPolling();

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
