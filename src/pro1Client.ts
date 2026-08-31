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
 * the mobile app traffic). State access is handled by the state providers in
 * src/state/ (see LocalApiStateProvider / CloudStateProvider).
 */
export class Pro1Client {
  private readonly baseUrl: string;

  constructor(
    host: string,
    port = 80,
    private readonly timeoutMs = 5000,
  ) {
    this.baseUrl = `http://${host}:${port}`;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`Pro1 ${path}: HTTP ${response.status}`);
    }
    return (await response.json()) as T;
  }

  /** GET /sys — system info (no sensor data on the local API). */
  async getSystemInfo(): Promise<Record<string, unknown>> {
    return this.request('/sys');
  }

  /**
   * Fetch the thermostat's local system time via GET /sys/time.
   * Returns the raw JSON response body.
   * @throws {Error} on network failure, timeout, or non-200 response.
   */
  public async getSystemTime(): Promise<Record<string, unknown>> {
    return this.request('/sys/time');
  }

  /** POST /sys/command — reboot the thermostat. */
  async reboot(): Promise<Record<string, unknown>> {
    return this.request('/sys/command', {
      method: 'POST',
      body: JSON.stringify({ command: 'reboot' }),
    });
  }
}
