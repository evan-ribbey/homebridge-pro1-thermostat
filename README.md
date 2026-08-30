# Pro1 Thermostat — Homebridge Plugin

Homebridge platform plugin for Pro1 WiFi thermostats (T701 / T705 / T721 / T755).

> **Status: Milestone 2 complete — cloud control works.** The plugin has a clean
> state-provider architecture, a local-API client, a polling loop, runtime config
> validation, a unit-test suite, and a working **AWS IoT poll-mode** provider
> (`provider: "cloud"`) that reads and controls the thermostat using its own
> device certificate and the AWS IoT Classic Shadow.

## What works today

- **Homebridge platform** that registers one HomeKit **Thermostat** accessory per
  thermostat configured in `config.json` (add / remove / restore-from-cache handled).
- **`ThermostatStateProvider` abstraction** (`src/state/`) that cleanly separates
  "what the local API can tell us" from "what the AWS IoT path will eventually
  provide" — with typed error contracts (`StateProviderUnavailableError`,
  `StateProviderNotImplementedError`).
- **`LocalApiStateProvider`** — wraps the documented local HTTP API
  (`GET /sys`, `GET /sys/time`) and reports `isOnline`; temperature/mode/setpoint
  are correctly surfaced as *unknown* (null).
- **`CloudStateProvider`** (`provider: "cloud"`) — the reverse-engineered AWS IoT
  integration in **poll mode**: self-provisions the device certificate/key from
  the thermostat's local API, reads temperature/mode/humidity via the AWS IoT
  Classic Shadow, and commands setpoint/mode via `shadow/update`.
- **Polling loop** (`config.pollingInterval`, default 60s) that pushes state via
  `updateCharacteristic` and degrades gracefully (keeps last-known state) when
  the provider is unavailable.
- **Runtime config validation** — entries missing a `name` or `host` are logged
  and skipped rather than crashing.
- **Unit tests** — `test/` covers the HTTP client, platform discovery/validation,
  and accessory characteristic handlers + polling (zero test dependencies,
  `node:test` + `node:assert`).

## What is still stubbed

- `src/state/localApiStateProvider.ts` — setters still throw
  `StateProviderNotImplementedError` (the local API genuinely can't command the
  thermostat); use `provider: "cloud"` for control.
- The `sys` mode mapping (0=off, 1=heat, 2=cool, 3=auto) is **provisional** —
  verified against a real device for heat; off/cool/auto behavior should be
  confirmed on your own unit.

## Configuration

```json
{
  "platforms": [
    {
      "platform": "Pro1Thermostat",
      "name": "Pro1 Thermostat",
      "thermostats": [
        {
          "name": "Living Room",
          "host": "192.168.1.124",
          "provider": "cloud",
          "pollingInterval": 120
        }
      ]
    }
  ]
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `name` | string | — | Platform display name |
| `thermostats[].name` | string | — | Accessory name shown in HomeKit |
| `thermostats[].host` | string | — | Thermostat IP or hostname on the LAN |
| `thermostats[].port` | number | `80` | Local API port |
| `thermostats[].model` | string | `T705` | Model (T701 / T705 / T721 / T755) |
| `thermostats[].pollingInterval` | number | `60` | State polling interval (seconds) |
| `thermostats[].provider` | string | `local` | `cloud` = AWS IoT shadow (control); `local` = local API (read-only) |

## Cloud control (poll mode)

Set `provider: "cloud"` on a thermostat entry to control it through the Pro1
cloud integration. The plugin fetches the thermostat's **own AWS IoT
credentials** from its local HTTP API (`GET /aws_iot/thing`, `/aws_iot/region`,
`/aws_iot/pubCert`, `/aws_iot/privKey` — unauthenticated on this firmware), then
connects to AWS IoT as the device.

| Layer | Detail |
|---|---|
| Endpoint | `mqtts://data.iot.<region>.amazonaws.com:8883` (MQTT over TLS, device cert/key auth) |
| Client ID | the exact IoT thing name (the device policy binds it) |
| Protocol | AWS IoT **Classic Shadow**: `$aws/things/{thing}/shadow/get` → `.../get/accepted`; `.../shadow/update` → `.../update/accepted` |
| State fields | `at` ambient °F · `hs` heat setpoint °F · `cs` cool setpoint °F · `sys` mode · `hum` humidity % (`ts_tu=0` = Fahrenheit) |

Because AWS IoT enforces one connection per policy, connecting as the device
briefly kicks the thermostat's own cloud link (the Pro1 app may show it offline
for a second). The plugin therefore uses **poll mode**: connect, exchange one
shadow message, disconnect immediately — a typical operation lasts 1–2 seconds,
after which the device reconnects on its own. A longer `pollingInterval` (e.g.
`120`) reduces how often this happens.

**Security note:** the local HTTP API exposes the device's AWS IoT private key
without authentication — anyone on your LAN could take over cloud control of the
thermostat. Run this on a trusted network only.

## Pro1 local API research

Documented local endpoints (from the Home Assistant community
[thread](https://community.home-assistant.io/t/pro-1-thermostat-local-api/830355)):

| Endpoint | Description |
|---|---|
| `GET /sys` | System info (no sensor data) |
| `GET /sys/network` | Current WiFi info |
| `GET /sys/scan` | Network scan (provisioning) |
| `GET /sys/time` | Epoch time |
| `GET /sys/interface` | `{"interface":"station"}` |
| `GET /sys/connection` | WiFi auth status flags |
| `POST /sys/command` | `{"command":"reboot"}` — reboot device |
| `GET /aws_iot/*` | AWS IoT provisioning (pubCert, thing, region, privKey) |

Key takeaway: temperature/HVAC state is **not** on the local API. The device
provisions itself into AWS IoT (see the `/aws_iot/*` endpoints), which is how the
Pro1 app talks to it. A full plugin will likely need to either implement the AWS
IoT / cloud path or intercept the app's traffic.

References:

- https://community.home-assistant.io/t/pro-1-thermostat-local-api/830355
- https://medium.com/@karosm/iot-pro1-t701i-wifi-thermostat-part-2-... (firmware dump analysis)

## Development

```bash
npm install
npm run build     # tsc → dist/
npm run lint      # eslint --max-warnings=0
npm test          # compile-then-test (node --test on compiled JS)
```

## Roadmap

- [x] State-provider abstraction (local API vs future cloud/AWS IoT)
- [x] Local API client (`GET /sys`, `GET /sys/time`, reboot) + connectivity check
- [x] Polling loop + graceful degradation + runtime config validation
- [x] Unit tests (HTTP client, platform discovery, accessory handlers)
- [x] Reverse-engineered + implemented the AWS IoT path (`CloudStateProvider`, poll mode)
- [ ] App-cloud API path (clean concurrent identity — no device-kick side effect)
- [ ] Optional: mDNS/scan discovery instead of manual host config

## License

Apache-2.0 (as per the Homebridge plugin template).
