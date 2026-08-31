import type { API, Characteristic, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service } from 'homebridge';

import { Pro1ThermostatAccessory } from './platformAccessory.js';
import { Pro1Client } from './pro1Client.js';
import { AppCloudStateProvider, CloudStateProvider, LocalApiStateProvider } from './state/index.js';
import type { ThermostatStateProvider } from './state/index.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

export interface Pro1ThermostatDeviceConfig {
  /** Display name shown in HomeKit (e.g. "Living Room"). */
  name: string;
  /**
   * IP address or hostname of the thermostat on the LAN. Required for the
   * `local` and `cloud` providers, which talk to the device directly;
   * optional for `app`, which reaches it through the PRO1 account.
   */
  host?: string;
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

/** An app-cloud entry that has passed credential validation. */
type AppCloudDeviceConfig = Pro1ThermostatDeviceConfig & { email: string; password: string };

/** True when a non-empty string. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Narrow an app-cloud entry to one carrying credentials, so the provider can
 * be constructed without `as string` assertions.
 */
function hasAppCredentials(device: Pro1ThermostatDeviceConfig): device is AppCloudDeviceConfig {
  return isNonEmptyString(device.email) && isNonEmptyString(device.password);
}

/**
 * Default polling interval per provider, in seconds. The cloud provider polls
 * more slowly by default because every poll briefly disconnects the
 * thermostat from its own cloud link (AWS IoT allows one connection per
 * policy). The local and app-cloud paths have no such side effect.
 */
const DEFAULT_POLLING_SECONDS: Readonly<Record<'cloud' | 'local' | 'app', number>> = {
  cloud: 120,
  local: 60,
  app: 60,
};

/**
 * Lower bound on the polling interval per provider, in seconds. Without a
 * floor, `pollingInterval: 1` would reconnect as the device once a second and
 * leave the thermostat effectively unable to hold its own cloud connection.
 */
const MIN_POLLING_SECONDS: Readonly<Record<'cloud' | 'local' | 'app', number>> = {
  cloud: 60,
  local: 15,
  app: 30,
};

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
    // Start from a clean slate so a second pass cannot mistake the previous
    // pass's ids for duplicates, nor unregister accessories it just added.
    this.discoveredCacheUUIDs.length = 0;

    for (const device of devices) {
      // Runtime config validation: skip entries with a missing/invalid name.
      if (!isNonEmptyString(device.name)) {
        this.log.error(
          'Invalid thermostats entry: "name" is required and must be a non-empty string. '
          + `Entry: ${JSON.stringify(this.redact(device))}`,
        );
        continue; // Skip this entry; do not register an accessory for it.
      }

      const provider = device.provider ?? 'local';

      // `host` addresses the thermostat on the LAN, which only the local and
      // cloud providers do. App-cloud entries reach the thermostat through the
      // PRO1 account and legitimately have no host.
      const lanHost = isNonEmptyString(device.host) ? device.host : null;
      if (provider !== 'app' && lanHost === null) {
        this.log.error(
          `Invalid thermostats entry for "${device.name}": "host" is required and must be a non-empty string `
          + `when provider is "${provider}". Entry: ${JSON.stringify(this.redact(device))}`,
        );
        continue; // Skip this entry; do not register an accessory for it.
      }

      // App-cloud entries require account credentials. Skip the entry rather
      // than throwing: discoverDevices runs inside the didFinishLaunching
      // handler, where a throw aborts every thermostat that follows.
      if (provider === 'app' && !hasAppCredentials(device)) {
        this.log.error(
          `Invalid thermostats entry for "${device.name}": "email" and "password" are both required and must be `
          + 'non-empty strings when provider is "app". Skipping this thermostat.',
        );
        continue;
      }

      // Derive a stable accessory id. The host/IP stays the basis wherever one
      // exists so accessories cached by earlier versions keep their identity;
      // hostless app-cloud entries fall back to the account + thermostat.
      const uuidSeed = lanHost ?? `app:${device.email}:${device.thingId ?? device.name}`;
      const uuid = this.api.hap.uuid.generate(uuidSeed);

      if (this.discoveredCacheUUIDs.includes(uuid)) {
        this.log.error(
          `Duplicate thermostats entry for "${device.name}": another entry already resolves to the same accessory id `
          + `(seed "${uuidSeed}"). Give each thermostat a distinct host or thingId. Skipping this thermostat.`,
        );
        continue;
      }

      const normalizedDevice: Pro1ThermostatDeviceConfig = {
        ...device,
        provider,
        pollingInterval: this.resolvePollingInterval(device, provider),
      };

      // Select the state provider backend: 'cloud' uses the AWS IoT shadow via
      // MQTT (poll mode), 'app' uses the Pro1 app cloud REST API, and anything
      // else (default 'local') uses the local HTTP API.
      let stateProvider: ThermostatStateProvider;
      if (provider === 'app' && hasAppCredentials(device)) {
        stateProvider = new AppCloudStateProvider(
          {
            email: device.email,
            password: device.password,
            thingId: device.thingId || 'discover',
          },
          this.log,
        );
      } else if (lanHost === null) {
        // Unreachable given the validation above; keeps the host narrowing
        // honest rather than asserting it away.
        this.log.error(`Invalid thermostats entry for "${device.name}": no usable host. Skipping this thermostat.`);
        continue;
      } else if (provider === 'cloud') {
        stateProvider = new CloudStateProvider(lanHost, device.port ?? 80, this.log);
      } else {
        stateProvider = new LocalApiStateProvider(new Pro1Client(lanHost, device.port ?? 80));
      }

      const existingAccessory = this.accessories.get(uuid);

      if (existingAccessory) {
        this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);

        // refresh the stored device config
        existingAccessory.context.device = normalizedDevice;
        this.api.updatePlatformAccessories([existingAccessory]);

        const accessory = new Pro1ThermostatAccessory(this, existingAccessory, normalizedDevice, stateProvider);
        void accessory.startPolling();
      } else {
        this.log.info('Adding new accessory:', device.name);

        const accessory = new this.api.platformAccessory(device.name, uuid);

        // store a copy of the device config in the accessory context
        accessory.context.device = normalizedDevice;

        const thermostatAccessory = new Pro1ThermostatAccessory(this, accessory, normalizedDevice, stateProvider);
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

  /**
   * Resolve the polling interval, applying the per-provider default and floor.
   * Polling the cloud provider too aggressively is not merely wasteful: each
   * poll connects to AWS IoT as the thermostat, briefly displacing the
   * thermostat's own connection.
   */
  private resolvePollingInterval(
    device: Pro1ThermostatDeviceConfig,
    provider: 'cloud' | 'local' | 'app',
  ): number {
    const configured = device.pollingInterval;
    if (configured === undefined) {
      return DEFAULT_POLLING_SECONDS[provider];
    }
    if (typeof configured !== 'number' || !Number.isFinite(configured) || configured <= 0) {
      this.log.warn(
        `[${device.name}] Ignoring invalid "pollingInterval" (${JSON.stringify(configured)}); `
        + `using ${DEFAULT_POLLING_SECONDS[provider]}s.`,
      );
      return DEFAULT_POLLING_SECONDS[provider];
    }
    const floor = MIN_POLLING_SECONDS[provider];
    if (configured < floor) {
      this.log.warn(
        `[${device.name}] "pollingInterval" of ${configured}s is below the ${floor}s minimum for the "${provider}" `
        + `provider; using ${floor}s.`
        + (provider === 'cloud' ? ' Each cloud poll briefly interrupts the thermostat\'s own cloud connection.' : ''),
      );
      return floor;
    }
    return configured;
  }

  /** Copy a device entry with the password removed, for safe logging. */
  private redact(device: Pro1ThermostatDeviceConfig): Record<string, unknown> {
    const { password, ...rest } = device;
    return password === undefined ? rest : { ...rest, password: '[REDACTED]' };
  }
}
