import { Pro1Client } from '../pro1Client.js';
import {
  ThermostatStateProvider,
  ThermostatStateSnapshot,
  StateProviderUnavailableError,
  StateProviderNotImplementedError,
} from './stateProvider.js';

/**
 * A ThermostatStateProvider backed by the Pro1 local HTTP API
 * (GET /sys, GET /sys/time). The local API does NOT expose
 * temperature, mode, or setpoint data — those fields are always null.
 */
export class LocalApiStateProvider implements ThermostatStateProvider {
  private readonly client: Pro1Client;

  constructor(client: Pro1Client) {
    this.client = client;
  }

  /**
   * Read system info + time from the local API. Temperature/mode/setpoint
   * are returned as null (unavailable). isOnline is true on success.
   *
   * @throws {StateProviderUnavailableError} when the local API is unreachable.
   */
  public async readState(): Promise<ThermostatStateSnapshot> {
    try {
      // Fetch both endpoints concurrently to minimize latency. The local API
      // exposes no temperature/mode/setpoint data, so the responses are only
      // awaited for reachability (success ⇒ isOnline) and otherwise unused.
      await Promise.all([
        this.client.getSystemInfo(),
        this.client.getSystemTime(),
      ]);

      return {
        currentTemperatureCelsius: null,
        targetTemperatureCelsius: null,
        currentHeatingCoolingState: null,
        targetHeatingCoolingState: null,
        currentRelativeHumidityPercent: null,
        isOnline: true,
        readTimestampMs: Date.now(),
      };
    } catch (error) {
      throw new StateProviderUnavailableError(
        `Local API unreachable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * The local API cannot command setpoints.
   */
  public async setTargetTemperature(_targetTemperatureCelsius: number): Promise<void> {
    void _targetTemperatureCelsius;
    throw new StateProviderNotImplementedError(
      'Local API does not support setting target temperature (AWS IoT path not yet implemented)',
    );
  }

  /**
   * The local API cannot command HVAC modes.
   */
  public async setTargetHeatingCoolingState(
    _targetHeatingCoolingState: 0 | 1 | 2 | 3,
  ): Promise<void> {
    void _targetHeatingCoolingState;
    throw new StateProviderNotImplementedError(
      'Local API does not support setting target heating/cooling state (AWS IoT path not yet implemented)',
    );
  }
}
