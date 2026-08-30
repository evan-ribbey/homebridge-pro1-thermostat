# Pro1 Thermostat — Homebridge Plugin

Homebridge platform plugin for Pro1 WiFi thermostats (T701 / T705 / T721 / T755).

> **Status: Milestone 1 complete.** The plugin now has a clean state-provider
> architecture, a local-API client, a polling loop, runtime config validation,
> and a unit-test suite. The actual Pro1 temperature control still requires the
> AWS IoT / cloud path (see [What is stubbed](#what-is-stubbed) and
> [Roadmap](#roadmap)).

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
- **Polling loop** (`config.pollingInterval`, default 60s) that pushes state via
  `updateCharacteristic` and degrades gracefully (keeps last-known state) when
  the provider is unavailable.
- **Runtime config validation** — entries missing a `name` or `host` are logged
  and skipped rather than crashing.
- **Unit tests** — `test/` covers the HTTP client, platform discovery/validation,
  and accessory characteristic handlers + polling (zero test dependencies,
  `node:test` + `node:assert`).

## What is stubbed (the actual Pro1 integration)

Pro1 thermostats do **not** expose temperature/mode/setpoint over their
documented local API. The real control plane runs over **AWS IoT** to the Pro1
cloud. The provider abstraction isolates that work:

- `src/state/localApiStateProvider.ts` — returns `null` for temperature/mode and
  throws `StateProviderNotImplementedError` for setters (correctly, since the
  local API can't command anything).
- `src/state/cloudStateProvider.ts` — placeholder for the AWS IoT / cloud path.
- `src/pro1Client.ts` — documents the known local endpoints and the `/aws_iot/*`
  provisioning endpoints as the entry point for the eventual cloud integration.

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
          "host": "192.168.1.50",
          "port": 80,
          "model": "T705",
          "pollingInterval": 60
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
- [ ] Reverse-engineer / implement the AWS IoT or cloud path (`CloudStateProvider`)
- [ ] Optional: mDNS/scan discovery instead of manual host config

## License

Apache-2.0 (as per the Homebridge plugin template).
