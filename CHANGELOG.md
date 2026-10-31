# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [0.2.3] - 2026-10-31

### Changed

- **The Home app mode picker now offers only Off, Heat and Cool.** On Pro1
  thermostats "Auto" is a fan setting, which is on the fan tile. The Auto
  mode option sent an untested mode value to the thermostat.
- The README has been rewritten for Homebridge users. Protocol and
  reverse-engineering notes are now in `docs/technical-notes.md`.

### Removed

- `renovate.json` is no longer included in the npm package.

## [0.2.2] - 2026-10-31

### Fixed

- **Home app could stay out of sync after a command the thermostat didn't apply.**
  If you changed the setpoint, mode or fan in the Home app and the thermostat
  never applied it, the Home app kept showing your change after the 2-minute
  hold expired instead of reverting to the thermostat's real value.
- **Changes made at the thermostat were hidden for up to 2 minutes after a Home app adjustment.**
  The thermostat stores setpoints in whole °F, so the value it reported back
  never exactly matched the one sent (for example, 24 °C was sent as 75.2 °F and
  came back as 75 °F). The plugin didn't recognise this as confirmation and
  ignored changes made at the wall for the full hold window. Values within
  half a degree Fahrenheit now count as confirmed.
- **App provider: "No Response" for up to an hour after a rejected login token.**
  If the PRO1 cloud rejected a token that hadn't expired yet (HTTP 401/403), the
  plugin kept sending it until it expired. It now refreshes the session on the
  next request.
- **Cloud provider: required a Homebridge restart after the thermostat was reset.**
  The AWS IoT credentials read from the thermostat were cached until
  Homebridge restarted, so a reset or re-provisioned thermostat failed every
  poll. They are now re-read from the device after a failed cloud exchange.

### Dependencies

- `mqtt` 5.15.2 → 5.16.1 (lockfile; the `^5.15.2` range already allowed this).
- `ip-address` 10.7.0 → 10.7.5 (indirect, via `mqtt` → `socks`), which fixes
  three moderate advisories in the lockfile. The plugin doesn't call the
  affected functions, and fresh installs already resolved a fixed version.
- Development tooling, updated by Renovate: `eslint` 10.14.0,
  `typescript-eslint` 8.72.1, `@types/node` 26.6.5,
  `amazon-cognito-identity-js` 6.3.22 (tests only).
- CI: `actions/checkout` v7 and `actions/setup-node` v7.
- Added a Renovate configuration that automerges non-major updates after CI
  passes and holds TypeScript at 6.x for `typescript-eslint` compatibility.

## [0.2.1] - 2026-09-03

### Fixed

- Fan mode was inverted. The thermostat uses `fan=0` for On (continuous) and
  `fan=1` for Auto, the reverse of what 0.2.0 shipped.

## [0.2.0] - 2026-09-03

### Added

- Fan mode control through a Fan v2 service: On runs the blower
  continuously, and Off returns it to Auto.

[0.2.3]: https://git.ribbey.net/evan/homebridge-pro1-thermostat/compare/v0.2.2...v0.2.3
[0.2.2]: https://git.ribbey.net/evan/homebridge-pro1-thermostat/compare/v0.2.1...v0.2.2
[0.2.1]: https://git.ribbey.net/evan/homebridge-pro1-thermostat/compare/v0.2.0...v0.2.1
[0.2.0]: https://git.ribbey.net/evan/homebridge-pro1-thermostat/releases/tag/v0.2.0
