// The Lake District ride: per-frame state and the cartoon renderer. Ports of GameEngine.swift and
// WorldRenderer.swift. It only reads trainer data; it never changes the recording.
import * as Lakes from '../../core/lakes.js';

const { hash01: hash, ridge } = Lakes;
const WHEEL_RADIUS = 0.34; // metres, 700c
/** Screen pixels per metre for the road layer; far layers move proportionally slower. */
const PX_PER_METRE = 9.0;

export class GameEngine {
  constructor() {
    this.odometer = 0;
    this.speed = 0;
    this.wheelAngle = 0;
    this.crankAngle = 0;
    this.time = 0;
    this.workoutElapsed = 0;
    this.banner = null; // {text, at}
    this.sheepCount = 0;
    this.particles = [];
    this.confettiUntil = 0;
    this._workout = null;
    this.lastDate = null;
    this.lastSheepIndex = null;
  }

  get workout() {
    return this._workout;
  }
  set workout(w) {
    this._workout = w;
    this.workoutElapsed = 0;
  }

  /** Advances the world to `now` (ms). targetSpeed in m/s (0 when no fresh data), cadence in rpm. */
  step(now, targetSpeed, cadence, recording) {
    const dt = this.lastDate == null ? 0 : Math.min(Math.max((now - this.lastDate) / 1000, 0), 0.1);
    this.lastDate = now;
    this.time += dt;
    // Ease towards the trainer's speed so 1-4 Hz updates look continuous.
    this.speed += (targetSpeed - this.speed) * Math.min(1, dt * 2.5);
    if (targetSpeed === 0 && this.speed < 0.05) this.speed = 0;
    const before = this.odometer;
    this.odometer += this.speed * dt;
    this.wheelAngle += (this.speed / WHEEL_RADIUS) * dt;
    this.crankAngle += (cadence / 60) * 2 * Math.PI * dt;
    if (recording && this._workout) this.workoutElapsed += dt;

    for (const l of Lakes.landmarksPassed(before, this.odometer)) {
      const lap = Lakes.lap(this.odometer);
      this.celebrate(l.kind === 'start' && this.odometer > 10 ? `Lap ${lap}! Back at Windermere` : l.message);
    }
    // A sheep every ~37 m of verge; count the ones ridden past.
    const sheepIndex = Math.floor(this.odometer / 37);
    if (this.lastSheepIndex != null && sheepIndex > this.lastSheepIndex) {
      for (let i = this.lastSheepIndex + 1; i <= sheepIndex; i++) if (hash(i * 7 + 3) > 0.72) this.sheepCount++;
    }
    this.lastSheepIndex = sheepIndex;
    this.updateParticles(dt);
  }

  celebrate(text) {
    this.banner = { text, at: this.time };
    this.confettiUntil = this.time + 1.5;
  }

  updateParticles(dt) {
    for (const p of this.particles) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 120 * dt;
      p.life -= dt;
    }
    this.particles = this.particles.filter((p) => p.life > 0);
    // Road spray behind the rear wheel, more when fast.
    if (this.speed > 1 && this.particles.length < 60 && hash(Math.floor(this.time * 1000)) < Math.min(0.9, this.speed / 12)) {
      this.particles.push({ x: 0, y: 0, vx: -40 - this.speed * 6, vy: -30 - 40 * hash(Math.floor(this.time * 997)), life: 0.6, hue: 0 });
    }
    if (this.time < this.confettiUntil && this.particles.length < 90) {
      const seed = Math.floor(this.time * 1000);
      this.particles.push({ x: hash(seed) * 400 - 200, y: -260, vx: hash(seed + 1) * 80 - 40, vy: 60 + hash(seed + 2) * 80, life: 2.2, hue: hash(seed + 3) });
    }
  }
}

const rgb = (r, g, b, a = 1) => `rgba(${r},${g},${b},${a})`;

function line(g, points, color, width) {
  g.strokeStyle = color;
  g.lineWidth = width;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.beginPath();
  points.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
  g.stroke();
}

function ellipse(g, x, y, w, h, color) {
  g.fillStyle = color;
  g.beginPath();
  g.ellipse(x + w / 2, y + h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, 0, Math.PI * 2);
  g.fill();
}

function rect(g, x, y, w, h, color) {
  g.fillStyle = color;
  g.fillRect(x, y, w, h);
}

export function drawWorld(g, w, h, e) {
  const horizon = h * 0.47;
  const roadTop = h * 0.78;
  const riderX = w * 0.3;
  const s = Math.min(w, h) / 380; // cyclist scale
  const o = e.odometer * PX_PER_METRE;

  drawSky(g, w, horizon, e.time, o);
  drawFells(g, w, horizon + 6, h * 0.2, 0.05, o, riderX, 1.7, rgb(122, 148, 176), rgb(150, 172, 196));
  drawFells(g, w, horizon + 14, h * 0.13, 0.13, o, riderX, 4.2, rgb(96, 128, 92), rgb(124, 150, 104));
  drawWater(g, w, horizon + 10, horizon + h * 0.13, roadTop, 0.3, o, riderX, e);
  drawNearHills(g, w, horizon + h * 0.12, roadTop, 0.55, o, riderX, s);
  drawVillage(g, w, roadTop - 4 * s, 0.75, o, riderX, s, e);
  drawRoad(g, w, h, roadTop, o, s);
  drawLandmarks(g, w, roadTop, o, riderX, s, e);
  const contactY = roadTop + 22 * s;
  drawSpeedLines(g, w, h, horizon, e);
  drawParticles(g, riderX, contactY, w, h, s, e);
  drawCyclist(g, riderX, contactY, s, e);
}

function drawSky(g, w, horizon, time, o) {
  const grad = g.createLinearGradient(0, 0, 0, horizon + 40);
  grad.addColorStop(0, rgb(70, 150, 225));
  grad.addColorStop(0.5, rgb(150, 205, 245));
  grad.addColorStop(1, rgb(225, 240, 250));
  g.fillStyle = grad;
  g.fillRect(0, 0, w, horizon + 40);
  const sun = [w * 0.82, horizon * 0.28];
  for (const [r, a] of [[70, 0.1], [48, 0.18], [30, 1]]) ellipse(g, sun[0] - r, sun[1] - r, 2 * r, 2 * r, rgb(255, 236, 140, a));
  const spacing = 260;
  const shift = o * 0.03 + time * 6;
  const first = Math.floor((shift - 200) / spacing);
  for (let k = first; k <= first + Math.floor(w / spacing) + 3; k++) {
    if (!(hash(k * 13) > 0.25)) continue;
    const x = k * spacing - shift + 60 * hash(k * 5);
    const y = horizon * (0.12 + 0.45 * hash(k * 17));
    const size = 0.7 + 0.6 * hash(k * 23);
    for (const [dx, dy, r] of [[0, 0, 26], [26, -10, 30], [54, 0, 24], [26, 8, 26]]) {
      const rr = r * size;
      ellipse(g, x + dx * size - rr, y + dy * size - rr * 0.7, 2 * rr, 1.4 * rr, 'rgba(255,255,255,0.92)');
    }
  }
}

function drawFells(g, w, base, amp, p, o, riderX, seed, fill, ridgeTint) {
  g.beginPath();
  g.moveTo(0, base + 60);
  for (let x = 0; x <= w + 6; x += 6) g.lineTo(x, base - amp * ridge(o * p + (x - riderX), seed));
  g.lineTo(w, base + 60);
  g.closePath();
  g.fillStyle = fill;
  g.fill();
  g.strokeStyle = ridgeTint;
  g.lineWidth = 2;
  g.stroke();
}

function drawWater(g, w, top, bottom, groundBottom, p, o, riderX, e) {
  // Meadow under everything down to the road, so no sky shows through anywhere.
  rect(g, 0, top, w, groundBottom - top, rgb(150, 190, 100));
  const slices = 120;
  const sliceW = Math.ceil(w / slices);
  const amounts = [];
  for (let i = 0; i < slices; i++) {
    const x = i * sliceW;
    const metres = e.odometer + (x + sliceW / 2 - riderX) / (PX_PER_METRE * p);
    amounts.push(Math.round(Lakes.lakeAmount(metres) * 40) / 40);
  }
  for (let i = 0; i < slices; ) {
    let j = i;
    while (j + 1 < slices && amounts[j + 1] === amounts[i]) j++;
    if (amounts[i] > 0) {
      const grad = g.createLinearGradient(0, top, 0, bottom);
      grad.addColorStop(0, rgb(90, 150, 200, amounts[i]));
      grad.addColorStop(1, rgb(40, 100, 160, amounts[i]));
      g.fillStyle = grad;
      g.fillRect(i * sliceW, top, (j - i + 1) * sliceW, bottom - top);
    }
    i = j + 1;
  }
  // Shimmer and the odd sailing boat on the water.
  const shimmerShift = o * p + e.time * 12;
  for (let k = 0; k < 40; k++) {
    const x = (k * 53 - shimmerShift) % (w + 60);
    const xx = x < 0 ? x + w + 60 : x;
    const metres = e.odometer + (xx - riderX) / (PX_PER_METRE * p);
    if (!(Lakes.lakeAmount(metres) > 0.5)) continue;
    const y = top + 6 + (bottom - top - 12) * hash(k * 3);
    line(g, [[xx, y], [xx + 14 + 10 * hash(k), y]], 'rgba(255,255,255,0.55)', 1.5);
  }
  const boatSpacing = 900;
  const first = Math.floor((o * p - riderX) / boatSpacing) - 1;
  for (let k = first; k <= first + Math.floor(w / boatSpacing) + 2; k++) {
    if (!(hash(k * 41) > 0.5)) continue;
    const x = k * boatSpacing - o * p + riderX + e.time * 4;
    const metres = e.odometer + (x - riderX) / (PX_PER_METRE * p);
    if (!(Lakes.lakeAmount(metres) > 0.8)) continue;
    const y = top + (bottom - top) * 0.55;
    g.fillStyle = rgb(140, 60, 40);
    g.beginPath();
    g.moveTo(x - 14, y); g.lineTo(x + 14, y); g.lineTo(x + 9, y + 6); g.lineTo(x - 9, y + 6); g.closePath();
    g.fill();
    g.fillStyle = '#fff';
    g.beginPath();
    g.moveTo(x, y - 26); g.lineTo(x, y - 2); g.lineTo(x + 14, y - 2); g.closePath();
    g.fill();
  }
}

const nearHillY = (u, top) => top + 14 + 16 * Math.sin(u * 0.006) + 8 * Math.sin(u * 0.017 + 1);

function drawNearHills(g, w, top, bottom, p, o, riderX, s) {
  g.beginPath();
  g.moveTo(0, bottom + 10);
  for (let x = 0; x <= w + 6; x += 6) g.lineTo(x, nearHillY(o * p + x - riderX, top));
  g.lineTo(w, bottom + 10);
  g.closePath();
  const grad = g.createLinearGradient(0, top, 0, bottom);
  grad.addColorStop(0, rgb(120, 180, 70));
  grad.addColorStop(1, rgb(80, 140, 50));
  g.fillStyle = grad;
  g.fill();

  // Dry-stone wall following the hillside.
  const wall = [];
  for (let x = 0; x <= w + 6; x += 6) wall.push([x, nearHillY(o * p + x - riderX, top) + 26]);
  line(g, wall, rgb(140, 140, 135), 5 * s);
  g.setLineDash([3 * s, 5 * s]);
  line(g, wall, rgb(95, 95, 92), 1.5 * s);
  g.setLineDash([]);

  // Trees.
  const treeSpacing = 70;
  let first = Math.floor((o * p - riderX - 60) / treeSpacing);
  for (let k = first; k <= first + Math.floor(w / treeSpacing) + 3; k++) {
    if (!(hash(k * 11) > 0.45)) continue;
    const tx = k * treeSpacing + 30 * hash(k * 3) - o * p + riderX;
    const base = nearHillY(o * p + tx - riderX, top) + 18;
    const size = (0.8 + 0.5 * hash(k * 19)) * s;
    rect(g, tx - 2 * size, base - 16 * size, 4 * size, 16 * size, rgb(100, 70, 45));
    for (const [dx, dy, r, shade] of [[-7, -20, 10, 0], [6, -22, 11, 0.08], [0, -32, 11, 0.15]]) {
      ellipse(g, tx + dx * size - r * size, base + dy * size - r * size, 2 * r * size, 2 * r * size, rgb(40 + 60 * shade, 105 + 60 * shade, 50));
    }
  }

  // Sheep (the HUD counts the ones you pass).
  const sheepSpacing = 37 * PX_PER_METRE * p;
  first = Math.floor((o * p - riderX - 60) / sheepSpacing);
  for (let k = first; k <= first + Math.floor(w / sheepSpacing) + 3; k++) {
    if (!(hash(k * 7 + 3) > 0.72)) continue;
    const sx = k * sheepSpacing - o * p + riderX;
    const sy = nearHillY(o * p + sx - riderX, top) + 40 + 8 * hash(k);
    const b = s;
    ellipse(g, sx - 9 * b, sy - 6 * b, 18 * b, 12 * b, '#fff');
    ellipse(g, sx + 6 * b, sy - 8 * b, 7 * b, 6 * b, rgb(30, 30, 30));
    for (const lx of [-5, 4]) rect(g, sx + lx * b, sy + 4 * b, 2 * b, 5 * b, rgb(30, 30, 30));
  }
}

function drawVillage(g, w, ground, p, o, riderX, s, e) {
  if (!(Lakes.villageAmount(e.odometer) > 0 || Lakes.villageAmount(e.odometer + 60) > 0)) return;
  const spacing = 80;
  const first = Math.floor((o * p - riderX - 80) / spacing);
  for (let k = first; k <= first + Math.floor(w / spacing) + 3; k++) {
    const cx = k * spacing - o * p + riderX;
    const metres = e.odometer + (cx - riderX) / (PX_PER_METRE * p);
    if (!(Lakes.villageAmount(metres) > 0.25 + 0.5 * hash(k * 29))) continue;
    const cw = (34 + 16 * hash(k)) * s;
    const ch = (22 + 8 * hash(k * 2)) * s;
    const minX = cx - cw / 2, minY = ground - ch, maxX = cx + cw / 2, midX = cx;
    rect(g, minX, minY, cw, ch, hash(k * 3) > 0.4 ? rgb(245, 243, 235) : rgb(160, 160, 155));
    g.fillStyle = rgb(70, 75, 85);
    g.beginPath();
    g.moveTo(minX - 4 * s, minY); g.lineTo(midX, minY - 14 * s); g.lineTo(maxX + 4 * s, minY); g.closePath();
    g.fill();
    rect(g, maxX - 9 * s, minY - 16 * s, 5 * s, 10 * s, rgb(110, 100, 95));
    rect(g, midX - 3 * s, ground - 11 * s, 6 * s, 11 * s, hash(k * 5) > 0.5 ? rgb(40, 90, 60) : rgb(150, 30, 40));
    for (const wx of [minX + 5 * s, maxX - 11 * s]) rect(g, wx, minY + 5 * s, 6 * s, 6 * s, rgb(90, 140, 180));
  }
}

function drawRoad(g, w, h, roadTop, o, s) {
  rect(g, 0, roadTop - 6 * s, w, 6 * s, rgb(90, 150, 60));
  const roadH = h * 0.14;
  rect(g, 0, roadTop, w, roadH, rgb(85, 88, 95));
  rect(g, 0, roadTop, w, 2 * s, 'rgba(255,255,255,0.8)');
  const dash = 34, gap = 30, period = dash + gap;
  const midY = roadTop + roadH / 2;
  for (let x = -(o % period); x < w; x += period) rect(g, x, midY - 1.5 * s, dash, 3 * s, rgb(240, 220, 120));
  rect(g, 0, roadTop + roadH, w, h - roadTop - roadH, rgb(95, 155, 60));
}

function drawLandmarks(g, w, roadTop, o, riderX, s, e) {
  const lapStart = Math.floor(e.odometer / Lakes.LAP_LENGTH) * Lakes.LAP_LENGTH;
  for (const offset of [-Lakes.LAP_LENGTH, 0, Lakes.LAP_LENGTH]) {
    for (const l of Lakes.LANDMARKS) {
      const x = (lapStart + offset + l.distance) * PX_PER_METRE - o + riderX;
      if (!(x > -200 && x < w + 200)) continue;
      if (l.kind === 'start') drawArch(g, x, roadTop, s, Lakes.lap(lapStart + offset + 1));
      else drawSign(g, x, roadTop, s, l.name);
    }
  }
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
}

function drawSign(g, x, roadTop, s, text) {
  rect(g, x - 2 * s, roadTop - 60 * s, 4 * s, 56 * s, rgb(70, 70, 70));
  const bx = x - 60 * s, by = roadTop - 86 * s, bw = 120 * s, bh = 30 * s;
  roundRect(g, bx, by, bw, bh, 4 * s);
  g.fillStyle = rgb(0, 110, 70);
  g.fill();
  roundRect(g, bx + 2 * s, by + 2 * s, bw - 4 * s, bh - 4 * s, 3 * s);
  g.strokeStyle = '#fff';
  g.lineWidth = 1.5 * s;
  g.stroke();
  g.fillStyle = '#fff';
  g.font = `bold ${11 * s}px "Segoe UI", system-ui, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, bx + bw / 2, by + bh / 2, bw - 8 * s);
}

function drawArch(g, x, roadTop, s, lap) {
  for (const px of [x - 70 * s, x + 64 * s]) rect(g, px, roadTop - 110 * s, 6 * s, 140 * s, rgb(60, 60, 60));
  const bx = x - 76 * s, by = roadTop - 128 * s, bw = 152 * s, bh = 26 * s;
  const cell = 6.5 * s;
  for (let cy = by, row = 0; cy < by + bh; cy += cell, row++) {
    for (let cx = bx, col = 0; cx < bx + bw; cx += cell, col++) {
      rect(g, cx, cy, Math.min(cell, bx + bw - cx), Math.min(cell, by + bh - cy), (row + col) % 2 === 0 ? '#000' : '#fff');
    }
  }
  const lx = x - 52 * s, ly = roadTop - 124 * s, lw = 104 * s, lh = 18 * s;
  roundRect(g, lx, ly, lw, lh, 3 * s);
  g.fillStyle = rgb(220, 40, 40);
  g.fill();
  g.fillStyle = '#fff';
  g.font = `900 ${11 * s}px "Segoe UI", system-ui, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(lap === 1 ? 'WINDERMERE' : `LAP ${lap}`, lx + lw / 2, ly + lh / 2);
}

function drawSpeedLines(g, w, h, horizon, e) {
  const kph = e.speed * 3.6;
  if (!(kph > 28)) return;
  const strength = Math.min(1, (kph - 28) / 8);
  for (let k = 0; k < 14; k++) {
    const y = horizon * 0.3 + (h * 0.75 - horizon * 0.3) * hash(k * 37);
    const len = 40 + 80 * hash(k * 3);
    const x = w + 200 - ((e.time * (500 + 300 * hash(k)) + 150 * k) % (w + 300));
    line(g, [[x, y], [x + len, y]], `rgba(255,255,255,${0.35 * strength})`, 2);
  }
}

function drawParticles(g, riderX, contactY, w, h, s, e) {
  for (const p of e.particles) {
    if (p.hue === 0) {
      ellipse(g, riderX - 34 * s + p.x * s * 0.4, contactY + p.y * s * 0.2, 3 * s, 3 * s, `rgba(255,255,255,${0.4 * p.life})`);
    } else {
      g.fillStyle = `hsla(${p.hue * 360},90%,55%,${Math.min(1, p.life)})`;
      g.fillRect(w / 2 + p.x, h * 0.45 + p.y, 6, 9);
    }
  }
}

function knee(hip, foot, thigh, shin) {
  const dx = foot[0] - hip[0], dy = foot[1] - hip[1];
  const d = Math.min(Math.max(Math.hypot(dx, dy), Math.abs(thigh - shin) + 0.01), thigh + shin - 0.01);
  const a = Math.acos((thigh * thigh + d * d - shin * shin) / (2 * thigh * d));
  const phi = Math.atan2(dy, dx);
  const k1 = [hip[0] + thigh * Math.cos(phi + a), hip[1] + thigh * Math.sin(phi + a)];
  const k2 = [hip[0] + thigh * Math.cos(phi - a), hip[1] + thigh * Math.sin(phi - a)];
  return k1[0] > k2[0] ? k1 : k2; // knees point forward
}

function drawWheel(g, c, r, s, angle) {
  g.strokeStyle = rgb(25, 25, 25);
  g.lineWidth = 4 * s;
  g.beginPath(); g.arc(c[0], c[1], r, 0, Math.PI * 2); g.stroke();
  g.strokeStyle = rgb(190, 190, 195);
  g.lineWidth = 1.2 * s;
  g.beginPath(); g.arc(c[0], c[1], r - 2.5 * s, 0, Math.PI * 2); g.stroke();
  for (let i = 0; i < 8; i++) {
    const a = angle + (i * Math.PI) / 4;
    const spoke = r - 3 * s;
    line(g, [c, [c[0] + spoke * Math.cos(a), c[1] + spoke * Math.sin(a)]], rgb(200, 200, 205), 0.8 * s);
  }
  ellipse(g, c[0] - 2.5 * s, c[1] - 2.5 * s, 5 * s, 5 * s, rgb(60, 60, 60));
}

function drawCyclist(g, x, contactY, s, e) {
  const r = 24 * s;
  const theta = e.crankAngle;
  const bob = Math.sin(2 * theta) * 1.2 * s * Math.min(1, e.speed / 3);
  ellipse(g, x - 50 * s, contactY - 3 * s, 100 * s, 7 * s, 'rgba(0,0,0,0.25)');

  const rear = [x - 34 * s, contactY - r];
  const front = [x + 34 * s, contactY - r];
  const bb = [x - 6 * s, contactY - r + 2 * s];
  const seat = [x - 16 * s, contactY - r - 40 * s];
  const head = [x + 22 * s, contactY - r - 36 * s];
  const hip = [seat[0] - 1 * s, seat[1] - 6 * s + bob];
  const shoulder = [x + 13 * s, contactY - r - 66 * s + bob];
  const crank = 8 * s;
  const pedal = (a) => [bb[0] + crank * Math.cos(a), bb[1] + crank * Math.sin(a)];
  const skin = rgb(240, 200, 165), shorts = rgb(25, 25, 35), jersey = rgb(230, 50, 60);

  // Far leg behind the bike.
  const farFoot = pedal(theta + Math.PI);
  line(g, [hip, knee(hip, farFoot, 28 * s, 27 * s), farFoot], rgb(15, 15, 22), 6 * s);

  drawWheel(g, rear, r, s, e.wheelAngle);
  drawWheel(g, front, r, s, e.wheelAngle);
  const frame = rgb(20, 120, 210);
  line(g, [rear, bb, seat, rear], frame, 3 * s);
  line(g, [bb, head, seat], frame, 3 * s);
  line(g, [head, front], rgb(40, 40, 40), 2.5 * s);
  line(g, [[seat[0] - 7 * s, seat[1] - 3 * s], [seat[0] + 6 * s, seat[1] - 4 * s]], rgb(30, 30, 30), 3 * s);
  line(g, [head, [head[0] + 9 * s, head[1] - 3 * s], [head[0] + 12 * s, head[1] + 4 * s], [head[0] + 7 * s, head[1] + 7 * s]], rgb(30, 30, 30), 2.5 * s);
  line(g, [pedal(theta + Math.PI), pedal(theta)], rgb(70, 70, 75), 2 * s);

  // Torso, head and helmet.
  line(g, [hip, shoulder], jersey, 10 * s);
  line(g, [[hip[0] + 3 * s, hip[1] - 4 * s], [shoulder[0] - 1 * s, shoulder[1] + 1 * s]], '#fff', 2 * s);
  const hc = [shoulder[0] + 9 * s, shoulder[1] - 9 * s];
  ellipse(g, hc[0] - 7 * s, hc[1] - 7 * s, 14 * s, 14 * s, skin);
  g.fillStyle = rgb(255, 210, 30);
  g.beginPath();
  g.arc(hc[0], hc[1], 8 * s, (190 * Math.PI) / 180, (350 * Math.PI) / 180, false);
  g.closePath();
  g.fill();
  ellipse(g, hc[0] + 2 * s, hc[1] - 2 * s, 6 * s, 3 * s, 'rgba(0,0,0,0.8)');

  // Arm to the bars.
  const hands = [head[0] + 10 * s, head[1] - 1 * s];
  line(g, [shoulder, [shoulder[0] + 9 * s, shoulder[1] + 12 * s + bob * 0.5], hands], jersey, 4.5 * s);
  ellipse(g, hands[0] - 2.5 * s, hands[1] - 2.5 * s, 5 * s, 5 * s, skin);

  // Near leg in front.
  const nearFoot = pedal(theta);
  const nearKnee = knee(hip, nearFoot, 28 * s, 27 * s);
  line(g, [hip, nearKnee], shorts, 7 * s);
  line(g, [nearKnee, nearFoot], skin, 5.5 * s);
  line(g, [[nearFoot[0] - 3 * s, nearFoot[1]], [nearFoot[0] + 6 * s, nearFoot[1] + 1 * s]], rgb(240, 240, 240), 4 * s);
}
