# Kinetic inRide BLE protocol

What the Kinetic inRide sensor (Road Machine Smart / Rock and Roll Smart) exposes over
Bluetooth LE, and how Spindown decodes it.

## Sources

| Source | What it gave us |
|---|---|
| [kinetic-fit/sensors-swift-kinetic](https://github.com/kinetic-fit/sensors-swift-kinetic) (`inRide.c`, `inRide.h`, `KineticInRide.m`, SDK 2.3.4) | Kinetic's own decoder in C plus the iOS Objective-C wrapper. **This is the reference implementation.** |
| [kinetic-fit/kinetic-sdk-java](https://github.com/kinetic-fit/kinetic-sdk-java) | Kinetic's Android SDK. Same algorithm with one constant different (below). |
| [kinetic-fit/firmware](https://github.com/kinetic-fit/firmware) | Firmware manifest: the inRide reports model `inRide`, hardware `10`. Last release is **1.2** ("Fix Calibration Issues"). |
| GoldenCheetah `src/Train/KurtInRide.cpp` | An independent app shipping Kinetic's C code unchanged. Confirms it is used in practice and that no System ID is needed to decode. |
| Decompiled Kinetic Fit for Android (`InRideSensor`) | Kinetic's app subscribes to power, reads the System ID and configuration, and does **not** write a configuration on connect. The "calibration ready" speed shown is **33.8 km/h**. |

Spindown's Swift decoder was compiled side by side with Kinetic's `inRide.c` and fed 6,000
packets (3,000 random, 3,000 realistic, covering coasting, the Pro Flywheel and every
calibration state). **The outputs are bit-for-bit identical.** 240 of them are kept as test
vectors in `Packages/InRideKit/Tests/InRideKitTests/KineticReferenceVectors.swift`.

## GATT

| UUID | Name | Properties | Notes |
|---|---|---|---|
| `E9410100-B434-446B-B5CC-36592FC4C724` | inRide Power Service | (advertised) | Not FTMS or Cycling Power. |
| `E9410101-…` | Power | notify, 20 bytes | Obfuscated measurement. 1 Hz by default. |
| `E9410102-…` | Control Point | write with response, 3 to 15 bytes | Commands prefixed by a key derived from the System ID. |
| `E9410104-…` | Configuration | read (/notify), 20 bytes | Plain little-endian. |
| `180A` / `2A23` | System ID | read, 6 bytes | Tied to the nRF MAC. Needed for commands only. |
| `180A` / `2A24 2A25 2A26 2A27 2A28 2A29` | Device Information | read | Model, serial, firmware, hardware, software, manufacturer. |

The sensor is battery powered and **sleeps when the roller stops**; it advertises again once
the wheel turns. Spindown keeps a pending connection open so it reconnects as soon as that
happens.

## Power packet (E9410101)

### De-obfuscation

```
rotation = (b[0] & 0xC0) >> 6
x1 = (rotation + 1) % 4,  x2 = (x1 + 1) % 4
for i in 1...19:  u[i] = b[i] XOR (T[x1][i-1] + T[x2][i-1])
plain[0] = b[0];  for i in 0...18: plain[i+1] = u[T[rotation][i]]
```

`T` is four permutation tables of 1...19 (see `InRideObfuscation.swift`). Despite a comment
in `inRide.h`, the System ID is **not** part of this.

### Plain layout (little-endian)

| Bytes | Field | Meaning |
|---|---|---|
| 0 | bits 7-6 rotation, bits 5-4 state, bits 3-0 command result | State: 0x00 normal, 0x10 spindown idle, 0x20 ready, 0x30 active. Result: 1 ok, 2 unsupported, 3 invalid, 0xA calibration result, 0xF error. |
| 1-3 | interval (u24) | Update interval in 32.768 kHz ticks. |
| 4-7 | ticks (u32) | Time for `revs` roller revolutions, 32.768 kHz ticks. |
| 8 | revs (u8) | |
| 9-12 | ticksPrevious (u32) | Previous window, for deceleration. |
| 13 | revsPrevious (u8) | |
| 14-15 | cadenceRaw (u16) | |
| 16-19 | spindownTicks (u32) | Last spindown time, 32.768 kHz ticks. |

### Physics (Kinetic's model)

- **Speed** km/h = `20012.256849 × revs / ticks` (54 mm nominal roller). Kinetic's Java SDK
  uses `19974.826517` (the measured 169.3287 mm roller), 0.19% lower. Spindown follows the C/iOS SDK.
- **Cadence** rpm = `0.8652 × cadenceRaw + 5.2617` (0 stays 0). This is a *virtual* cadence
  inferred from speed pulses. The iOS SDK smooths it over 3 samples with the newest weighted x2.
- **Spindown applied** = last spindown if within 1.5-2.0 s (standard) or 4.7-6.5 s
  (Pro Flywheel), otherwise 1.75 s.
- **Coasting**: `alpha = (prevSpeed − speed) × (ticks/revs − prevTicks/prevRevs)`; coasting if
  alpha > 200 (standard) or > 20 (Pro Flywheel). Power is 0 while coasting.
- **Power**: with `mph = kph × 0.621371`:
  `raw = 5.244820·mph + 0.019168·mph³`, then
  `drag = a·t_ms·raw·1e-5 + b·t_ms + c` with (a, b, c) = (4.55, −0.1425, 236.20) standard or
  (2.62, −0.021, 104.97) Pro Flywheel, `t_ms` = applied spindown in ms;
  `power = trunc(max(0, raw + drag))`.

## Configuration (E9410104)

`u16 calReady, u16 calStart, u16 calEnd, u16 calDebounce, u32 spindownTicks, u16 updateRate, u16 calibrationUpdateRate`
(then 4 unused bytes). Update rates are in 1/32 s: `0x20` = 1 Hz, `0x10` = 2 Hz, `0x08` = 4 Hz.

## Control point (E9410102)

Key = `[sys[sys[3] % 6], sys[sys[5] % 6]]` from the 6-byte System ID, then:

| Opcode | Command | Payload |
|---|---|---|
| 0x01 | Configure | u16 ×6: 602, 655, 950, 327, updateRate, 0x08 |
| 0x02 | Set name | 3 to 8 ASCII bytes |
| 0x03 | Start spindown calibration | none |
| 0x04 | Stop spindown calibration | none |
| 0x05 | Set spindown time | u32 seconds × 32768 |

Results arrive in the low nibble of byte 0 of a later power packet; two commands between
packets can lose a result. Kinetic advises not to exceed 8 Hz.

## Calibration (spindown)

Start, then the state goes Idle (ride above ~34 km/h) → Ready (stop pedalling) → Active
(coasting, timed between ~31 and ~18 km/h) → Normal. Results: 1.5-2.0 s or 4.7-6.5 s success,
< 1.5 s too fast (loosen the roller), > 6.5 s too slow (tighten), otherwise ambiguous (loosen
with a Pro Flywheel, tighten without).

## Open questions, and how the app helps answer them

- **First-generation vs inRide 2 framing.** Kinetic's SDK targets "inRide 2"; your sensor
  advertises the same service, so the same framing is expected. If the decoded numbers look
  wrong, Diagnostics shows raw and de-obfuscated bytes side by side, and every ride saves a raw
  packet capture (`packets.jsonl`) that can be replayed against the decoder.
- **Battery service.** Not documented; read if present.
- **Configuration notify.** Subscribed only if the characteristic offers it.
