/**
 * Error thrown by state providers when a requested operation is not
 * supported by the underlying implementation.
 *
 * Examples:
 *   - CloudStateProvider (AWS IoT not yet reverse-engineered)
 *   - LocalApiStateProvider (local API has no temp/mode/setpoint data)
 */
export class StateProviderNotImplementedError extends Error {
  public readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = 'StateProviderNotImplementedError';
    this.code = 'ERR_NOT_IMPLEMENTED';
  }
}

/**
 * Error thrown when a state provider cannot reach its data source
 * (network failure, HTTP non-200, timeout, etc.). Consumers should
 * treat this as transient and retain last-known-good state.
 */
export class StateProviderUnavailableError extends Error {
  public readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = 'StateProviderUnavailableError';
    this.code = 'ERR_UNAVAILABLE';
  }
}

/**
 * A complete snapshot of thermostat state as understood by a provider.
 * Fields marked `null` mean "unknown/unavailable" — providers return
 * null for any datum they cannot obtain from their backing source.
 */
export interface ThermostatStateSnapshot {
  /** Current indoor temperature in Celsius, or null if unavailable. */
  currentTemperatureCelsius: number | null;

  /** Current target temperature (setpoint) in Celsius, or null if unavailable. */
  targetTemperatureCelsius: number | null;

  /**
   * Current operating state.
   * Map to HomeKit Characteristic.CurrentHeatingCoolingState:
   *   0 = Off, 1 = Heat, 2 = Cool, 3 = Auto
   * Or null if unavailable.
   */
  currentHeatingCoolingState: 0 | 1 | 2 | 3 | null;

  /**
   * Target mode.
   * Map to HomeKit Characteristic.TargetHeatingCoolingState:
   *   0 = Off, 1 = Heat, 2 = Cool, 3 = Auto
   * Or null if unavailable.
   */
  targetHeatingCoolingState: 0 | 1 | 2 | 3 | null;

  /** Current relative humidity (percent, 0–100), or null if unavailable. */
  currentRelativeHumidityPercent: number | null;

  /** True if the provider could reach the thermostat on the last read. */
  isOnline: boolean;

  /** UTC timestamp (epoch ms) when this snapshot was read. */
  readTimestampMs: number;
}

/**
 * A single provider abstraction for reading and commanding thermostat state.
 *
 * Error contract:
 *   - `readState()` throws `StateProviderUnavailableError` when the backing
 *     system cannot be reached (transient). Callers must catch and retain
 *     last-known-good data.
 *   - `readState()`, `setTargetTemperature()`, and `setTargetHeatingCoolingState()`
 *     throw `StateProviderNotImplementedError` when the backing system does not
 *     support the operation at all (permanent capability gap).
 *   - Never throw raw Error or unexpected exception types; wrap if needed.
 */
export interface ThermostatStateProvider {
  /**
   * Fetch the current state snapshot from the backing system.
   * Must never return partially-filled data without indicating unavailability
   * (use null fields).
   *
   * @throws {StateProviderUnavailableError} if the backing system is unreachable.
   * @throws {StateProviderNotImplementedError} if the provider has no read capability.
   */
  readState(): Promise<ThermostatStateSnapshot>;

  /**
   * Set the target temperature (setpoint) in Celsius.
   *
   * @param targetTemperatureCelsius Target setpoint in Celsius.
   * @throws {StateProviderUnavailableError} if the backing system is unreachable.
   * @throws {StateProviderNotImplementedError} if the provider cannot command setpoints.
   */
  setTargetTemperature(targetTemperatureCelsius: number): Promise<void>;

  /**
   * Set the target heating/cooling mode.
   *
   * @param targetHeatingCoolingState 0=Off, 1=Heat, 2=Cool, 3=Auto.
   * @throws {StateProviderUnavailableError} if the backing system is unreachable.
   * @throws {StateProviderNotImplementedError} if the provider cannot command modes.
   */
  setTargetHeatingCoolingState(targetHeatingCoolingState: 0 | 1 | 2 | 3): Promise<void>;
}
