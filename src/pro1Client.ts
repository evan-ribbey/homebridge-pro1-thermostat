/**
 * Pro1Client
 *
 * Minimal HTTP client for Pro1 WiFi thermostats (T701 / T705 / T721 / T755).
 *
 * Documented local API endpoints (community research — sources in README.md):
 *   GET  /sys            system info (no temperature/sensor data)
 *   GET  /sys/network    current wifi info
 *   GET  /sys/scan       network scan (provisioning)
 *   GET  /sys/time       device epoch time
 *   GET  /sys/interface  {"interface":"station"}
 *   GET  /sys/connection wifi auth status flags
 *   POST /sys/command    {"command":"reboot"}  — reboot the device
 *   GET  /aws_iot/pubCert, /aws_iot/thing, /aws_iot/region, /aws_iot/privKey
 *
 * IMPORTANT: the documented local API does NOT expose temperature, HVAC mode,
 * or setpoint data. The thermostats talk to the Pro1 cloud over AWS IoT, so a
 * full integration will need the AWS IoT / cloud path (or reverse-engineering
 * the mobile app traffic). The state-access methods below are stubs marking
 * exactly where that work goes.
 */
export interface Pro1ThermostatState {
  /** Current temperature in Celsius. */
  currentTemperature: number;
  /** Target temperature in Celsius. */
  targetTemperature: number;
  /** HomeKit CurrentHeatingCoolingState value (0=off, 1=heat, 2=cool, 3=auto). */
  currentMode: number;
  /** HomeKit TargetHeatingCoolingState value. */
  targetMode: number;
}

export class Pro1Client {
  private readonly baseUrl: string;

  constructor(
    private readonly host: string,
    private readonly port = 80,
    private readonly timeoutMs = 5000,
  ) {
    this.baseUrl = `http://${host}:${port}`;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Pro1 ${path}: HTTP ${response.status}`);
      }
      return (await response.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  /** GET /sys — system info (no sensor data on the local API). */
  async getSystemInfo(): Promise<Record<string, unknown>> {
    return this.request('/sys');
  }

  /** GET /sys/time — device epoch time. */
  async getTime(): Promise<Record<string, unknown>> {
    return this.request('/sys/time');
  }

  /** POST /sys/command — reboot the thermostat. */
  async reboot(): Promise<Record<string, unknown>> {
    return this.request('/sys/command', {
      method: 'POST',
      body: JSON.stringify({ command: 'reboot' }),
    });
  }

  // ---------------------------------------------------------------------------
  // TODO(real integration): the local API does not expose thermostat state.
  // Wire these to the AWS IoT / Pro1 cloud path once it is reverse-engineered
  // (see the /aws_iot/* endpoints and the research links in README.md).
  // ---------------------------------------------------------------------------

  async readState(): Promise<Pro1ThermostatState> {
    throw new Error('Not implemented — thermostat state requires the AWS IoT / cloud path');
  }

  async setTargetTemperature(celsius: number): Promise<void> {
    throw new Error(`Not implemented — would set target temperature to ${celsius}°C via the AWS IoT / cloud path`);
  }

  async setMode(homekitMode: number): Promise<void> {
    throw new Error(`Not implemented — would set mode ${homekitMode} via the AWS IoT / cloud path`);
  }
}
