# Pro1 Thermostat — Homebridge Plugin

Homebridge platform plugin for Pro1 WiFi thermostats (T701 / T705 / T721 / T755).

> **Status: initial foundation.** This repo is scaffolded from the official
> [Homebridge plugin template](https://github.com/homebridge/homebridge-plugin-template)
> and lays the groundwork for a Pro1 integration. It is not yet a
> production-ready plugin — see [Roadmap](#roadmap).

## What works today

- Homebridge **platform** that registers one HomeKit **Thermostat** accessory per
  thermostat configured in `config.json` (add/remove/restore from cache handled).
- Full HomeKit Thermostat service surface wired with get/set handlers
  (Current/Target temperature, Current/Target mode, display units, humidity).
- **Connectivity check** on startup: the plugin calls the thermostat's documented
  local API (`GET /sys`) and logs the result, so you can confirm the device is
  reachable.
- Config UI schema (host, port, model, polling interval).

## What is stubbed (the actual Pro1 integration)

Pro1 thermostats do **not** expose temperature/mode/setpoint over their
documented local API. Community research (see below) found only a limited local
HTTP API — system info, network info, time, and a reboot command — while the
real control plane runs over **AWS IoT** to the Pro1 cloud. The places where that
integration goes are marked with `TODO(real integration)` in:

- `src/pro1Client.ts` — `readState()`, `setTargetTemperature()`, `setMode()` stubs
- `src/platformAccessory.ts` — handlers return placeholder state; polling TODO in
  the constructor

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
| `thermostats[].pollingInterval` | number | `60` | State polling interval (seconds) — used once the real integration lands |

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
npm run lint
```

## Roadmap

- [ ] Reverse-engineer / implement the AWS IoT or cloud path in `Pro1Client`
- [ ] Wire `readState()` + setter stubs to real device calls
- [ ] Poll on `pollingInterval` and push state via `updateCharacteristic`
- [ ] Optional: mDNS/scan discovery instead of manual host config

## License

Apache-2.0 (as per the Homebridge plugin template).
