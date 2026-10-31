# Homebridge Pro1 Thermostat

<p align="center">

<a href="https://www.npmjs.com/package/homebridge-pro1-thermostat"><img alt="npm version" src="https://img.shields.io/npm/v/homebridge-pro1-thermostat.svg"></a>
<a href="https://www.npmjs.com/package/homebridge-pro1-thermostat"><img alt="npm downloads" src="https://img.shields.io/npm/dt/homebridge-pro1-thermostat.svg"></a>

</p>

Control your Pro1 Wi-Fi thermostat from the Apple Home app, Siri and HomeKit
automations.

The plugin adds each thermostat to HomeKit with:

- **Current temperature and humidity**
- **Target temperature**
- **Mode**: Off, Heat or Cool
- **Fan**: a separate fan tile. On runs the blower continuously; Off returns it to Auto

It's built for thermostats managed with the **PRO1 Connect** app. It has been
developed and tested against a Pro1 T855i.

## Requirements

- Homebridge 1.8 or 2.x
- Node.js 22, 24 or 26
- A Pro1 Wi-Fi thermostat set up in the PRO1 Connect app

## Installation

In the Homebridge UI, open **Plugins**, search for **Pro1 Thermostat** and
click **Install**.

Or from the command line:

```sh
npm install -g homebridge-pro1-thermostat
```

## Setup

Open the plugin's **Settings** in the Homebridge UI and add a thermostat.
The main choice is the **provider**, which is how the plugin reaches your
thermostat.

| Provider | What you need | Notes |
|---|---|---|
| **`app`** (recommended) | Your PRO1 Connect email and password | Works the same way as the PRO1 Connect app. Doesn't interrupt the thermostat. |
| `cloud` | The thermostat's IP address | Connects as the thermostat itself, which briefly knocks it offline in the PRO1 Connect app on every update. Only use it if you can't use `app`. |
| `local` | The thermostat's IP address | Status only. The thermostat's local connection doesn't report temperature or accept changes. |

Use `app` unless you have a specific reason not to.

### Example configuration

If you edit `config.json` directly:

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
          "password": "your-pro1-connect-password"
        }
      ]
    }
  ]
}
```

### Options

| Option | Default | Description |
|---|---|---|
| `name` | — | Name shown in the Home app. **Required.** |
| `provider` | `local` | `app`, `cloud` or `local` (see above). |
| `email` | — | PRO1 Connect account email. **Required for `app`.** |
| `password` | — | PRO1 Connect account password. **Required for `app`.** |
| `thingId` | auto | Which thermostat on your account to use. Leave it blank if you only have one. If you have several, set it on each entry; the Homebridge log lists the available IDs. |
| `host` | — | Thermostat IP address. **Required for `cloud` and `local`.** Give it a fixed IP address on your router so it doesn't change. |
| `port` | `80` | Thermostat port (`cloud` and `local` only). |
| `model` | `T705` | Model shown in the Home app. |
| `pollingInterval` | `60` (`120` for `cloud`) | How often to check the thermostat, in seconds. Minimums: 30 for `app`, 60 for `cloud`, 15 for `local`. |

To add more thermostats, add more entries. An entry with a mistake is skipped
with a message in the Homebridge log, and the others still load.

## How it behaves

- **Changes at the thermostat show up in the Home app** within one polling
  interval.
- **Home app changes take a moment to confirm.** The thermostat can take up
  to two minutes to report a change back. In the meantime the Home app keeps
  showing your new setting rather than flicking back to the old one.
- **"Auto" is the fan setting, not a mode.** On Pro1 thermostats, Auto
  means the fan runs only while heating or cooling, so the Home app's mode
  picker offers just Off, Heat and Cool. Use the fan tile instead: **On**
  runs the blower continuously, and **Off** returns it to Auto. (Pro1 has no
  fan-off setting.)
- **Temperatures** are shown in the units your iPhone is set to. The
  thermostat works in whole degrees Fahrenheit, so a Celsius setpoint may be
  rounded slightly.
- **"No Response"** appears if the plugin can't reach the thermostat three
  times in a row. It clears on its own once the connection is back.

## Troubleshooting

| Problem | What to do |
|---|---|
| "App cloud login failed" in the log | Check the email and password by signing in to the PRO1 Connect app with them. |
| "account has N thermostats and no thingId is configured" | Copy the right ID from that log message into the `thingId` option of each entry. |
| The wrong thermostat shows up | Set `thingId` explicitly (see above). |
| "thermostat is off" when changing the temperature | With the `app` provider, the temperature can't be set while the thermostat is off. Choose Heat, Cool or Auto first. |
| A Home app change reverts after about two minutes | The thermostat never applied it. Check that it's online in the PRO1 Connect app. |
| The thermostat flickers offline in the PRO1 Connect app | You're using the `cloud` provider. Switch to `app`. |
| "No Response" in the Home app | Check the thermostat's Wi-Fi connection and your credentials. For `cloud` and `local`, check that its IP address hasn't changed. |

For more detail, turn on **Homebridge Debug Mode** in the Homebridge UI
settings and look for lines starting with the thermostat's name.

## Privacy and security

- **`app` provider:** your PRO1 Connect email and password are stored in
  Homebridge's `config.json`, like any other Homebridge plugin login. They
  are sent only to the PRO1 login service and are never written to the log.
- **`cloud` and `local` providers:** the thermostat shares its cloud
  credentials with anyone on your local network, without a password. That's
  how the Pro1 firmware works, not something this plugin changes. Only use
  these providers on a network you trust.

## Known limitations

- Heat/cool auto changeover isn't supported. If your Pro1 model has it and
  you'd like it in the Home app, please open an issue.
- There is no automatic discovery yet. `cloud` and `local` need the
  thermostat's IP address.

## Release notes

See [CHANGELOG.md](CHANGELOG.md).

## Contributing

```sh
npm install
npm run build
npm run lint
npm test
```

How the plugin talks to the thermostat is covered in
[docs/technical-notes.md](docs/technical-notes.md). The source is on
[Gitea](https://git.ribbey.net/evan/homebridge-pro1-thermostat).

## Disclaimer

This is an independent project. It is not affiliated with or endorsed by Pro1
Technologies.

## License

Apache-2.0
