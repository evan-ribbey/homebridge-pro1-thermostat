# Pro1 Thermostat — Homebridge Plugin

<p align="center">

<a href="https://www.npmjs.com/package/homebridge-pro1-thermostat"><img alt="npm version" src="https://img.shields.io/npm/v/homebridge-pro1-thermostat.svg"></a>
<a href="https://www.npmjs.com/package/homebridge-pro1-thermostat"><img alt="npm downloads" src="https://img.shields.io/npm/dt/homebridge-pro1-thermostat.svg"></a>
<a href="https://github.com/homebridge/homebridge/wiki/Verified-Plugins"><img alt="homebridge" src="https://img.shields.io/badge/homebridge-plugin-blue.svg"></a>

</p>

Homebridge platform plugin for Pro1 WiFi thermostats (T701 / T705 / T721 / T755).

## Installation

Search for **Pro1 Thermostat** in the Homebridge UI plugin browser, or install
from the command line:

```sh
npm install -g homebridge-pro1-thermostat
```

Source lives on Gitea at `git.ribbey.net/evan/homebridge-pro1-thermostat`.

> **Status: app-cloud REST control works.** The plugin has a clean
> state-provider architecture, a local-API client, a polling loop, runtime config
> validation, a unit-test suite, and **two working control paths**: an **AWS IoT
> poll-mode** provider (`provider: "cloud"`) that reads and controls the thermostat
> using its own device certificate and the AWS IoT Classic Shadow, and an
> **app-cloud REST** provider (`provider: "app"`) that authenticates with your PRO1
> Connect account credentials against `https://api.pro1iaq.com`.
>
> If you want the plugin to stay out of the way of the thermostat's own
> operation, prefer `provider: "app"` — see
> [Living with the thermostat](#living-with-the-thermostat).

## What works today

- **Homebridge platform** that registers one HomeKit **Thermostat** accessory per
  thermostat configured in `config.json` (add / remove / restore-from-cache handled).
- **Fan mode** as a **Fan** (Fan v2) service on the same accessory. Turning the
  fan *on* in the Home app is the Pro1 app's "On" (blower runs continuously);
  turning it *off* is "Auto" (blower runs only with a heat or cool call). The
  thermostat has no fan-off setting, so the tile reads "off" while in auto.
  Available with the `cloud` and `app` providers; the local API cannot see it.
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
- **`AppCloudStateProvider`** (`provider: "app"`) — the PRO1 Connect **app-cloud
  REST** path: Cognito SRP login with your account credentials, in-memory token
  caching with transparent refresh, thermostat discovery from the account device
  list, and shadow reads/writes over `https://api.pro1iaq.com` (no device-kick
  side effect, works from any network).
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
  thermostat); use `provider: "cloud"` or `provider: "app"` for control.
- The `sys` mode mapping is **partly provisional**. Heat and cool are verified
  live and are *inverted* from the obvious reading — on this firmware `sys=1`
  is cool and `sys=2` is heat. Off and auto should be confirmed on your own
  unit. All three providers share one map (`src/state/modeMap.ts`), so a
  correction only has to be made once.
- In auto mode the active stage (heating vs. cooling) is *inferred* from the
  ambient temperature and the two setpoints, because the device reports the
  configured mode rather than the running stage.

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
| `thermostats[].host` | string | — | Thermostat IP or hostname on the LAN. **Required for `local` and `cloud`**; not used by `app` |
| `thermostats[].port` | number | `80` | Local API port (`local` / `cloud` only) |
| `thermostats[].model` | string | `T705` | Model (T701 / T705 / T721 / T755) |
| `thermostats[].pollingInterval` | number | `60` (`120` for `cloud`) | State polling interval, seconds. Floored at 15s (`local`), 30s (`app`), 60s (`cloud`) |
| `thermostats[].provider` | string | `local` | `app` = PRO1 Connect app-cloud REST (control); `cloud` = AWS IoT shadow (control); `local` = local API (read-only) |

An entry that fails validation is logged and skipped; the rest of your
thermostats still load. Two entries that resolve to the same accessory
identity (the same `host`, say) are reported and the duplicate skipped.

## Living with the thermostat

The plugin is designed to stay out of the way of whoever is standing at the
thermostat. Three behaviours matter:

**Your change at the wall wins.** An AWS IoT shadow keeps a `desired` value
until something explicitly clears it, and the service re-sends it as a delta
whenever `desired` and `reported` disagree. A setpoint written by the plugin
would otherwise sit there as a standing order — adjust the temperature at the
wall afterwards and the device gets told to go back. After the device confirms
a commanded value (setpoint, mode or fan), the `cloud` provider clears that
`desired` entry. An
unconfirmed (still in-flight) command is never cleared, and when there is
nothing to clear this costs no extra traffic.

**HomeKit does not snap your change back.** A shadow write can take up to two
minutes to appear in `reported`. Until it does, polling still returns the old
value; pushing that to HomeKit made a change appear to be rejected. The plugin
now holds a commanded target until the device confirms it, or for two minutes,
whichever comes first — after which the device is believed again.

**The `cloud` provider interrupts the thermostat; the `app` provider does
not.** AWS IoT permits one connection per policy, and the `cloud` provider
connects *as the thermostat*, so every poll briefly displaces the device's own
cloud link. It defaults to a 120s interval and refuses to go below 60s for
that reason. If the PRO1 Connect app showing the thermostat as intermittently
offline bothers you, use `provider: "app"`, which connects as your account
instead and has no such side effect.

If the plugin cannot reach the thermostat for three consecutive polls, the
accessory reports **No Response** in the Home app rather than continuing to
present a stale reading as though it were live.

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
after which the device reconnects on its own. `pollingInterval` defaults to
`120` here and will not go below `60`; a longer interval reduces how often this
happens. If you would rather not interrupt the device at all, use
`provider: "app"`.

After the device confirms a value this provider commanded, the corresponding
`desired` entry is cleared from the shadow so it cannot later override a change
made at the thermostat itself — see
[Living with the thermostat](#living-with-the-thermostat).

**Security note:** the local HTTP API exposes the device's AWS IoT private key
without authentication — anyone on your LAN could take over cloud control of the
thermostat. Run this on a trusted network only.

## App cloud (REST)

Set `provider: "app"` on a thermostat entry to control it through the PRO1
Connect **app-cloud REST API** (`https://api.pro1iaq.com`) using your PRO1
Connect account credentials. The plugin authenticates against the same AWS
Cognito user pool the PRO1 Connect app uses (SRP login, implemented natively
against Node's `crypto` — no AWS SDK), caches the session in memory with
transparent refresh, and reads/commands the thermostat's AWS IoT shadow over
REST. Unlike the AWS IoT poll-mode path, it never connects as the
device itself — no device-kick side effect, and it works from any network.

```json
{
  "platforms": [
    {
      "platform": "Pro1Thermostat",
      "name": "Pro1 Thermostat",
      "thermostats": [
        {
          "name": "Living Room",
          "provider": "app",
          "email": "you@example.com",
          "password": "your-pro1-connect-password",
          "thingId": "t-123",
          "pollingInterval": 120
        }
      ]
    }
  ]
}
```

Note there is no `host`: the app-cloud provider reaches the thermostat through
your PRO1 Connect account, so it does not need to be on the same network.

| Field | Type | Default | Description |
|---|---|---|---|
| `provider` | string | `local` | `app` = PRO1 Connect app-cloud REST API (control) |
| `email` | string | — | PRO1 Connect account email (**required** when `provider: "app"`) |
| `password` | string | — | PRO1 Connect account password (**required** when `provider: "app"`; `writeOnly` in the schema) |
| `thingId` | string | `discover` | Thermostat ID (the IoT thing name) from the app-cloud API; leave blank to auto-discover. **Set this explicitly if the account has more than one thermostat** — auto-discovery picks the first and warns |

**Credentials note:** `email` and `password` are stored in plaintext in
`config.json` (standard Homebridge practice). The plugin sends them only to
Cognito during login, never writes either to the log, and redacts both from
error messages before logging or surfacing them — Cognito failures can echo the
username back. The token cache is in-memory only — a plugin restart performs a
fresh login.

**What's verified:** real-device observation confirmed the API shapes —
`GET /v3/thermostats?ownerId={sub}` returns `{statusCode, success, things: [...]}`
(things top-level, `thingName` doubles as the REST thingId), `GET /v3/thermostats/{thingId}`
returns `{statusCode, success, data: {shadow: {state: {reported, desired}}}}`,
and `PUT /v3/shadow?thingId={thingId}&shadowNewValue={url-encoded JSON}` returns
`{success: true}`. The `sys` mode mapping is `0`=off, `1`=**cool**, `2`=**heat**,
`3`=auto — heat and cool were verified against a real device and are inverted
from the naive reading; off and auto should be confirmed on your own unit. Unit
tests cover login caching, shadow parsing, mode-aware setpoints, sys writes,
base64-wrapped responses, discovery, token refresh, and error sanitization.

### Troubleshooting

| Symptom | Cause / fix |
|---|---|
| HTTP 401 | Expired/invalid token — the plugin auto-refreshes via the refresh token and falls back to a full SRP re-login; if it persists, re-check `email`/`password` |
| HTTP 403 | Wrong `email`/`password` for the PRO1 Connect account |
| `App cloud discovery failed: device list has no thingId` | No thermostats on the account, or the wrong one was picked — set `thingId` explicitly |
| `setTargetTemperature failed: thermostat is off` | The API refuses setpoints while the unit is off — set a target mode first |
| `account has N thermostats and no "thingId" is configured` | Auto-discovery can only pick one. Set `thingId` on each accessory, choosing from the names listed in the warning |
| Accessory shows **No Response** | Three consecutive polls failed. Check credentials and connectivity; it clears itself on the next successful poll |
| A change in the Home app appears to revert after a moment | Expected only if the command failed. A *pending* change is held for up to two minutes while the device catches up — if it reverts after that, the write is not reaching the device |

### Real-device smoke test (manual)

1. Add a `provider: "app"` thermostat entry with your PRO1 Connect `email` and
   `password` (optionally pin `thingId` — find it in the PRO1 Connect app or
   leave blank to auto-discover).
2. `npm run build && npm run lint && npm test` — all three must exit 0.
3. Start Homebridge with the plugin and watch the log for the first poll.
4. In HomeKit: confirm temperature/mode/humidity appear within one polling
   interval (~30 s), then change the target temperature and the target mode.
5. Verify the physical thermostat reflects the change within ~30 s, and that
   the PRO1 Connect app still shows the device online (no device-kick).

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

**Runtime dependencies: `mqtt` only.** Cognito SRP is implemented directly in
`src/state/cognitoSrp.ts` over `node:crypto` and global `fetch`, rather than
via `amazon-cognito-identity-js` — which is browser-oriented and pulled in an
end-of-life `node-fetch@2` plus polyfills. That library is retained as a
*devDependency test oracle*: `test/cognitoSrp.test.ts` differentially checks
every derivation step (padHex, hex hashing, HKDF, modular exponentiation, the
full session-key derivation, the timestamp format and the secret-block
signature) against it, so the native implementation is verified byte-for-byte
rather than merely believed.

## Roadmap

- [x] State-provider abstraction (local API vs future cloud/AWS IoT)
- [x] Local API client (`GET /sys`, `GET /sys/time`, reboot) + connectivity check
- [x] Polling loop + graceful degradation + runtime config validation
- [x] Unit tests (HTTP client, platform discovery, accessory handlers)
- [x] Reverse-engineered + implemented the AWS IoT path (`CloudStateProvider`, poll mode)
- [x] App-cloud API path (clean concurrent identity — no device-kick side effect)
- [x] Non-interference: clear satisfied shadow `desired`, hold pending HomeKit
      writes, per-provider polling floors, "No Response" on repeated failure
- [ ] Confirm the `sys` off/auto mapping against a real device
- [ ] Confirm the `fan` on/auto encoding against a real device (assumed 0=auto,
      1=on in `src/state/modeMap.ts`; the polarity has not been observed live)
- [ ] Optional: mDNS/scan discovery instead of manual host config

## License

Apache-2.0 (as per the Homebridge plugin template).
