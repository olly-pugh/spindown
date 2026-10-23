# Installing Spindown on your iPhone

Spindown isn't on the App Store, so you install it from your Mac with Xcode. Allow about an
hour the first time, most of it downloading Xcode. Later installs take a minute.

## 1. Prepare the Mac (once)

1. Free up about **40 GB** of disk space.
2. Install Xcode from the Mac App Store. On macOS 14 the newest version that runs is Xcode
   16.2, from developer.apple.com/download/all. If your iPhone runs a much newer iOS than
   Xcode 16.2 knows about, update macOS and install the current Xcode instead.
3. Open Xcode once, accept the licence, and let it install components. If it offers iOS
   platform support, accept.
4. Xcode › Settings › Accounts › **+** › Apple ID, and sign in. A free Apple ID is fine.

## 2. Prepare the project (once)

1. In Finder, open `Turbo Trainer App/Config`, duplicate `Secrets.example.xcconfig`, and
   rename the copy to `Secrets.xcconfig`.
2. Open it in TextEdit. Change the bundle ID to something unique to you, for example
   `SPINDOWN_BUNDLE_ID = com.oliverpugh.spindown`. Delete the `DEVELOPMENT_TEAM` line (you'll
   pick the team in Xcode instead), then save.
3. Double-click `Spindown.xcodeproj` to open it in Xcode.
4. Click the blue **Spindown** project at the top of the left sidebar, then the **Spindown**
   target › **Signing & Capabilities**. Tick "Automatically manage signing" and set Team to
   **your name (Personal Team)**.

## 3. Prepare the iPhone (once)

1. Connect the iPhone to the Mac with a cable and unlock it. Tap **Trust** and enter your passcode.
2. In Xcode's toolbar, click the run destination (next to "Spindown") and choose your iPhone.
   Xcode may spend a few minutes on "Preparing iPhone"; wait for it to finish.
3. Turn on Developer Mode: on the iPhone go to **Settings › Privacy & Security › Developer Mode**,
   switch it on and tap Restart. After the restart, unlock the phone and tap **Turn On**.
   (The option appears only after the phone has been connected to Xcode.)

## 4. Install

1. In Xcode press **Run** (▶ or ⌘R). The first build takes a minute or two.
2. With a free Apple ID, the first launch is blocked with "Untrusted Developer". On the
   iPhone go to **Settings › General › VPN & Device Management**, tap your Apple ID under
   Developer App, and tap **Trust**. Then open Spindown from the home screen.
3. When asked, tap **Allow** for Bluetooth.

You can now unplug the phone. The app stays installed.

## 5. First ride setup (in the app)

1. **Free the sensor.** The inRide accepts only one connection at a time. Force-quit the old
   Kinetic app, nRF Connect, Zwift and so on, on every phone, tablet or computer nearby.
2. Spin the wheel to wake the sensor.
3. **Ride** tab › **⋯** › **Trainer…**, then tap **inRide**. The status bar turns green. From now
   on the app reconnects by itself whenever the wheel turns.
4. **Settings › Garmin Connect › Sign In to Garmin Connect** and log in on Garmin's page.
   Leave "Upload rides automatically" on.
5. After about 10 minutes of warm-up, use **⋯ › Calibrate (spindown)…** so power matches your
   roller tension. Redo it if you change tyre, tyre pressure or roller tension.
6. Mount the phone, press **Start Ride**, and press **Finish › Save Ride** at the end. The ride
   uploads to Garmin Connect straight away, or later if you're offline.

## Keeping it installed

- **Free Apple ID:** iOS stops the app opening **7 days** after install. Reconnect the phone,
  open the project in Xcode and press Run again. This takes under a minute and **keeps all
  your rides and logins**. Don't delete the app from the phone, because that deletes its rides
  (copies already uploaded to Garmin are unaffected).
- **Paid Apple Developer Program ($99/year):** installs last a year, and you can use TestFlight
  to install without a cable.
- **Optional, no cable:** with the phone connected once, open Xcode › Window › Devices and
  Simulators, select the iPhone and tick "Connect via network". Later reinstalls then work
  over Wi-Fi.

## Troubleshooting

| Problem | Fix |
|---|---|
| "Failed to register bundle identifier" | Choose a different `SPINDOWN_BUNDLE_ID` in `Secrets.xcconfig`, then close and reopen the project. |
| "iPhone is not available" or "unsupported OS version" | Your Xcode is too old for the iPhone's iOS. Update macOS and Xcode. |
| No Developer Mode option on the iPhone | Connect the phone to the Mac with Xcode open, select it as the run destination, then look again. |
| The trainer is never found | Spin the wheel. Make sure no other app is connected to it, and check Bluetooth is on. Diagnostics › Scan All BLE Devices shows everything nearby. If it still doesn't appear, remove and refit the inRide battery. |
| Garmin upload says "sign in again" | Settings › Garmin Connect › Sign In Again. Pending rides then upload by themselves. |
| Anything odd with the numbers | Diagnostics › Prepare Diagnostics Bundle › Share, and send the file. |
