# Technical notes

Background on how the plugin talks to Pro1 thermostats, kept here for
contributors. User-facing documentation is in the [README](../README.md).

## Connection methods

### `app` — PRO1 Connect cloud (REST)

- Authenticates against the same AWS Cognito user pool the PRO1 Connect app
  uses (USER_SRP_AUTH), implemented natively in `src/state/cognitoSrp.ts`
  over `node:crypto` and global `fetch`.
- Tokens are cached in memory only and refreshed with the refresh token,
  falling back to a full login. A 401/403 marks the access token expired.
- Access tokens go in the `jwt` header, not `Authorization`.
- Verified API shapes:
  - `GET /v3/thermostats?ownerId={sub}` → `{statusCode, success, things: [...]}`;
    `thingName` doubles as the REST thingId.
  - `GET /v3/thermostats/{thingId}` → `{statusCode, success, data: {shadow: {state: {reported, desired}}}}`.
    `data` is sometimes base64-wrapped JSON.
  - `PUT /v3/shadow?thingId={thingId}&shadowNewValue={url-encoded JSON}` → `{success: true}`.

See also [app-cloud-api.md](app-cloud-api.md).

### `cloud` — AWS IoT shadow (poll mode)

The plugin fetches the thermostat's own AWS IoT credentials from its local
HTTP API (`GET /aws_iot/thing`, `/aws_iot/region`, `/aws_iot/pubCert`,
`/aws_iot/privKey`, unauthenticated on this firmware), then connects as the
device.

| Layer | Detail |
|---|---|
| Endpoint | `mqtts://data.iot.<region>.amazonaws.com:8883` (device cert/key auth) |
| Trust anchor | Legacy VeriSign Class 3 G5 root, bundled in `certs/` |
| Client ID | The exact IoT thing name (the device policy binds it) |
| Protocol | Classic Shadow: `shadow/get` → `get/accepted`; `shadow/update` → `update/accepted` |

AWS IoT allows one connection per policy, so connecting as the device
displaces the thermostat's own connection. Each operation connects, exchanges
one message, and disconnects (typically 1–2 s). This is why the provider
polls at 120 s by default and never faster than 60 s.

Provisioning is cached and re-read from the device after any failed exchange.

### `local` — local HTTP API

Documented endpoints (from the Home Assistant community
[thread](https://community.home-assistant.io/t/pro-1-thermostat-local-api/830355)):

| Endpoint | Description |
|---|---|
| `GET /sys` | System info (no sensor data) |
| `GET /sys/network` | Current Wi-Fi info |
| `GET /sys/scan` | Network scan (provisioning) |
| `GET /sys/time` | Epoch time |
| `GET /sys/interface` | `{"interface":"station"}` |
| `GET /sys/connection` | Wi-Fi auth status flags |
| `POST /sys/command` | `{"command":"reboot"}` |
| `GET /aws_iot/*` | AWS IoT provisioning (pubCert, thing, region, privKey) |

Temperature, mode and setpoints are not available locally, so this provider
only reports reachability.

## Shadow fields

| Field | Meaning |
|---|---|
| `at` | Ambient temperature, °F |
| `hs` | Heat setpoint, °F |
| `cs` | Cool setpoint, °F |
| `sys` | Mode: `0` off, `1` **cool**, `2` **heat**, `3` auto |
| `fan` | Fan: `0` **on** (continuous), `1` auto |
| `hum` | Relative humidity, % |
| `ts_tu` | Display units (`0` = Fahrenheit) |

`sys` heat/cool and `fan` are inverted from the obvious reading; both were
verified on a real device. `sys` off/auto have not been confirmed live. All
providers share one map in `src/state/modeMap.ts`.

In auto mode the device reports the configured mode, not the running stage,
so the plugin infers heating/cooling/idle from the ambient temperature and
the two setpoints.

## Non-interference

- **Clearing satisfied `desired` keys** (`cloud`): a Classic Shadow keeps
  `desired` until nulled, and re-sends it as a delta whenever it differs from
  `reported`. After the device confirms a commanded value, the plugin nulls
  that key so it can't later override a change made at the wall.
- **Pending writes** (all providers): a commanded value is held in HomeKit
  until the device reports it (setpoints within half a degree F), or for two
  minutes.
- **No Response** after three consecutive failed polls.

## Cognito SRP test oracle

`amazon-cognito-identity-js` is a devDependency only. `test/cognitoSrp.test.ts`
checks every derivation step of the native implementation against it
(padHex, hashing, HKDF, modPow, session key, timestamp format, signature).
