# Spindown

A native iPhone app for **Kinetic Road Machine Smart** trainers with the **inRide** Bluetooth
sensor: a modern, open-source replacement for the discontinued Kinetic Fit app.

- Talks to the inRide directly over its proprietary protocol (not FTMS), using **Kinetic's own
  power, speed and cadence algorithm**, verified bit-exact against Kinetic's C code
  ([protocol notes](docs/INRIDE_PROTOCOL.md)).
- Live power, speed, cadence, elapsed and moving time, distance, averages and maxima.
- Guided spindown calibration with Kinetic's roller advice.
- Automatic reconnection: the sensor sleeps when the roller stops, and Spindown reconnects
  as soon as it wakes. Rides keep recording through dropouts.
- Crash-safe recording: a journal is fsync'd every few seconds. If iOS or a crash closes the
  app mid-ride, the ride resumes on relaunch or is saved as a recovered ride.
- **Automatic Garmin Connect upload** as Indoor Cycling (see the caveat below), plus optional
  direct Strava upload marked as a trainer ride.
- FIT, TCX and CSV export, and a raw Bluetooth capture with every ride.
- Diagnostics: link health, device info, configuration, every decoded and raw field, packet
  and event logs, a GATT explorer, sensor commands, a scan of all BLE devices, a shareable
  diagnostics bundle, and a built-in simulator.

## Requirements

- iPhone on iOS 17 or later.
- A Mac with **Xcode 16** or later. Xcode 16.2 runs on macOS 14.5+; Xcode 26 needs macOS 15.6+.
- A free Apple ID is enough to run it on your own iPhone (apps signed with a free account
  expire after 7 days; a paid developer account lasts a year).

## Build and run

Step-by-step iPhone install instructions, including a no-Xcode route: [docs/INSTALL.md](docs/INSTALL.md).


```sh
brew install xcodegen               # once
cp Config/Secrets.example.xcconfig Config/Secrets.xcconfig
#   edit Secrets.xcconfig: a unique bundle id (com.yourname.spindown) and your team id
xcodegen generate                    # regenerate after adding or removing files
open Spindown.xcodeproj
```

In Xcode: choose your iPhone as the run destination, then press Run. The first time, Xcode
may ask you to pick your team under Signing & Capabilities, and the iPhone may ask you to
trust the developer (Settings › General › VPN & Device Management) and to enable Developer Mode.

Run the tests with Product › Test (⌘U). They cover the decoder (against Kinetic's reference
vectors), ride maths, crash-journal replay, FIT/TCX/CSV export, and the Garmin and Strava
clients against mocked servers.

## Garmin Connect

Settings › Garmin Connect › Sign In. You sign in on Garmin's own page (MFA works); Spindown
stores only a token in the Keychain. Finished rides then upload automatically, and are retried
until they succeed if you are offline or Garmin is busy.

**Caveat:** Garmin has no public API for uploading activities. Its developer program, including
the tiers reopened in October 2026, is read-only for activities. Spindown therefore uses the same
sign-in and upload service as Garmin's own mobile app, following the actively maintained
[python-garminconnect](https://github.com/cyberjunky/python-garminconnect). This works today,
but Garmin can change it without notice. If it breaks, rides are kept with their upload marked
as failed, and every ride can still be exported as FIT and imported at
connect.garmin.com › Import Data. All Garmin identifiers live in `GarminConnectConfig`
(`Packages/InRideKit/Sources/InRideKit/Services/GarminConnectClient.swift`).

If your Garmin account is linked to Strava, Garmin forwards each ride there, so leave
Spindown's own Strava upload off to avoid duplicates (this is the default).

## Strava (optional)

Strava requires each app to have its own API application. Create one at
<https://www.strava.com/settings/api> with **Authorization Callback Domain** `localhost`. Then
either put the Client ID and Secret in `Config/Secrets.xcconfig`, or enter them in
Settings › Strava, and tap Connect Strava.

## Project layout

```
Packages/InRideKit/       platform-neutral core (Swift package, unit tested)
  Protocol/               GATT ids, de-obfuscation, Kinetic decoder, commands, simulator
  Ride/                   recorder, statistics, crash journal
  Export/                 FIT writer, FIT/TCX/CSV exporters
  Services/               Garmin Connect and Strava clients
Spindown/                 iOS app (SwiftUI, Swift 6)
  Bluetooth/              CoreBluetooth connection manager, diagnostics log
  Recording/              ride session, file store, journal writer
  Services/               upload queue, Keychain, sign-in screens
  Views/                  ride, history, diagnostics, settings, calibration
docs/INRIDE_PROTOCOL.md   protocol research
```

Rides are plain JSON in the app's Documents folder (visible in the Files app under
"On My iPhone › Spindown") and included in iPhone backups.

## Credits

The inRide algorithm and constants come from Kinetic's published SDKs. Spindown is not
affiliated with Kinetic, Garmin or Strava.
