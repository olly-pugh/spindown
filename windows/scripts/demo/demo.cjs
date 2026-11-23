// Spindown World demo: launches the app with a simulated Kinetic inRide trainer and heart-rate strap (fake
// Bluetooth, so packets go through the real connection, decoding and recording code) and plays a scripted
// session: free ride in York, cameras, a power-up, a speed-zone sprint, the Yorkshire Dales climb and
// descent, then the 30-minute York Grand Prix (start and finish at real speed, the middle sped up) with its
// leaderboard, and the garage and progress screens. Captions explain what the "rider" is doing.
//
//   npm run demo                      watch it live
//   npm run demo -- --record <dir>    also save a video (.webm) of the window
//
// Development and demonstration only: nothing here ships in the installer.
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');

const APP = path.join(__dirname, '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const args = process.argv.slice(2);
const recordDir = args.includes('--record') ? path.resolve(args[args.indexOf('--record') + 1] || 'demo-video') : null;
const SIZE = { width: 1440, height: 900 };

async function main() {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'spindown-demo-'));
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({
    onboarded: true, autoConnect: true, trainerID: 'AA:BB:CC:DD:EE:01', trainerName: 'inRide 4F2A', hrmID: 'AA:BB:CC:DD:EE:02', hrmName: 'Polar H9 1A2B3C4D', ftp: 240,
  }));
  if (recordDir) fs.mkdirSync(recordDir, { recursive: true });
  const app = await electron.launch({
    executablePath: require('electron'),
    args: [APP],
    env: { ...process.env, SPINDOWN_USER_DATA: data, SPINDOWN_TEST_PRELOAD: path.join(__dirname, 'simulated-trainer-preload.cjs') },
    recordVideo: recordDir ? { dir: recordDir, size: SIZE } : undefined,
  });
  const page = await app.firstWindow();
  await page.waitForFunction(() => !!window.__spindownApp && !!window.__fake, null, { timeout: 30000 });
  await app.evaluate(({ BrowserWindow }, s) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.unmaximize();
    w.setContentSize(s.width, s.height);
    w.center();
  }, SIZE);

  // ---- The simulated trainer: inRide packets at 1 Hz for a target power, plus heart rate ----
  const { InRideSimulator } = await import(path.join(APP, 'src/core/sensors.js'));
  const { powerForSpeed } = await import(path.join(APP, 'src/core/decoder.js'));
  const speedFor = (watts) => {
    if (watts <= 0) return 0;
    let lo = 0, hi = 95;
    for (let i = 0; i < 50; i++) {
      const mid = (lo + hi) / 2;
      if (powerForSpeed(mid, 1.75) < watts) lo = mid;
      else hi = mid;
    }
    return lo;
  };
  const sim = new InRideSimulator();
  const ctl = { power: 0, cadence: 90, stop: false };
  let hr = 95;
  const announced = new Set();
  (async () => {
    let next = Date.now();
    while (!ctl.stop) {
      try {
        const p = await page.evaluate(() => window.__fake.take());
        if (p && !announced.has(p.id)) {
          announced.add(p.id);
          const list = await page.evaluate((options) => {
            const f = window.__fake;
            const has = (svc) => (options.filters || []).some((x) => (x.services || []).some((s) => String(s).toLowerCase() === svc));
            const out = [];
            if (!f.inride.gatt.connected && (options.acceptAllDevices || has('e9410100-b434-446b-b5cc-36592fc4c724') || (options.filters || []).some((x) => x.namePrefix && f.inride.name.startsWith(x.namePrefix)))) out.push({ deviceId: f.inride.chooserId, deviceName: f.inride.name });
            if (!f.strap.gatt.connected && (options.acceptAllDevices || has('6157') || has('heart_rate'))) out.push({ deviceId: f.strap.chooserId, deviceName: f.strap.name });
            return out;
          }, p.options);
          if (list.length) {
            await app.evaluate(({ BrowserWindow }, { list, id }) => {
              const wc = BrowserWindow.getAllWindows()[0].webContents;
              wc.emit('select-bluetooth-device', { preventDefault() {} }, list, (chosen) => wc.executeJavaScript(`window.__fake.resolve(${id}, ${JSON.stringify(chosen)})`));
            }, { list, id: p.id });
          } else announced.delete(p.id);
        }
        if (Date.now() >= next) {
          next += 1000;
          if (Date.now() > next + 2000) next = Date.now() + 1000;
          const watts = Math.max(0, (typeof ctl.power === 'function' ? ctl.power() : ctl.power) + (Math.random() - 0.5) * 8);
          hr += ((95 + watts * 0.28) - hr) * 0.06;
          await page.evaluate(({ b, h }) => { window.__fake.powerChar.emit(b); window.__fake.hrChar.emit([0x06, h]); }, { b: sim.nextPacket(speedFor(watts), watts > 20 ? ctl.cadence : 0), h: Math.round(hr) });
        }
      } catch {
        // window busy or closing
      }
      await sleep(100);
    }
  })();

  // ---- Helpers ----
  const W = (fn, arg) => page.evaluate(fn, arg);
  const started = Date.now();
  const caption = (text, sub = '') => (text && console.log(`[${((Date.now() - started) / 1000).toFixed(0)} s] ${text}`), W(([t, s]) => {
    let el = document.getElementById('demo-caption');
    if (!el) {
      el = document.createElement('div');
      el.id = 'demo-caption';
      el.style.cssText = 'position:fixed;left:50%;bottom:118px;transform:translateX(-50%);z-index:9999;background:rgba(0,0,0,0.78);color:#fff;padding:10px 20px;border-radius:12px;font:600 19px Segoe UI,system-ui,sans-serif;text-align:center;pointer-events:none;max-width:70%;box-shadow:0 6px 24px rgba(0,0,0,0.4)';
      document.body.appendChild(el);
    }
    el.innerHTML = t ? `${t}${s ? `<div style="font-weight:500;font-size:14px;color:#cfd3da;margin-top:3px">${s}</div>` : ''}` : '';
    el.style.display = t ? 'block' : 'none';
  }, [text, sub]));
  const camera = (c) => W((c) => { window.__spindownWorld.profile.settings.camera = c; }, c);
  const timeScale = (k) => W((k) => { window.__spindownWorld.timeScale = k; }, k);
  const teleport = (fraction, speed = 9) => W(([f, v]) => { const s = window.__spindownWorld.sim; s.player.d = Math.floor(s.player.d / s.route.length) * s.route.length + f * s.route.length; s.player.v = v; s.lapStart = null; }, [fraction, speed]);
  const waitFor = async (fn, ms, arg) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (await W(fn, arg)) return true;
      await sleep(250);
    }
    return false;
  };
  const menu = async () => {
    await page.getByRole('button', { name: /Menu/ }).click();
    await sleep(900);
  };

  // ---- Script ----
  await waitFor(() => window.__spindownApp.trainer.state.kind === 'streaming', 30000);
  ctl.power = 0;
  await page.getByText('World', { exact: true }).click();
  await sleep(1200);
  await caption('Spindown World', 'Simulated Kinetic trainer and heart-rate strap, through the app\'s real Bluetooth code');
  await sleep(7000);

  await page.getByRole('button', { name: /^Ride York/ }).click();
  ctl.power = () => 230 + 25 * Math.sin(Date.now() / 9000);
  await caption('Free ride in York: the real inner ring road', 'Built from OpenStreetMap: 3,000+ real buildings, the city walls and the Ouse · trainer ≈ 230 W');
  await sleep(13000);
  await camera('close');
  await caption('Close camera', 'Legs follow the pedals at the trainer\'s cadence; wheels turn with speed');
  await sleep(7000);
  await camera('side');
  await caption('Side camera', 'The regulars ride with you: Og Pog, Grandma, Big Al, Pootle and co.');
  await sleep(7000);
  await camera('cinematic');
  await caption('TV camera', 'Cuts between angles every few seconds');
  await sleep(12000);
  await camera('chase');

  // A power-up: ride into a gift and use it.
  await teleport(330 / 4531, 9);
  await caption('Ride through a gift to pick up a power-up');
  await waitFor(() => window.__spindownWorld.sim.player.held.length > 0, 25000);
  await sleep(1500);
  await caption('Power-up collected', 'Press Space (or click it) to use it');
  await sleep(2500);
  await page.keyboard.press('Space');
  await caption('Power-up used', 'Its effect counts down in the bottom-left corner');
  await sleep(6000);

  // A speed-zone sprint.
  const sprint = await W(() => window.__spindownWorld.sim.route.zones[0]);
  await teleport((sprint.from - 140) / 4531, 10);
  ctl.power = 300;
  await caption(`Coming up: ${sprint.name}`, 'A timed speed zone with bronze, silver and gold');
  await sleep(6000);
  ctl.power = 520;
  await caption('Sprint! 520 W', 'Medal times are shown as you enter the zone');
  await waitFor((name) => window.__spindownWorld.eventLog.some((e) => e.type === 'segment-end' && e.name === name), 40000, sprint.name);
  ctl.power = 240;
  await caption('Zone finished: medal, PR and XP', 'Medals, PRs and achievements all earn XP');
  await sleep(6000);

  // Past the Minster and over Lendal Bridge.
  await teleport(0.165, 9);
  ctl.power = 250;
  await caption('Past York Minster towards Lendal Bridge');
  await sleep(10000);
  await camera('aerial');
  await caption('Aerial camera');
  await sleep(8000);
  await camera('chase');
  await sleep(6000);

  // The Dales.
  await menu();
  await caption('The menu: free rides, races, workouts, garage and progress');
  await sleep(4500);
  await page.locator('.mcard', { hasText: 'Free Ride · Yorkshire Dales' }).click();
  ctl.power = 220;
  await caption('Free ride in the Yorkshire Dales: Malham', 'The real village, walls, barns and hills, from OpenStreetMap, LIDAR and Sentinel-2 imagery');
  await sleep(10000);
  await teleport(0.12, 6);
  await caption('Cove Road, past Malham Cove', 'The great limestone cliff on the right');
  await sleep(7000);
  await teleport(0.16, 5);
  ctl.power = 300;
  await caption('Climbing Cove Road: 300 W', '1.6 km at 10%: gradient changes your speed; dry-stone walls all the way up');
  await sleep(12000);
  await camera('side');
  await sleep(7000);
  await camera('chase');
  await teleport(0.86, 8);
  ctl.power = 60;
  await caption('Down Malham Rakes into the village', 'Freewheeling: legs stop, speed builds on the descent');
  await sleep(10000);
  await camera('cinematic');
  await sleep(9000);
  await camera('chase');

  // The race.
  await menu();
  await page.locator('.mcard.race', { hasText: 'York Grand Prix' }).click();
  ctl.power = 0;
  await caption('York Grand Prix: a 30-minute race', '21 riders on the grid. Og Pog is the favourite.');
  await sleep(6000);
  await page.getByRole('button', { name: 'Start the countdown' }).click();
  await caption('Countdown', 'Starting the race also starts recording, so it goes to Garmin like any ride');
  await sleep(8500);
  ctl.power = 420;
  await waitFor(() => window.__spindownWorld.eventLog.some((e) => e.type === 'go'), 15000);
  await caption('GO! Real speed for the start', 'Race position, gaps and the full course on the minimap');
  await sleep(14000);
  ctl.power = 280;
  await camera('cinematic');
  await caption('The bunch settles down', 'Drafting behind other riders saves energy');
  await sleep(14000);
  await camera('chase');
  ctl.power = () => 250 + 30 * Math.sin(Date.now() / 4000);
  await timeScale(30);
  await caption('Sped up 30× through the middle of the race', 'Everything else is real: physics, drafting, bots, positions, power-ups');
  await waitFor(() => { const s = window.__spindownWorld.sim; return s.race.finishD - s.player.d < 900; }, 240000);
  await timeScale(1);
  ctl.power = 330;
  await caption('Back to real speed: under a kilometre to go');
  await sleep(6000);
  await camera('cinematic');
  ctl.power = 560;
  await caption('The sprint for the line: 560 W');
  await waitFor(() => window.__spindownWorld.sim.race.phase === 'finished', 120000);
  await camera('chase');
  await caption('Finished: the leaderboard', 'XP for the finish and the place; podiums and wins unlock kit');
  await sleep(11000);
  await caption('');
  await page.getByRole('button', { name: 'Keep riding' }).click();
  ctl.power = 200;
  await sleep(1500);
  await menu();
  await page.getByRole('button', { name: /Garage/ }).click();
  await caption('The garage', 'New levels unlock jerseys, helmets, wheels and bikes; each bike has a perk');
  await sleep(4000);
  const sportive = page.locator('.item-card', { hasText: 'Dales Sportive' });
  if (!(await sportive.isDisabled())) await sportive.click();
  await sleep(3000);
  await page.locator('.segmented button', { hasText: 'Jerseys' }).click();
  await sleep(2500);
  const jersey = page.locator('.item-card:not(.locked)', { hasText: 'White Rose' });
  if (await jersey.count()) await jersey.first().click();
  await sleep(4000);
  await page.getByRole('button', { name: 'Done' }).click();
  await sleep(500);
  await menu();
  await page.getByRole('button', { name: /Progress/ }).click();
  await caption('Progress: level, challenges, achievements, PRs and medals');
  await sleep(9000);
  await caption('');
  await page.keyboard.press('Escape');
  await sleep(500);
  // Finish the recording (it saves like any other ride).
  await page.getByRole('button', { name: /Close|Done/ }).first().click().catch(() => {});
  await sleep(500);
  ctl.stop = true;
  await sleep(300);
  await app.close();
  if (recordDir) console.log(`Video saved in ${recordDir}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
