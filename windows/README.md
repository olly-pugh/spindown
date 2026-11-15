# Spindown for Windows

The iPhone app rebuilt as a Windows desktop app, so it can run on a laptop with no 7-day re-signing.
It does the same things the same way: inRide decoding with Kinetic's algorithm (bit-exact against the same
240 reference packets), heart-rate straps, guided spindown calibration, the Lakes game and workouts,
crash-safe recording, history with charts and FIT/TCX/CSV export, automatic Garmin Connect upload
(optional Strava), and the diagnostics tools.

It is an [Electron](https://www.electronjs.org/) app. Bluetooth goes through Chromium's Web Bluetooth, which
on Windows uses the built-in Windows Bluetooth LE stack, so no drivers are needed.

## Installing it on someone's laptop

Send them the installer:

- **Download link** (after the first release is published, see below):
  `https://github.com/olly-pugh/spindown/releases/latest/download/Spindown-Setup.exe`
- **Or a USB stick:** copy `release/Spindown-Setup.exe` onto it. Run from a USB stick, Windows does not
  show its "unknown app" warnings.

Double-clicking the installer installs Spindown for that Windows user (no administrator password), puts
**Spindown** on the desktop and opens it. A welcome guide then connects the trainer, the heart-rate strap
and Garmin Connect. After that it is: open Spindown, pedal, Start Ride, Finish, Save.

The installer is not code-signed, so when it is downloaded from the internet Windows warns about it once
(Edge: "Keep" › "Keep anyway"; SmartScreen: "More info" › "Run anyway"). Updates after that install
silently with no warnings.

## Updates reach the laptop by themselves

Installed copies check GitHub Releases on startup and every 6 hours, download a newer version in the
background, and install it when Spindown is next closed (never during a ride). To ship a change:

1. Push to `main`. The **Windows app** workflow runs the tests and builds the installer (as an artifact).
2. On GitHub: **Actions › Windows app › Run workflow**. This publishes release `v1.0.<run number>`.

## Developing

```sh
cd windows
npm install
npm test          # decoder (Kinetic vectors), ride maths, journal, FIT/TCX/CSV, Garmin/Strava, upload queue
npm start         # runs the app on this computer
npm run dist      # builds release/Spindown-Setup.exe (works on a Mac too)
```

`npm start` works on a Mac for everything except real Bluetooth, which needs macOS's Bluetooth
permission for Electron. Use **Trainer & heart-rate strap › Use Simulated Trainer** to try it without one.

```
src/core/       platform-neutral logic, a line-for-line port of InRideKit (tested with node --test)
src/main/       Electron main process: files, settings, encrypted tokens, upload queue, sign-in windows,
                the Bluetooth device-chooser bridge, self-update
src/renderer/   the app window: Bluetooth links, ride session, screens, Lakes game
test/           unit tests
```

Data lives in `%APPDATA%\Spindown`: `Rides\<id>\` (record.json, track.json, packets.jsonl),
`ActiveRide\` (crash journal), `Logs\events.log`, `settings.json` and `secrets.json` (Garmin/Strava tokens,
encrypted with Windows DPAPI). Settings › Recording › "Open the rides folder" and Diagnostics › "Open the
log folder" open them. Diagnostics › "Save Diagnostics Bundle" writes one JSON file for remote debugging,
and F12 opens the developer tools.

## Differences from the iPhone app

- Windows only allows one Bluetooth search at a time, so the Sensors screen has separate "Find my
  trainer" and "Find my heart-rate strap" buttons.
- Web Bluetooth does not expose signal strength (RSSI) or the Device Information serial number, so
  those diagnostics fields are empty.
- Garmin sign-in is the same Garmin mobile page in a window, with the same `GMNEventHandler` bridge.
- Strava redirects to `http://localhost/strava`; the sign-in window catches it, so the Strava API
  application's callback domain stays `localhost`.
- New: a first-run welcome guide, a prompt to save if the window is closed mid-ride, and self-updating.
