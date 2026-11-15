# Goal: Spindown World, a 3D cycling game replacing Lakes

**End state:** the Windows app's Lakes tab is replaced by **World**, an original 3D cycling game set in the
English countryside and on York's real streets. The rider's trainer power drives a physics-based rider through
detailed 3D scenery. It offers free ride with animated bot riders of different levels, a 3-minute race with a
minimap and a finishing leaderboard, XP and levels that unlock kit and bikes (bikes carry perks), collectable
power-ups, PRs and segment comparisons, speed-zone medals, achievements and challenges. Ride recording is
untouched.

## Requirements

1. **3D engine**: three.js scene with sky, sun lighting and shadows, fog, terrain, road, quality presets, and
   several cameras. It stops rendering when the tab is hidden.
2. **Worlds**:
   - **Yorkshire Dales**: a procedural English-countryside loop with hills, fields, dry-stone walls,
     hedgerows, trees, a village (cottages, church, pub, phone box), a river with a stone bridge, and sheep.
   - **York**: built from OpenStreetMap data (real building footprints, streets, the River Ouse, the city
     walls, the Minster and Clifford's Tower), with a loop on real named streets. Attribution is shown.
3. **Physics**: speed comes from trainer power, rider plus bike mass, gradient, rolling resistance, aero drag
   (CdA) and drafting. Equipment changes these parameters.
4. **Riders**: articulated 3D riders and bikes. Legs pedal at cadence, wheels spin at speed and the rider
   leans in corners. Jersey, helmet and bike colours come from the kit.
5. **Bots**: at least 12 animated bots in free ride. They have tiers (D/C/B/A/Pro, each with a W/kg band)
   shown on nameplates and in the rider list, varied power, drafting and lane changes to overtake.
6. **Race**: a 30-minute race (about 15–18 km, laps of a set York course; a shorter quick race is also offered). It has a grid, a countdown, live positions and gaps, a HUD
   minimap of the whole course with every rider, a finish line and a leaderboard with times. It awards XP
   and podium achievements.
7. **Progression**: XP from distance, time, climbing, races, challenges and achievements. Levels 1–30.
   Unlocks: jerseys, helmets, bikes and wheels. A garage with a 3D preview. Bikes have stats and a perk. The
   profile persists across restarts.
8. **Power-ups**: pickups along the course, one held at a time, used with Space or a click. Each has a
   timed effect on physics or drafting. Bots get them in races too.
9. **PRs and segments**: named segments with best times. A live delta against the PR at checkpoints. A PR
   "ghost" rider to race.
10. **Speed zones and achievements**: speed-trap and KOM zones with bronze, silver and gold medals by
    average speed. An achievement list and rotating challenges, with notifications.
11. **Everything else a full game has**: a home menu, route picker, HUD (power, speed, cadence, HR,
    distance, time, gradient, elevation profile, nearby-rider list), a rider list, workouts carried over
    from Lakes (FTP targets), time of day and weather, sound with a mute control, and a quality setting.
12. **Recording isolation**: the game only reads trainer and HR data and uses the same
    Start/Pause/Finish controls. A game exception or WebGL failure must never stop recording.
13. **Demo**: a recorded video of free ride and of a race (the 30-minute race shown sped up, with clips at real speed), driven by simulated trainer input through the
    real Bluetooth code path, plus a command to run the same demo live.

## Verification parameters

| # | Check | How |
|---|---|---|
| V1 | Unit tests pass, including new game logic (physics, drafting, bots, race results, XP/levels/unlocks, power-ups, segments/PRs, speed zones, profile load/save) | `npm test` |
| V2 | Renderer builds | `npm run build` |
| V3 | World tab renders 3D: a WebGL canvas with varied pixels (not blank), ≥ 30 fps at the default quality on this Mac, no page errors | e2e `game.cjs` |
| V4 | Free ride: ≥ 12 bots, ≥ 4 tiers shown, bots move, rider and bot legs animate, HUD power matches the simulated trainer | e2e |
| V5 | Race: countdown, minimap with all riders, finish, leaderboard sorted by time (e2e, run with the test-only time speed-up); the full race simulated second by second takes 27–33 minutes at a typical power (unit test) | e2e + unit |
| V6 | XP rises when riding; a level-up unlocks an item; equipping a bike changes physics; the profile survives a restart | unit + e2e |
| V7 | A power-up is collected, then used, and its effect applies for its duration | unit + e2e |
| V8 | Segment PR stored; a later pass shows the delta; ghost present | unit + e2e |
| V9 | A speed zone awards a medal and an achievement notification | unit + e2e |
| V10 | York data comes from OSM: ≥ 500 real building footprints, and the route follows named real streets; attribution visible | data check + e2e |
| V11 | Recording unaffected: while recording with the game open, the saved ride has one sample per second with no gaps; a forced game exception leaves recording running; the earlier 17-check e2e still passes | e2e |
| V12 | Demo videos exist for free ride and a race, driven by simulated trainer packets, and have been watched (frames inspected) | files + screenshots |
| V13 | The Windows CI build (tests and installer) passes on the PR | GitHub Actions |
