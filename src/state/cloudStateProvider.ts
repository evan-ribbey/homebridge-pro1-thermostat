import {
  ThermostatStateProvider,
  ThermostatStateSnapshot,
  StateProviderNotImplementedError,
} from './stateProvider.js';

/**
 * Placeholder provider for the Pro1 AWS IoT cloud control plane.
 * The AWS IoT protocol has not yet been reverse-engineered.
 * All operations throw StateProviderNotImplementedError.
 */
export class CloudStateProvider implements ThermostatStateProvider {
  public async readState(): Promise<ThermostatStateSnapshot> {
    throw new StateProviderNotImplementedError(
      'CloudStateProvider.readState: AWS IoT path not yet implemented',
    );
  }

  public async setTargetTemperature(_targetTemperatureCelsius: number): Promise<void> {
    void _targetTemperatureCelsius;
    throw new StateProviderNotImplementedError(
      'CloudStateProvider.setTargetTemperature: AWS IoT path not yet implemented',
    );
  }

  public async setTargetHeatingCoolingState(
    _targetHeatingCoolingState: 0 | 1 | 2 | 3,
  ): Promise<void> {
    void _targetHeatingCoolingState;
    throw new StateProviderNotImplementedError(
      'CloudStateProvider.setTargetHeatingCoolingState: AWS IoT path not yet implemented',
    );
  }
}
