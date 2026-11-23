// Procedural textures drawn on canvases at start-up: no image files to ship. Everything is painted at a known
// real-world scale (see each function) so bricks, stones, windows and slates come out the right size, with
// soft large-scale mottling so that big surfaces do not look tiled.
import * as THREE from 'three';
import { rng } from '../../core/world/noise.js';

const cache = new Map();
let DETAIL = 1;

/** Texture resolution multiplier (0.5 for the low quality preset). */
export function setDetail(d) {
  DETAIL = d;
}

/** The current texture resolution multiplier. */
export function getDetail() {
  return DETAIL;
}

/** A canvas drawn in logical pixels (w × h) but stored at the current detail scale. */
function canvas(w, h = w, scale = 1) {
  const c = document.createElement('canvas');
  const k = DETAIL * scale;
  c.width = Math.max(16, Math.round(w * k));
  c.height = Math.max(16, Math.round(h * k));
  const g = c.getContext('2d');
  g.scale(c.width / w, c.height / h);
  return [c, g];
}

function finish(c, { srgb = true, anisotropy = 8, repeat = true } = {}) {
  const t = new THREE.CanvasTexture(c);
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = anisotropy;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

function once(key, make) {
  const k = `${key}@${DETAIL}`;
  if (!cache.has(k)) cache.set(k, make());
  return cache.get(k);
}

/** Small squares of random colour: grit, grain, lichen. */
function speckle(g, w, h, n, colours, rMin, rMax, seed, aMin = 0.25, aMax = 0.75) {
  const r = rng(seed);
  for (let i = 0; i < n; i++) {
    g.fillStyle = colours[Math.floor(r() * colours.length)];
    const s = rMin + r() * (rMax - rMin);
    g.globalAlpha = aMin + r() * (aMax - aMin);
    g.fillRect(r() * w, r() * h, s, s);
  }
  g.globalAlpha = 1;
}

/** Big soft blobs of colour that wrap at the edges, so the tile has no visible seams or flat areas. */
function mottle(g, w, h, n, colours, rMin, rMax, alpha, seed) {
  const r = rng(seed);
  for (let i = 0; i < n; i++) {
    const x = r() * w, y = r() * h, rad = rMin + r() * (rMax - rMin);
    const col = colours[Math.floor(r() * colours.length)];
    for (const ox of [-w, 0, w]) {
      for (const oy of [-h, 0, h]) {
        const cx = x + ox, cy = y + oy;
        if (cx + rad < 0 || cx - rad > w || cy + rad < 0 || cy - rad > h) continue;
        const grd = g.createRadialGradient(cx, cy, 0, cx, cy, rad);
        grd.addColorStop(0, col);
        grd.addColorStop(1, 'rgba(0,0,0,0)');
        g.globalAlpha = alpha;
        g.fillStyle = grd;
        g.fillRect(cx - rad, cy - rad, rad * 2, rad * 2);
      }
    }
  }
  g.globalAlpha = 1;
}

const shade = (hex, k) => {
  const c = new THREE.Color(hex);
  c.multiplyScalar(k);
  return `#${c.getHexString()}`;
};
const mixHex = (a, b, t) => `#${new THREE.Color(a).lerp(new THREE.Color(b), t).getHexString()}`;

/** Asphalt with aggregate, worn wheel tracks, edge lines and a dashed centre line. U across the road, V along 9 m. */
export function roadTexture({ centreLine = true, edgeLines = true, tone = '#56575a', yellow = false } = {}) {
  return once(`road-${centreLine}-${edgeLines}-${tone}-${yellow}`, () => {
    const [c, g] = canvas(512);
    g.fillStyle = tone;
    g.fillRect(0, 0, 512, 512);
    mottle(g, 512, 512, 26, [shade(tone, 0.8), shade(tone, 1.18), shade(tone, 0.9)], 40, 150, 0.22, 3);
    speckle(g, 512, 512, 16000, [shade(tone, 0.62), shade(tone, 1.3), shade(tone, 1.45), shade(tone, 0.75), shade(tone, 1.15)], 0.8, 2.2, 11, 0.2, 0.6);
    // Wheel tracks: slightly darker and smoother.
    for (const x of [140, 196, 316, 372]) {
      const grd = g.createLinearGradient(x - 34, 0, x + 34, 0);
      grd.addColorStop(0, 'rgba(0,0,0,0)');
      grd.addColorStop(0.5, 'rgba(18,18,20,0.16)');
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grd;
      g.fillRect(x - 34, 0, 68, 512);
    }
    // Gutter grime at the very edges.
    for (const [x0, x1] of [[0, 30], [512, 482]]) {
      const grd = g.createLinearGradient(x0, 0, x1, 0);
      grd.addColorStop(0, 'rgba(20,18,14,0.4)');
      grd.addColorStop(1, 'rgba(20,18,14,0)');
      g.fillStyle = grd;
      g.fillRect(Math.min(x0, x1), 0, 30, 512);
    }
    const paint = (x, y, w, h) => {
      g.fillStyle = '#e9e7df';
      g.fillRect(x, y, w, h);
      // Worn paint: a few grey scuffs.
      const r = rng(Math.round(x * 7 + y));
      g.fillStyle = shade(tone, 1.25);
      for (let i = 0; i < (w * h) / 90; i++) {
        g.globalAlpha = 0.5;
        g.fillRect(x + r() * w, y + r() * h, 1 + r() * 2, 1 + r() * 3);
      }
      g.globalAlpha = 1;
    };
    if (edgeLines && yellow) {
      // Double yellow lines along the kerb, as on any English city street.
      for (const x of [9, 22, 483, 496]) {
        paint(x, 0, 7, 512);
        g.globalCompositeOperation = 'multiply';
        g.fillStyle = '#f2c230';
        g.fillRect(x, 0, 7, 512);
        g.globalCompositeOperation = 'source-over';
      }
    } else if (edgeLines) {
      paint(15, 0, 7, 512);
      paint(490, 0, 7, 512);
    }
    if (centreLine) paint(252.5, 0, 7, 228);
    return finish(c, { anisotropy: 16 });
  });
}

/** Grass: soft mottled sward with fine blades, low contrast so tiling is hard to see. Tiles about every 7 m. */
export function grassTexture(tone = 'green') {
  return once(`grass-${tone}`, () => {
    const [c, g] = canvas(512);
    // 'pale' is the same sward drawn light and nearly neutral, for terrain that brings its own vertex colours.
    const pale = tone === 'pale';
    g.fillStyle = pale ? '#d3dcc2' : '#6c9440';
    g.fillRect(0, 0, 512, 512);
    mottle(g, 512, 512, 60, pale ? ['#bfcaa8', '#e0e8d0', '#e9eedb', '#c8d2b2', '#d8e0c6'] : ['#5d8736', '#7ba349', '#86ad52', '#64903a', '#739b47'], 30, 120, 0.3, 5);
    speckle(g, 512, 512, 9000, pale ? ['#b2c09a', '#e4ead4', '#f0f3e4', '#a6b68c', '#f4f6ea'] : ['#557f30', '#7da64b', '#8db458', '#4d752b', '#94b862'], 1, 2.5, 21, 0.12, 0.4);
    const r = rng(5);
    g.lineWidth = 1;
    for (let i = 0; i < 7000; i++) {
      const x = r() * 512, y = r() * 512;
      g.strokeStyle = r() < 0.5 ? (pale ? 'rgba(96,116,70,0.3)' : 'rgba(52,84,26,0.28)') : (pale ? 'rgba(250,255,236,0.32)' : 'rgba(168,204,104,0.26)');
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + (r() - 0.5) * 3, y - 2 - r() * 5);
      g.stroke();
    }
    return finish(c);
  });
}

/** Urban ground between York's buildings: yards and back lanes in worn tarmac and gravel. Tiles every 12 m. */
export function yardTexture() {
  return once('yard', () => {
    const [c, g] = canvas(512);
    g.fillStyle = '#8a857c';
    g.fillRect(0, 0, 512, 512);
    mottle(g, 512, 512, 50, ['#7a766f', '#989389', '#8f897c', '#807b73', '#9d988d'], 40, 160, 0.3, 61);
    speckle(g, 512, 512, 12000, ['#6c6861', '#a8a399', '#b5b0a5', '#77726a'], 1, 2.5, 62, 0.15, 0.45);
    return finish(c);
  });
}

/**
 * Stone walls.
 *  - 'gritstone': a Dales dry-stone wall drawn whole: 2.6 m along (U) by its full 1.3 m height (V), thin
 *    random courses with a row of upright coping stones along the top.
 *  - 'limestone': York's magnesian limestone in coursed blocks, 4 m × 4 m.
 *  - 'rubble': coursed gritstone rubble for cottages and field barns, 4 m × 4 m.
 */
export function stoneWallTexture({ tone = 'gritstone' } = {}) {
  return once(`stone-${tone}`, () => {
    if (tone === 'gritstone') {
      const [c, g] = canvas(512, 256);
      const palette = ['#9a9486', '#8a8478', '#a69f8f', '#7e786d', '#b0a998', '#8f8b80', '#979080'];
      g.fillStyle = '#2f2d29';
      g.fillRect(0, 0, 512, 256);
      const r = rng(4);
      // Coping: upright stones on edge along the top 44 px.
      let x = -r() * 10;
      while (x < 512) {
        const w = 9 + r() * 11;
        g.fillStyle = palette[Math.floor(r() * palette.length)];
        g.beginPath();
        g.roundRect(x + 0.8, 2 + r() * 7, w - 1.6, 44 - r() * 4, [5, 5, 1, 1]);
        g.fill();
        x += w;
      }
      let y = 46;
      while (y < 256) {
        const h = Math.min(256 - y, 9 + r() * 12);
        x = -r() * 30;
        while (x < 512) {
          const w = 18 + r() * 48;
          g.fillStyle = palette[Math.floor(r() * palette.length)];
          g.beginPath();
          g.roundRect(x + 1, y + 1, w - 2, h - 1.6, 2.5);
          g.fill();
          g.fillStyle = 'rgba(255,255,255,0.1)';
          g.fillRect(x + 2.5, y + 1.5, w - 6, 1.6);
          x += w;
        }
        y += h;
      }
      mottle(g, 512, 256, 26, ['#6f7a4e', '#c9c4b4', '#5c5a52', '#8a8a62'], 14, 60, 0.2, 14);
      speckle(g, 512, 256, 5000, ['#1c1b19', '#d6d1c2', '#77805a'], 0.8, 2, 9, 0.1, 0.35);
      // Shade towards the foot of the wall, where the grass grows up it.
      const grd = g.createLinearGradient(0, 190, 0, 256);
      grd.addColorStop(0, 'rgba(30,40,18,0)');
      grd.addColorStop(1, 'rgba(30,40,18,0.5)');
      g.fillStyle = grd;
      g.fillRect(0, 190, 512, 66);
      return finish(c);
    }
    const [c, g] = canvas(512);
    const lime = tone === 'limestone';
    const palette = lime
      ? ['#e6dcc0', '#dfd4b6', '#ebe2c9', '#d8ccae', '#e2d6b8', '#eee6cf', '#d3c7a8']
      : ['#a39b89', '#958d7c', '#b0a793', '#8b8474', '#a99f88', '#9c9483', '#b7ad97'];
    g.fillStyle = lime ? '#a59b82' : '#5e594f';
    g.fillRect(0, 0, 512, 512);
    const r = rng(lime ? 3 : 33);
    let y = 0;
    while (y < 512) {
      // Whole numbers of courses so the tile wraps cleanly.
      const h = lime ? 32 : y % 64 === 0 ? 24 : 20;
      let x = -r() * 40;
      while (x < 512) {
        const w = lime ? 44 + r() * 52 : 26 + r() * 46;
        g.fillStyle = palette[Math.floor(r() * palette.length)];
        g.beginPath();
        g.roundRect(x + 1, y + 1, w - 2, h - 2, lime ? 1.5 : 3.5);
        g.fill();
        g.fillStyle = 'rgba(255,255,255,0.1)';
        g.fillRect(x + 2, y + 1.5, w - 5, 2);
        g.fillStyle = 'rgba(0,0,0,0.07)';
        g.fillRect(x + 2, y + h - 4, w - 5, 2.5);
        x += w;
      }
      y += h;
      if (y > 512 - 20 && y < 512) y = 512;
    }
    mottle(g, 512, 512, 30, lime ? ['#c9bc98', '#f3ecd8', '#b9b093', '#d6c9a2'] : ['#77705f', '#c0b8a4', '#6d6a5a', '#8c8a68'], 30, 120, 0.2, 15);
    speckle(g, 512, 512, 7000, lime ? ['#b3a888', '#fbf6e6', '#9c9478'] : ['#4c483f', '#cfc7b3', '#6f7350'], 0.8, 2.2, 9, 0.1, 0.3);
    return finish(c);
  });
}

const BRICKS = {
  // York's handmade clamp bricks: orange-red through brown, with the odd burnt header.
  brick: { mortar: '#bfae96', cols: ['#a9532f', '#9c4a2c', '#b55e38', '#8e4126', '#ad5934', '#a04e30', '#b9673e', '#7f3a26'] },
  // Later, harder Victorian brick: deeper red-brown.
  brick2: { mortar: '#b7aa98', cols: ['#83402f', '#783829', '#8c4a37', '#6e3226', '#864538', '#93523f', '#632e24'] },
  // Pale buff/gault brick for modern blocks.
  buff: { mortar: '#cfc6b4', cols: ['#c9ac80', '#bfa074', '#d2b68c', '#b89a70', '#c4a67c', '#d8be96'] },
};

/** Paints brickwork over a rectangle at 128 px per metre (bricks 215 × 65 mm plus joints). */
function paintBricks(g, x0, y0, w, h, kind, seed) {
  const spec = BRICKS[kind] ?? BRICKS.brick;
  const r = rng(seed);
  const bw = 1024 / 36, bh = 9.6;
  g.fillStyle = spec.mortar;
  g.fillRect(x0, y0, w, h);
  const rows = Math.ceil(h / bh);
  for (let row = 0; row < rows; row++) {
    const off = row % 2 ? bw / 2 : 0;
    for (let x = -bw; x < w + bw; x += bw) {
      // Flemish-ish variety: an occasional pair of headers.
      g.fillStyle = spec.cols[Math.floor(r() * spec.cols.length)];
      const bx = Math.max(0, x + off + 0.9), ex = Math.min(w, x + off + bw - 0.9);
      if (ex > bx) g.fillRect(x0 + bx, y0 + row * bh + 0.8, ex - bx, Math.min(bh - 1.6, h - row * bh - 0.8));
    }
  }
}

/** Plain brickwork for chimneys, gables and garden walls: 4 m × 4 m. */
export function brickTexture(kind = 'brick') {
  return once(`brick-${kind}`, () => {
    const [c, g] = canvas(512, 512);
    g.save();
    g.scale(0.5, 0.5);
    paintBricks(g, 0, 0, 1024, 1027, kind, 8);
    g.restore();
    mottle(g, 512, 512, 22, ['#5a3a2a', '#d9a888', '#74503c'], 30, 110, 0.14, 12);
    speckle(g, 512, 512, 3000, ['#3a2018', '#e0b59a'], 0.8, 2, 12, 0.08, 0.25);
    return finish(c);
  });
}

// ---- Facades ------------------------------------------------------------------------------------------
// One facade tile is 8 m wide (two 4 m bays) by 12 m tall (four 3 m storeys), drawn at 128 px/m in logical
// pixels: 1024 × 1536, bay 512, storey 384. The BOTTOM storey (v 0…0.25) is the ground floor; the upper three
// (v 0.25…1) repeat for taller buildings (see common.facadeWall). The strip of wall between bays, from
// u = 0.345 to 0.655, has no openings, and narrow walls use it.
const FW = 1024, FH = 1536, BAY = 512, ST = 384;

function glass(g, x, y, w, h, r, { lit = false, blind = 0 } = {}) {
  const grd = g.createLinearGradient(x, y, x + w * 0.4, y + h);
  if (lit) {
    grd.addColorStop(0, '#ffe9b0');
    grd.addColorStop(1, '#f0c06a');
  } else {
    grd.addColorStop(0, '#5b7388');
    grd.addColorStop(0.45, '#2c3b49');
    grd.addColorStop(1, '#1d2731');
  }
  g.fillStyle = grd;
  g.fillRect(x, y, w, h);
  if (!lit) {
    // A streak of reflected sky.
    g.fillStyle = 'rgba(190,215,235,0.2)';
    g.beginPath();
    g.moveTo(x, y + h * 0.5);
    g.lineTo(x + w * 0.55, y);
    g.lineTo(x + w * 0.85, y);
    g.lineTo(x, y + h * 0.8);
    g.closePath();
    g.fill();
    if (blind > 0) {
      g.fillStyle = r() < 0.5 ? 'rgba(236,228,206,0.85)' : 'rgba(214,220,224,0.8)';
      g.fillRect(x, y, w, h * blind);
    } else if (r() < 0.45) {
      // Curtains gathered at each side.
      g.fillStyle = ['rgba(225,214,196,0.75)', 'rgba(170,60,60,0.55)', 'rgba(205,215,225,0.7)', 'rgba(80,110,90,0.55)'][Math.floor(r() * 4)];
      g.fillRect(x, y, w * 0.2, h);
      g.fillRect(x + w * 0.8, y, w * 0.2, h);
    }
  }
}

/** A sash window with glazing bars: nx × ny panes per sash. (x, y) is the top-left of the opening. */
function sash(g, x, y, w, h, r, { nx = 3, ny = 2, frame = '#f7f5ee', lit = false, blind = 0, reveal = 5 } = {}) {
  // Reveal shadow, then the white box frame.
  g.fillStyle = 'rgba(0,0,0,0.38)';
  g.fillRect(x - 1, y - 1, w + 2, h + 2);
  g.fillStyle = frame;
  g.fillRect(x + 2, y + reveal, w - 4, h - reveal);
  const fx = x + 8, fy = y + reveal + 6, fw = w - 16, fh = h - reveal - 12;
  glass(g, fx, fy, fw, fh, r, { lit, blind });
  g.fillStyle = frame;
  g.fillRect(fx, fy + fh / 2 - 4, fw, 8); // meeting rail
  for (let i = 1; i < nx; i++) g.fillRect(fx + (fw * i) / nx - 1.5, fy, 3, fh);
  for (const [sy, sh] of [[fy, fh / 2 - 4], [fy + fh / 2 + 4, fh / 2 - 4]]) for (let j = 1; j < ny; j++) g.fillRect(fx, sy + (sh * j) / ny - 1.5, fw, 3);
  // Shadow cast by the head of the opening.
  g.fillStyle = 'rgba(0,0,0,0.22)';
  g.fillRect(x + 2, y + reveal, w - 4, 7);
}

function sill(g, x, y, w, col = '#e4dcc6') {
  g.fillStyle = col;
  g.fillRect(x - 10, y, w + 20, 12);
  g.fillStyle = 'rgba(0,0,0,0.28)';
  g.fillRect(x - 8, y + 12, w + 16, 5);
}

/** A flat gauged-brick arch: fanned rubbed bricks over an opening. */
function flatArch(g, x, y, w, h, col, joint) {
  g.fillStyle = joint;
  g.beginPath();
  g.moveTo(x - 14, y);
  g.lineTo(x + w + 14, y);
  g.lineTo(x + w, y + h);
  g.lineTo(x, y + h);
  g.closePath();
  g.fill();
  const n = Math.round((w + 28) / 10);
  for (let i = 0; i < n; i++) {
    const t0 = i / n, t1 = (i + 1) / n;
    g.fillStyle = shade(col, 0.94 + ((i * 7) % 5) * 0.03);
    g.beginPath();
    g.moveTo(x - 14 + (w + 28) * t0 + 0.8, y);
    g.lineTo(x - 14 + (w + 28) * t1 - 0.8, y);
    g.lineTo(x + w * t1 - 0.8, y + h);
    g.lineTo(x + w * t0 + 0.8, y + h);
    g.closePath();
    g.fill();
  }
}

/** A panelled front door with a doorcase and fanlight. (x, y) top-left of the door leaf. */
function door(g, x, y, w, h, col, r, { doorcase = '#f4f1e8', fan = true } = {}) {
  const fh = fan ? 46 : 0;
  // Doorcase: pilasters and a flat hood.
  g.fillStyle = 'rgba(0,0,0,0.3)';
  g.fillRect(x - 24, y - fh - 22, w + 48, h + fh + 22);
  g.fillStyle = doorcase;
  g.fillRect(x - 22, y - fh - 20, w + 44, h + fh + 20);
  g.fillRect(x - 32, y - fh - 30, w + 64, 14);
  g.fillStyle = 'rgba(0,0,0,0.16)';
  g.fillRect(x - 30, y - fh - 16, w + 60, 5);
  g.fillRect(x - 14, y - fh - 8, 3, h + fh + 8);
  g.fillRect(x + w + 11, y - fh - 8, 3, h + fh + 8);
  if (fan) {
    g.fillStyle = '#26323e';
    g.beginPath();
    g.ellipse(x + w / 2, y - 4, w / 2, fh - 10, 0, Math.PI, 0);
    g.fill();
    g.strokeStyle = doorcase;
    g.lineWidth = 2.5;
    for (let k = 1; k < 6; k++) {
      const a = Math.PI + (k / 6) * Math.PI;
      g.beginPath();
      g.moveTo(x + w / 2, y - 4);
      g.lineTo(x + w / 2 + Math.cos(a) * w * 0.5, y - 4 + Math.sin(a) * (fh - 10));
      g.stroke();
    }
    g.fillStyle = doorcase;
    g.fillRect(x - 2, y - 6, w + 4, 6);
  }
  g.fillStyle = col;
  g.fillRect(x, y, w, h);
  const grd = g.createLinearGradient(x, y, x, y + h);
  grd.addColorStop(0, 'rgba(0,0,0,0.3)');
  grd.addColorStop(0.2, 'rgba(0,0,0,0)');
  g.fillStyle = grd;
  g.fillRect(x, y, w, h);
  // Six panels.
  for (const [py, ph] of [[16, 52], [80, 96], [188, h - 204]]) {
    for (const px of [14, w / 2 + 5]) {
      g.strokeStyle = 'rgba(0,0,0,0.4)';
      g.lineWidth = 3;
      g.strokeRect(x + px, y + py, w / 2 - 19, ph);
      g.strokeStyle = 'rgba(255,255,255,0.14)';
      g.lineWidth = 1.5;
      g.strokeRect(x + px + 3, y + py + 3, w / 2 - 25, ph - 6);
    }
  }
  g.fillStyle = '#d7b24a';
  g.beginPath();
  g.arc(x + w - 16, y + h * 0.52, 5, 0, Math.PI * 2);
  g.fill();
  g.fillRect(x + w / 2 - 12, y + h * 0.45, 24, 5); // letter box
  // Step.
  g.fillStyle = '#cfc8b6';
  g.fillRect(x - 26, y + h - 2, w + 52, 16);
  void r;
}

const DOORS = ['#16382a', '#111417', '#6e1622', '#1d3a63', '#27323b', '#0f4a4a', '#7a2d18', '#e9e4d6', '#3b2a50', '#b58a1c'];

/** Darkening at the foot of the wall and a faint weathering wash down from the top: cheap ambient occlusion. */
function grime(g) {
  let grd = g.createLinearGradient(0, FH - 120, 0, FH);
  grd.addColorStop(0, 'rgba(30,24,18,0)');
  grd.addColorStop(1, 'rgba(30,24,18,0.42)');
  g.fillStyle = grd;
  g.fillRect(0, FH - 120, FW, 120);
  for (let s = 0; s < 3; s++) {
    grd = g.createLinearGradient(0, s * ST, 0, s * ST + 60);
    grd.addColorStop(0, 'rgba(30,24,18,0.12)');
    grd.addColorStop(1, 'rgba(30,24,18,0)');
    g.fillStyle = grd;
    g.fillRect(0, s * ST, FW, 60);
  }
}

/**
 * Facade textures. kinds: brick (Georgian red brick), brick2 (Victorian terrace), render (painted stucco),
 * stone (ashlar limestone), shop (brick over shopfronts), timber (jettied black-and-white), church (lancet
 * windows), office (modern buff brick), cottage (Dales gritstone). Drawn close to white-balanced so vertex
 * colours can tint them.
 */
export function facadeTexture(kind = 'brick') {
  return once(`facade-${kind}`, () => {
    const [c, g] = canvas(FW, FH, 0.75);
    const r = rng(kind.length * 131 + kind.charCodeAt(0) * 7 + 5);
    const pick = (a) => a[Math.floor(r() * a.length)];

    // ---- Wall surface ----
    if (kind === 'brick' || kind === 'shop') paintBricks(g, 0, 0, FW, FH, 'brick', 8);
    else if (kind === 'brick2') paintBricks(g, 0, 0, FW, FH, 'brick2', 18);
    else if (kind === 'office') paintBricks(g, 0, 0, FW, FH, 'buff', 28);
    else if (kind === 'stone' || kind === 'church' || kind === 'cottage' || kind === 'barn') {
      const img = stoneWallTexture({ tone: kind === 'cottage' || kind === 'barn' ? 'rubble' : 'limestone' }).image;
      for (let x = 0; x < FW; x += 512) for (let y = 0; y < FH; y += 512) g.drawImage(img, x, y, 512, 512);
    } else {
      g.fillStyle = '#f3efe4';
      g.fillRect(0, 0, FW, FH);
      mottle(g, FW, FH, 40, ['#e4dece', '#fbf8f0', '#d9d2c0'], 60, 240, 0.25, 31);
      speckle(g, FW, FH, 9000, ['#e2dccd', '#fffdf6', '#cfc8b6'], 1, 3, 31, 0.1, 0.3);
    }
    if (kind.startsWith('brick') || kind === 'shop' || kind === 'office') {
      mottle(g, FW, FH, 40, ['#4f3324', '#e6b494', '#6b4634', '#d8a27e'], 60, 260, 0.13, 12);
      speckle(g, FW, FH, 9000, ['#3a2018', '#e8c0a4'], 1, 2.5, 13, 0.06, 0.22);
    }

    if (kind === 'timber') {
      timberFacade(g, r, pick);
      grime(g);
      return finish(c);
    }
    if (kind === 'church') {
      churchFacade(g);
      grime(g);
      return finish(c);
    }
    if (kind === 'barn') {
      // A field barn: a cart door under a stone lintel in one bay, a forking hole and vent slits in the other.
      const y = FH - ST;
      g.fillStyle = '#b9b09c';
      g.fillRect(138, y + 96, 236, 26);
      g.fillStyle = '#4a3b2c';
      g.fillRect(150, y + 122, 212, ST - 122);
      g.strokeStyle = 'rgba(0,0,0,0.4)';
      g.lineWidth = 3;
      for (let k = 1; k < 8; k++) {
        g.beginPath();
        g.moveTo(150 + k * 26.5, y + 122);
        g.lineTo(150 + k * 26.5, y + ST);
        g.stroke();
      }
      g.fillStyle = 'rgba(0,0,0,0.35)';
      g.fillRect(150, y + 122, 212, 12);
      g.fillStyle = '#b9b09c';
      g.fillRect(722, y + 60, 92, 12);
      g.fillStyle = '#1c1916';
      g.fillRect(730, y + 72, 76, 70);
      for (const x of [600, 930]) g.fillRect(x, y + 190, 10, 70);
      grime(g);
      return finish(c);
    }

    const stoneTrim = kind === 'cottage' ? '#c2b9a4' : '#e6dfca';
    for (let storey = 0; storey < 4; storey++) {
      const ground = storey === 3;
      const y0 = storey * ST;
      for (let bay = 0; bay < 2; bay++) {
        const cx = bay * BAY + BAY / 2;
        if (ground && (kind === 'shop' || kind === 'office')) continue;
        const lit = r() < 0.08, blind = r() < 0.22 ? 0.25 + r() * 0.4 : 0;
        if (kind === 'brick') {
          if (ground && bay === 0) {
            door(g, cx - 64, y0 + ST - 14 - 262, 128, 262, pick(DOORS), r);
            continue;
          }
          const w = 138, h = ground ? 236 : storey === 0 ? 196 : 228, y = y0 + ST - 104 - h;
          flatArch(g, cx - w / 2, y - 34, w, 34, '#c8744c', '#d9c6ab');
          sash(g, cx - w / 2, y, w, h, r, { nx: 3, ny: storey === 0 ? 1 : 2, lit, blind });
          sill(g, cx - w / 2, y + h, w);
        } else if (kind === 'brick2') {
          if (ground && bay === 0) {
            // Round-arched doorway in brick with a plain fanlight.
            const dx = cx - 60, dy = y0 + ST - 12 - 256;
            g.fillStyle = '#d8cdb6';
            g.beginPath();
            g.ellipse(cx, dy, 76, 70, 0, Math.PI, 0);
            g.fill();
            g.fillRect(dx - 16, dy, 152, 256);
            g.fillStyle = '#222c36';
            g.beginPath();
            g.ellipse(cx, dy, 58, 52, 0, Math.PI, 0);
            g.fill();
            door(g, dx, dy, 120, 256, pick(DOORS), r, { fan: false, doorcase: '#d8cdb6' });
            continue;
          }
          const w = ground ? 168 : 132, h = 218, y = y0 + ST - 108 - h;
          g.fillStyle = '#ddd3bd'; // stone lintel with a keystone bump
          g.fillRect(cx - w / 2 - 14, y - 30, w + 28, 30);
          g.fillStyle = 'rgba(0,0,0,0.15)';
          g.fillRect(cx - w / 2 - 14, y - 5, w + 28, 5);
          sash(g, cx - w / 2, y, w, h, r, { nx: ground ? 3 : 2, ny: 1, lit, blind });
          sill(g, cx - w / 2, y + h, w, '#ddd3bd');
        } else if (kind === 'render') {
          if (ground && bay === 0) {
            door(g, cx - 64, y0 + ST - 14 - 262, 128, 262, pick(DOORS), r, { doorcase: '#ffffff' });
            continue;
          }
          const w = 140, h = storey === 0 ? 190 : 226, y = y0 + ST - 104 - h;
          g.fillStyle = '#ffffff'; // moulded architrave
          g.fillRect(cx - w / 2 - 14, y - 18, w + 28, h + 22);
          g.fillStyle = 'rgba(0,0,0,0.12)';
          g.fillRect(cx - w / 2 - 14, y + h + 2, w + 28, 4);
          sash(g, cx - w / 2, y, w, h, r, { nx: 3, ny: 2, lit, blind });
          sill(g, cx - w / 2, y + h, w, '#ffffff');
        } else if (kind === 'stone') {
          if (ground && bay === 0) {
            door(g, cx - 70, y0 + ST - 14 - 276, 140, 276, pick(['#1c2a22', '#3a2416', '#111417']), r, { doorcase: '#efe8d2' });
            continue;
          }
          const w = 144, h = storey === 0 ? 196 : 240, y = y0 + ST - 96 - h;
          g.fillStyle = '#f1ead6';
          g.fillRect(cx - w / 2 - 16, y - 22, w + 32, h + 22);
          g.fillRect(cx - w / 2 - 26, y - 32, w + 52, 12);
          sash(g, cx - w / 2, y, w, h, r, { nx: 3, ny: 2, lit, blind });
          sill(g, cx - w / 2, y + h, w, '#f1ead6');
        } else if (kind === 'office') {
          const w = 380, h = 200, y = y0 + ST - 110 - h;
          g.fillStyle = '#3b4248';
          g.fillRect(cx - w / 2 - 6, y - 6, w + 12, h + 12);
          for (let k = 0; k < 4; k++) glass(g, cx - w / 2 + k * (w / 4) + 3, y, w / 4 - 6, h, r, { lit, blind: r() < 0.3 ? 0.3 : 0 });
          sill(g, cx - w / 2, y + h + 6, w, '#d9d2c0');
        } else if (kind === 'shop') {
          const w = 132, h = storey === 0 ? 190 : 222, y = y0 + ST - 104 - h;
          flatArch(g, cx - w / 2, y - 32, w, 32, '#c8744c', '#d9c6ab');
          sash(g, cx - w / 2, y, w, h, r, { nx: 3, ny: 2, lit, blind });
          sill(g, cx - w / 2, y + h, w);
        } else if (kind === 'cottage') {
          if (ground && bay === 0) {
            // Plank door under a heavy stone lintel.
            const dx = cx - 58, dy = y0 + ST - 10 - 248;
            g.fillStyle = stoneTrim;
            g.fillRect(dx - 20, dy - 36, 156, 284);
            g.fillStyle = 'rgba(0,0,0,0.2)';
            g.fillRect(dx - 20, dy - 6, 156, 6);
            g.fillStyle = pick(['#274a3a', '#2a3f5c', '#5a2424', '#3b3a36', '#1f4d57']);
            g.fillRect(dx, dy, 116, 248);
            g.strokeStyle = 'rgba(0,0,0,0.35)';
            g.lineWidth = 2;
            for (let k = 1; k < 5; k++) {
              g.beginPath();
              g.moveTo(dx + (116 * k) / 5, dy);
              g.lineTo(dx + (116 * k) / 5, dy + 248);
              g.stroke();
            }
            g.fillStyle = '#18181a';
            g.fillRect(dx + 96, dy + 120, 8, 22);
            continue;
          }
          const w = 124, h = storey === 0 ? 150 : 176, y = y0 + ST - 118 - h;
          g.fillStyle = stoneTrim; // stone surround: lintel, jambs and sill
          g.fillRect(cx - w / 2 - 18, y - 30, w + 36, h + 46);
          g.fillStyle = 'rgba(0,0,0,0.18)';
          g.fillRect(cx - w / 2 - 18, y + h + 16, w + 36, 5);
          sash(g, cx - w / 2, y, w, h, r, { nx: 2, ny: 2, lit, blind: blind * 0.6 });
        }
      }
      // String course between the ground floor and the first floor.
      if (ground && (kind === 'brick' || kind === 'stone' || kind === 'render')) {
        g.fillStyle = kind === 'brick' ? '#e2d9c2' : '#f7f2e4';
        g.fillRect(0, y0 - 9, FW, 16);
        g.fillStyle = 'rgba(0,0,0,0.2)';
        g.fillRect(0, y0 + 7, FW, 5);
      }
    }
    // Stone plinth for the Georgian houses.
    if (kind === 'brick' || kind === 'stone') {
      g.fillStyle = kind === 'brick' ? '#cfc6b0' : '#d6cdb4';
      g.fillRect(0, FH - 44, FW, 44);
      g.fillStyle = 'rgba(255,255,255,0.25)';
      g.fillRect(0, FH - 44, FW, 4);
    }
    if (kind === 'render') {
      // Channelled rustication on the ground floor.
      g.fillStyle = 'rgba(0,0,0,0.1)';
      for (let y = FH - ST + 40; y < FH - 20; y += 48) g.fillRect(0, y, FW, 3);
    }
    if (kind === 'shop') shopfronts(g, r, pick);
    if (kind === 'office') {
      for (let bay = 0; bay < 2; bay++) {
        const x = bay * BAY, y = FH - ST;
        g.fillStyle = '#30363b';
        g.fillRect(x + 40, y + 60, BAY - 80, ST - 60);
        for (let k = 0; k < 3; k++) glass(g, x + 48 + k * ((BAY - 96) / 3) + 3, y + 68, (BAY - 96) / 3 - 6, ST - 110, r, {});
        g.fillStyle = '#c9c2b0';
        g.fillRect(x + 20, y + 36, BAY - 40, 22);
      }
    }
    grime(g);
    return finish(c);
  });
}

function shopfronts(g, r, pick) {
  const names = ['TEA ROOMS', 'BAKERY', 'BOOKS', 'ANTIQUES', 'FLORIST', 'BUTCHER', 'CYCLES', 'SWEETS', 'GALLERY', 'DELI', 'PIES', 'CAFE', 'WOOL SHOP', 'CHEESE', 'FUDGE'];
  const y = FH - ST;
  for (let bay = 0; bay < 2; bay++) {
    const x = bay * BAY;
    const paint = pick(['#1d3b2a', '#27305c', '#5c1f24', '#1c1c1e', '#6a4b1c', '#24484a', '#7b2d3f', '#e9e2cc', '#3a4a2a', '#2d5a7a']);
    const light = paint === '#e9e2cc';
    const trim = light ? '#2a2a28' : '#efe6c8';
    // Timber shopfront: pilasters, fascia and cornice.
    g.fillStyle = 'rgba(0,0,0,0.35)';
    g.fillRect(x + 8, y + 12, BAY - 16, ST - 12);
    g.fillStyle = paint;
    g.fillRect(x + 10, y + 16, BAY - 20, ST - 16);
    g.fillStyle = shade(paint, 1.25);
    g.fillRect(x + 4, y + 10, BAY - 8, 12); // cornice
    g.fillStyle = 'rgba(0,0,0,0.3)';
    g.fillRect(x + 10, y + 22, BAY - 20, 5);
    g.fillStyle = trim;
    g.font = '700 38px Georgia, "Times New Roman", serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(pick(names), x + BAY / 2, y + 56);
    g.fillStyle = 'rgba(0,0,0,0.3)';
    g.fillRect(x + 10, y + 84, BAY - 20, 5);
    // Display window with a stallriser below and a recessed door.
    const doorLeft = r() < 0.5;
    const wx = doorLeft ? x + 150 : x + 36, ww = BAY - 186;
    const grd = g.createLinearGradient(0, y + 96, 0, y + ST - 70);
    grd.addColorStop(0, '#a9c0cf');
    grd.addColorStop(0.35, '#4d6272');
    grd.addColorStop(1, '#2a3540');
    g.fillStyle = grd;
    g.fillRect(wx, y + 100, ww, ST - 172);
    // Lit goods in the window.
    for (let k = 0; k < 7; k++) {
      g.fillStyle = pick(['#ffe2a0', '#f4c06a', '#e9a0a0', '#c9e0a8', '#f7f0dc', '#b9d4ee', '#d99a5a']);
      const bw = 22 + r() * 22, bh = 24 + r() * 46;
      g.fillRect(wx + 12 + (k * (ww - 30)) / 7, y + ST - 76 - bh, bw, bh);
    }
    g.fillStyle = 'rgba(200,225,240,0.16)';
    g.beginPath();
    g.moveTo(wx, y + 240);
    g.lineTo(wx + ww * 0.5, y + 100);
    g.lineTo(wx + ww * 0.75, y + 100);
    g.lineTo(wx, y + 300);
    g.fill();
    g.fillStyle = paint;
    for (let k = 1; k < 3; k++) g.fillRect(wx + (ww * k) / 3 - 3, y + 100, 6, ST - 172);
    g.fillRect(wx, y + 150, ww, 5);
    const dx = doorLeft ? x + 36 : x + BAY - 136;
    g.fillStyle = '#1b222a';
    g.fillRect(dx, y + 100, 100, ST - 100);
    g.fillStyle = paint;
    g.fillRect(dx + 8, y + 108, 84, ST - 112);
    g.fillStyle = '#51677a';
    g.fillRect(dx + 18, y + 120, 64, 150);
    g.fillStyle = '#d7b24a';
    g.fillRect(dx + 76, y + 280, 8, 26);
    // Striped awning on some.
    if (r() < 0.45) {
      const a = pick(['#b3261e', '#1f5f3a', '#27407a', '#c98a1c']);
      for (let k = 0; k < 12; k++) {
        g.fillStyle = k % 2 ? '#f4efe2' : a;
        g.fillRect(wx - 6 + (k * (ww + 12)) / 12, y + 92, (ww + 12) / 12 + 0.5, 46);
      }
      g.fillStyle = 'rgba(0,0,0,0.3)';
      g.fillRect(wx - 6, y + 138, ww + 12, 8);
    }
  }
}

function timberFacade(g, r, pick) {
  const oak = '#2a211b';
  for (let storey = 0; storey < 4; storey++) {
    const y0 = storey * ST, ground = storey === 3;
    // Jetty: a heavy bressumer beam with shadow under it.
    g.fillStyle = oak;
    g.fillRect(0, y0, FW, 26);
    g.fillRect(0, y0 + ST - 18, FW, 18);
    if (!ground) {
      g.fillStyle = 'rgba(0,0,0,0.3)';
      g.fillRect(0, y0 + ST, FW, 16);
    }
    for (let x = 0; x <= FW; x += 128) {
      g.fillStyle = oak;
      const wob = (r() - 0.5) * 6;
      g.fillRect(x - 10 + wob, y0, 20, ST);
    }
    for (let bay = 0; bay < 2; bay++) {
      const cx = bay * BAY + BAY / 2;
      // Curved braces in the outer panels.
      g.strokeStyle = oak;
      g.lineWidth = 15;
      for (const s of [-1, 1]) {
        g.beginPath();
        g.moveTo(cx + s * 246, y0 + ST - 20);
        g.quadraticCurveTo(cx + s * 236, y0 + 150, cx + s * 138, y0 + 28);
        g.stroke();
      }
      if (ground) {
        if (bay === 0) {
          g.fillStyle = '#3b2a1c';
          g.fillRect(cx - 62, y0 + 96, 124, ST - 96);
          g.strokeStyle = '#1c140f';
          g.lineWidth = 3;
          for (let k = 1; k < 5; k++) {
            g.beginPath();
            g.moveTo(cx - 62 + k * 24.8, y0 + 96);
            g.lineTo(cx - 62 + k * 24.8, y0 + ST);
            g.stroke();
          }
          g.fillStyle = '#18181a';
          for (const yy of [140, 300]) g.fillRect(cx - 62, y0 + yy, 70, 7);
          g.fillStyle = oak;
          g.fillRect(cx - 74, y0 + 80, 148, 18);
          continue;
        }
        // A small-paned shop window.
        const w = 250, h = 190, x = cx - w / 2, y = y0 + 92;
        g.fillStyle = oak;
        g.fillRect(x - 10, y - 10, w + 20, h + 20);
        glass(g, x, y, w, h, r, { lit: true });
        g.fillStyle = oak;
        for (let k = 1; k < 5; k++) g.fillRect(x + (w * k) / 5 - 2.5, y, 5, h);
        for (let k = 1; k < 3; k++) g.fillRect(x, y + (h * k) / 3 - 2.5, w, 5);
        continue;
      }
      // Leaded casement.
      const w = 180, h = 150, x = cx - w / 2, y = y0 + 110;
      g.fillStyle = oak;
      g.fillRect(x - 12, y - 12, w + 24, h + 24);
      glass(g, x, y, w, h, r, { lit: r() < 0.15 });
      g.strokeStyle = 'rgba(205,200,185,0.75)';
      g.lineWidth = 1.6;
      g.save();
      g.beginPath();
      g.rect(x, y, w, h);
      g.clip();
      for (let k = -h; k < w + h; k += 18) {
        g.beginPath();
        g.moveTo(x + k, y);
        g.lineTo(x + k + h, y + h);
        g.moveTo(x + k + h, y);
        g.lineTo(x + k, y + h);
        g.stroke();
      }
      g.restore();
      g.fillStyle = oak;
      g.fillRect(x + w / 3 - 4, y, 8, h);
      g.fillRect(x + (2 * w) / 3 - 4, y, 8, h);
    }
  }
  void pick;
}

/** A pointed (Gothic) window opening as a canvas path. */
function lancetPath(g, x, y, w, h) {
  g.beginPath();
  g.moveTo(x, y + h);
  g.lineTo(x, y + w * 0.75);
  g.quadraticCurveTo(x + w * 0.04, y + w * 0.2, x + w / 2, y);
  g.quadraticCurveTo(x + w * 0.96, y + w * 0.2, x + w, y + w * 0.75);
  g.lineTo(x + w, y + h);
  g.closePath();
}

/** A traceried Gothic window with stained glass. */
function gothicWindow(g, x, y, w, h, lights = 3, seed = 1) {
  const r = rng(seed);
  g.fillStyle = 'rgba(60,50,30,0.45)';
  lancetPath(g, x - 7, y - 9, w + 14, h + 12);
  g.fill();
  g.fillStyle = '#f2ebd6';
  lancetPath(g, x - 3, y - 4, w + 6, h + 4);
  g.fill();
  g.save();
  lancetPath(g, x + 5, y + 6, w - 10, h - 10);
  g.clip();
  const grd = g.createLinearGradient(x, y, x + w, y + h);
  grd.addColorStop(0, '#23334f');
  grd.addColorStop(0.5, '#3a2c50');
  grd.addColorStop(1, '#1f3d44');
  g.fillStyle = grd;
  g.fillRect(x, y, w, h);
  // Flecks of coloured glass.
  const cols = ['#3d6fb5', '#8a3550', '#3f8a78', '#c9a23c', '#5a4a9a', '#a85a30', '#7fa9d6'];
  for (let i = 0; i < (w * h) / 60; i++) {
    g.fillStyle = cols[Math.floor(r() * cols.length)];
    g.globalAlpha = 0.25 + r() * 0.4;
    g.fillRect(x + r() * w, y + r() * h, 3 + r() * 6, 4 + r() * 9);
  }
  g.globalAlpha = 1;
  g.fillStyle = 'rgba(200,220,240,0.12)';
  g.beginPath();
  g.moveTo(x, y + h * 0.6);
  g.lineTo(x + w, y + h * 0.1);
  g.lineTo(x + w, y + h * 0.3);
  g.lineTo(x, y + h * 0.8);
  g.fill();
  // Mullions and tracery.
  g.strokeStyle = '#ece4cc';
  g.lineWidth = Math.max(3, w * 0.035);
  for (let k = 1; k < lights; k++) {
    g.beginPath();
    g.moveTo(x + (w * k) / lights, y + w * 0.55);
    g.lineTo(x + (w * k) / lights, y + h);
    g.stroke();
  }
  for (let k = 0; k < lights; k++) {
    const lx = x + (w * k) / lights, lw = w / lights;
    g.beginPath();
    g.moveTo(lx, y + w * 0.75);
    g.quadraticCurveTo(lx + lw * 0.1, y + w * 0.55, lx + lw / 2, y + w * 0.48);
    g.quadraticCurveTo(lx + lw * 0.9, y + w * 0.55, lx + lw, y + w * 0.75);
    g.stroke();
  }
  g.beginPath();
  g.arc(x + w / 2, y + w * 0.28, w * 0.15, 0, Math.PI * 2);
  g.stroke();
  if (h > w * 2.6) {
    g.beginPath();
    g.moveTo(x, y + h * 0.62);
    g.lineTo(x + w, y + h * 0.62);
    g.stroke();
  }
  g.restore();
}

function churchFacade(g) {
  for (let storey = 0; storey < 4; storey++) {
    const y0 = storey * ST;
    for (let bay = 0; bay < 2; bay++) {
      const cx = bay * BAY + BAY / 2;
      if (storey < 3) gothicWindow(g, cx - 80, y0 + 50, 160, ST - 110, 2, storey * 2 + bay + 3);
      else gothicWindow(g, cx - 80, y0 + 40, 160, ST - 150, 2, 11 + bay);
      // Buttress strip between the bays.
      g.fillStyle = 'rgba(255,250,235,0.3)';
      g.fillRect(bay * BAY + BAY - 34, y0, 68, ST);
      g.fillStyle = 'rgba(0,0,0,0.14)';
      g.fillRect(bay * BAY + BAY + 34, y0, 8, ST);
    }
    g.fillStyle = 'rgba(0,0,0,0.14)';
    g.fillRect(0, y0 + ST - 8, FW, 5);
    g.fillStyle = 'rgba(255,250,235,0.35)';
    g.fillRect(0, y0 + ST - 18, FW, 10);
  }
}

/**
 * York Minster's walls: 10 m bays (U) by 28 m (V) of pale limestone with a great traceried window over a
 * smaller aisle window, buttress strips, string courses and a pierced parapet.
 */
export function minsterTexture(kind = 'bay') {
  return once(`minster-${kind}`, () => {
    const W2 = 512, H2 = 1434; // 51.2 px per metre
    const [c, g] = canvas(W2, H2);
    const img = stoneWallTexture({ tone: 'limestone' }).image;
    for (let y = 0; y < H2; y += 256) for (let x = 0; x < W2; x += 256) g.drawImage(img, x, y, 256, 256);
    g.fillStyle = 'rgba(240,231,205,0.5)';
    g.fillRect(0, 0, W2, H2);
    mottle(g, W2, H2, 30, ['#c7b88e', '#fbf6e4', '#b3a684'], 60, 240, 0.16, 71);
    if (kind === 'bay') {
      gothicWindow(g, 130, 150, 252, 600, 4, 5); // clerestory
      gothicWindow(g, 150, 900, 212, 400, 3, 6); // aisle
    } else if (kind === 'tower') {
      // Tall paired belfry lancets with louvres.
      for (const x of [86, 290]) {
        gothicWindow(g, x, 120, 136, 760, 2, x);
        gothicWindow(g, x + 8, 990, 120, 330, 2, x + 1);
      }
    } else {
      // Blind arcading for plain stretches.
      for (let k = 0; k < 4; k++) {
        g.strokeStyle = 'rgba(120,105,70,0.35)';
        g.lineWidth = 5;
        lancetPath(g, 40 + k * 116, 200, 84, 420);
        g.stroke();
        lancetPath(g, 40 + k * 116, 880, 84, 380);
        g.stroke();
      }
    }
    // Buttress strip at the bay edge (wraps), string courses, parapet.
    for (const x of [0, W2 - 36]) {
      g.fillStyle = 'rgba(255,250,232,0.4)';
      g.fillRect(x, 0, 36, H2);
    }
    g.fillStyle = 'rgba(70,58,30,0.25)';
    g.fillRect(36, 0, 7, H2);
    g.fillRect(W2 - 43, 0, 7, H2);
    for (const y of [70, 820, H2 - 70]) {
      g.fillStyle = 'rgba(255,250,232,0.55)';
      g.fillRect(0, y, W2, 14);
      g.fillStyle = 'rgba(70,58,30,0.3)';
      g.fillRect(0, y + 14, W2, 6);
    }
    for (let x = 6; x < W2; x += 32) {
      g.fillStyle = 'rgba(70,58,30,0.4)';
      lancetPath(g, x, 16, 18, 46);
      g.fill();
    }
    const grd = g.createLinearGradient(0, H2 - 200, 0, H2);
    grd.addColorStop(0, 'rgba(40,34,20,0)');
    grd.addColorStop(1, 'rgba(40,34,20,0.35)');
    g.fillStyle = grd;
    g.fillRect(0, H2 - 200, W2, 200);
    return finish(c);
  });
}

/** The Minster's west front: the great west window with its heart-shaped tracery, door and niches. 30 m × 31 m. */
export function westFrontTexture() {
  return once('westfront', () => {
    const [c, g] = canvas(1024, 1024);
    const img = stoneWallTexture({ tone: 'limestone' }).image;
    for (let y = 0; y < 1024; y += 256) for (let x = 0; x < 1024; x += 256) g.drawImage(img, x, y, 256, 256);
    g.fillStyle = 'rgba(240,231,205,0.5)';
    g.fillRect(0, 0, 1024, 1024);
    gothicWindow(g, 322, 150, 380, 520, 8, 21);
    // Gabled doorway.
    g.fillStyle = '#f4edd8';
    g.beginPath();
    g.moveTo(352, 1024);
    g.lineTo(352, 800);
    g.lineTo(512, 690);
    g.lineTo(672, 800);
    g.lineTo(672, 1024);
    g.fill();
    g.fillStyle = '#2b2118';
    lancetPath(g, 410, 780, 204, 244);
    g.fill();
    g.fillStyle = '#4a3422';
    lancetPath(g, 424, 800, 82, 224);
    g.fill();
    lancetPath(g, 518, 800, 82, 224);
    g.fill();
    // Niches and panelling up the buttresses.
    for (const x of [120, 230, 760, 870]) {
      for (let y = 90; y < 980; y += 150) {
        g.fillStyle = 'rgba(80,66,36,0.35)';
        lancetPath(g, x, y, 44, 110);
        g.fill();
      }
    }
    for (const y of [60, 690]) {
      g.fillStyle = 'rgba(255,250,232,0.6)';
      g.fillRect(0, y, 1024, 12);
      g.fillStyle = 'rgba(70,58,30,0.3)';
      g.fillRect(0, y + 12, 1024, 6);
    }
    const t = finish(c, { repeat: false });
    return t;
  });
}

/** Roofs: 'slate' (Welsh blue-grey), 'pantile' (York's orange clay), 'stone' (Dales stone slates), 'lead'. 2.4 m square. */
export function roofTexture(kind = 'slate') {
  return once(`roof-${kind}`, () => {
    const [c, g] = canvas(512);
    const r = rng(kind.length * 3 + 1);
    if (kind === 'pantile') {
      const cols = ['#b5563a', '#c06344', '#a84a30', '#c96f4c', '#b85c3c', '#9d4530', '#cf7a54'];
      g.fillStyle = '#5a2a1c';
      g.fillRect(0, 0, 512, 512);
      const cw = 512 / 10, rh = 512 / 8;
      for (let row = 0; row < 8; row++) {
        for (let col = 0; col < 10; col++) {
          const x = col * cw, y = row * rh;
          const base = cols[Math.floor(r() * cols.length)];
          // The S-curve: a lit roll and a shaded channel.
          const grd = g.createLinearGradient(x, 0, x + cw, 0);
          grd.addColorStop(0, shade(base, 0.62));
          grd.addColorStop(0.22, shade(base, 0.86));
          grd.addColorStop(0.55, shade(base, 1.16));
          grd.addColorStop(0.82, base);
          grd.addColorStop(1, shade(base, 0.55));
          g.fillStyle = grd;
          g.fillRect(x, y, cw, rh);
          g.fillStyle = 'rgba(0,0,0,0.32)';
          g.fillRect(x, y + rh - 5, cw, 5); // the tail of the tile above casts a line of shadow
        }
      }
      mottle(g, 512, 512, 24, ['#6e3a26', '#e08a62', '#7a6a40'], 30, 110, 0.14, 7);
      speckle(g, 512, 512, 2500, ['#3a2a1a', '#d9c090', '#8a9060'], 1, 3, 17, 0.1, 0.35);
      return finish(c);
    }
    if (kind === 'lead') {
      g.fillStyle = '#7d8786';
      g.fillRect(0, 0, 512, 512);
      mottle(g, 512, 512, 30, ['#6b7574', '#929c9a', '#5f6968'], 40, 150, 0.25, 9);
      for (let x = 0; x < 512; x += 128) {
        g.fillStyle = 'rgba(255,255,255,0.2)';
        g.fillRect(x + 2, 0, 5, 512);
        g.fillStyle = 'rgba(0,0,0,0.3)';
        g.fillRect(x + 7, 0, 5, 512);
      }
      return finish(c);
    }
    const stone = kind === 'stone';
    const cols = stone ? ['#7f7a6c', '#8a8576', '#746f62', '#958f7e', '#6c685c'] : ['#4a5058', '#535a62', '#434950', '#5c636b', '#3d4349', '#4f5560'];
    g.fillStyle = stone ? '#35322c' : '#22252a';
    g.fillRect(0, 0, 512, 512);
    const rows = stone ? 8 : 12, rh = 512 / rows, n = stone ? 6 : 8, sw = 512 / n;
    for (let row = 0; row < rows; row++) {
      const off = row % 2 ? sw / 2 : 0;
      for (let k = -1; k <= n; k++) {
        const x = k * sw + off;
        const base = cols[Math.floor(r() * cols.length)];
        const grd = g.createLinearGradient(0, row * rh, 0, (row + 1) * rh);
        grd.addColorStop(0, shade(base, 0.8));
        grd.addColorStop(0.3, base);
        grd.addColorStop(1, shade(base, 1.12));
        g.fillStyle = grd;
        g.fillRect(x + 1, row * rh, sw - 2, rh - 1);
        g.fillStyle = 'rgba(0,0,0,0.38)';
        g.fillRect(x + 1, (row + 1) * rh - 4, sw - 2, 4);
      }
    }
    mottle(g, 512, 512, 22, stone ? ['#5c6040', '#a8a290', '#4c4a40'] : ['#2c3036', '#6c747c', '#4a5440'], 30, 110, 0.16, 6);
    speckle(g, 512, 512, 2600, stone ? ['#7a8a5a', '#b9b49c', '#3c3a34'] : ['#7a8a6a', '#8f979f', '#22262a'], 1, 3, 17, 0.1, 0.4); // lichen
    return finish(c);
  });
}

/** Granite setts for York's old streets. 2 m square. */
export function cobbleTexture() {
  return once('cobbles', () => {
    const [c, g] = canvas(512);
    g.fillStyle = '#4a463f';
    g.fillRect(0, 0, 512, 512);
    const r = rng(2);
    const rh = 32, sw = 512 / 10;
    for (let y = 0; y < 512; y += rh) {
      const off = (y / rh) % 2 ? sw / 2 : 0;
      for (let k = -1; k <= 10; k++) {
        const v = 122 + Math.floor(r() * 46);
        g.fillStyle = `rgb(${v},${v - 5},${v - 14})`;
        g.beginPath();
        g.roundRect(k * sw + off + 2.5, y + 2.5, sw - 5, rh - 5, 7);
        g.fill();
        g.fillStyle = 'rgba(255,255,255,0.13)';
        g.beginPath();
        g.roundRect(k * sw + off + 6, y + 5, sw - 16, 7, 3);
        g.fill();
      }
    }
    mottle(g, 512, 512, 20, ['#3c3a34', '#b0aa9c'], 40, 140, 0.15, 3);
    return finish(c);
  });
}

/** York stone paving flags in random widths, warm buff-grey. 3 m square. */
export function pavingTexture() {
  return once('paving', () => {
    const [c, g] = canvas(512);
    g.fillStyle = '#77736a';
    g.fillRect(0, 0, 512, 512);
    const r = rng(19);
    const rows = 5, rh = 512 / rows;
    for (let row = 0; row < rows; row++) {
      let x = 0;
      while (x < 512) {
        const w = Math.min(512 - x, 70 + r() * 90);
        const v = 148 + Math.floor(r() * 24);
        g.fillStyle = `rgb(${v},${v - 5},${v - 16})`;
        g.fillRect(x + 1.5, row * rh + 1.5, w - 3, rh - 3);
        x += w;
      }
    }
    mottle(g, 512, 512, 30, ['#8c8778', '#c9c3b2', '#7d7a70'], 30, 120, 0.18, 22);
    speckle(g, 512, 512, 5000, ['#6c6862', '#d1ccbf'], 1, 2.2, 23, 0.1, 0.3);
    return finish(c);
  });
}

/** A soft round blob used for contact shadows under riders, trees and sheep. */
export function blobTexture() {
  return once('blob', () => {
    const [c, g] = canvas(128);
    const grd = g.createRadialGradient(64, 64, 2, 64, 64, 62);
    grd.addColorStop(0, 'rgba(0,0,0,0.62)');
    grd.addColorStop(0.45, 'rgba(0,0,0,0.5)');
    grd.addColorStop(0.8, 'rgba(0,0,0,0.14)');
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 128, 128);
    return finish(c, { repeat: false });
  });
}

/** Foliage: clumps of light and dark leaves, drawn pale so instance and vertex colours can tint it. */
export function leafTexture(hue = 'oak') {
  return once(`leaf-${hue}`, () => {
    const [c, g] = canvas(256);
    const con = hue === 'conifer';
    g.fillStyle = con ? '#8fae8a' : '#a9c98a';
    g.fillRect(0, 0, 256, 256);
    mottle(g, 256, 256, 40, con ? ['#6e9070', '#a8c4a0', '#5c8062'] : ['#86ac6a', '#c6e0a0', '#94b874', '#78a060'], 14, 46, 0.4, 9);
    const r = rng(hue.length * 7);
    const cols = con ? ['#5c8060', '#7c9c7c', '#b4ccac', '#4c7052'] : ['#7ca460', '#b8d896', '#d2e8b0', '#6c9654', '#9cc27c'];
    for (let i = 0; i < 1500; i++) {
      g.fillStyle = cols[Math.floor(r() * cols.length)];
      g.globalAlpha = 0.5;
      g.beginPath();
      if (con) g.ellipse(r() * 256, r() * 256, 1.2, 4 + r() * 4, (r() - 0.5) * 0.8, 0, Math.PI * 2);
      else g.ellipse(r() * 256, r() * 256, 2.5 + r() * 3.5, 1.8 + r() * 2.2, r() * Math.PI, 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = 1;
    return finish(c);
  });
}

/** Bark: vertical furrows. */
export function barkTexture() {
  return once('bark', () => {
    const [c, g] = canvas(128);
    g.fillStyle = '#6a5744';
    g.fillRect(0, 0, 128, 128);
    const r = rng(88);
    for (let i = 0; i < 260; i++) {
      g.strokeStyle = r() < 0.5 ? 'rgba(40,30,22,0.5)' : 'rgba(150,130,104,0.4)';
      g.lineWidth = 1 + r() * 2;
      const x = r() * 128, y = r() * 128;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + (r() - 0.5) * 5, y + 12 + r() * 30);
      g.stroke();
    }
    return finish(c);
  });
}

/** Text drawn on a canvas, for banners and signs. */
export function textTexture(text, { width = 1024, height = 128, bg = '#1d7f46', fg = '#ffffff', font = '700 72px Segoe UI, Arial, sans-serif' } = {}) {
  return once(`text-${text}-${width}-${height}-${bg}-${fg}`, () => {
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    const g = c.getContext('2d');
    g.fillStyle = bg;
    g.fillRect(0, 0, width, height);
    // A little depth: lighter at the top, darker at the bottom.
    const grd = g.createLinearGradient(0, 0, 0, height);
    grd.addColorStop(0, 'rgba(255,255,255,0.14)');
    grd.addColorStop(1, 'rgba(0,0,0,0.16)');
    g.fillStyle = grd;
    g.fillRect(0, 0, width, height);
    g.fillStyle = fg;
    g.font = font;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, width / 2, height / 2 + 4);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    return t;
  });
}

/** Water colour: deep green-brown river water with soft streaks. */
export function waterTexture() {
  return once('water', () => {
    const [c, g] = canvas(256);
    g.fillStyle = '#4c6a68';
    g.fillRect(0, 0, 256, 256);
    mottle(g, 256, 256, 30, ['#3f5c5e', '#5a7a74', '#48645c', '#56767a'], 20, 80, 0.3, 41);
    return finish(c);
  });
}

/** A seamless ripple normal map for water (sum of periodic waves, so it tiles exactly). */
export function waterNormalTexture() {
  return once('water-normal', () => {
    const n = 256;
    const c = document.createElement('canvas');
    c.width = c.height = n;
    const g = c.getContext('2d');
    const img = g.createImageData(n, n);
    const r = rng(77);
    const waves = [];
    for (let i = 0; i < 22; i++) {
      const kx = Math.round((r() - 0.5) * 16), ky = Math.round((r() - 0.5) * 16);
      const k = Math.hypot(kx, ky) || 1;
      waves.push({ kx, ky, a: (0.5 + r()) / (k * 1.3), p: r() * 6.283 });
    }
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        let dx = 0, dy = 0;
        for (const w of waves) {
          const ph = 6.283185 * ((w.kx * x + w.ky * y) / n) + w.p;
          const cs = Math.cos(ph) * w.a;
          dx += cs * w.kx;
          dy += cs * w.ky;
        }
        const s = 0.55;
        const nx = -dx * s, ny = -dy * s, nz = 1;
        const l = Math.hypot(nx, ny, nz);
        const i = (y * n + x) * 4;
        img.data[i] = (nx / l * 0.5 + 0.5) * 255;
        img.data[i + 1] = (ny / l * 0.5 + 0.5) * 255;
        img.data[i + 2] = (nz / l * 0.5 + 0.5) * 255;
        img.data[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    return finish(c, { srgb: false });
  });
}

/** Painted cast-iron railings (transparent between the bars). 2 m × 1.1 m. */
export function railingTexture(colour = '#1f3d2c') {
  return once(`railing-${colour}`, () => {
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = colour;
    g.fillRect(0, 4, 256, 12);
    g.fillRect(0, 100, 256, 9);
    g.fillRect(0, 122, 256, 6);
    for (let x = 4; x < 256; x += 16) {
      g.fillRect(x, 0, 5, 128);
      g.beginPath();
      g.arc(x + 2.5, 3, 4.5, 0, Math.PI * 2);
      g.fill();
    }
    g.strokeStyle = colour;
    g.lineWidth = 3;
    for (let x = 12; x < 256; x += 32) {
      g.beginPath();
      g.arc(x + 8.5, 58, 10, 0, Math.PI * 2);
      g.stroke();
    }
    // A light edge so the ironwork catches the sun.
    g.fillStyle = 'rgba(255,255,255,0.18)';
    g.fillRect(0, 4, 256, 3);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = THREE.RepeatWrapping;
    t.anisotropy = 8;
    return t;
  });
}

/**
 * The side of an iron arch bridge, drawn across one whole span (U 0…1) and from the deck (top) down to the
 * water: a shallow painted arch rib with open spandrel rings, transparent under the arch.
 */
export function bridgeArchTexture(paint = '#e9e2c8', accent = '#2f5d8a') {
  return once(`arch-${paint}-${accent}`, () => {
    const c = document.createElement('canvas');
    c.width = 1024;
    c.height = 256;
    const g = c.getContext('2d');
    // Spandrel: solid, then cut the arch opening out of it.
    g.fillStyle = paint;
    g.fillRect(0, 0, 1024, 256);
    g.globalCompositeOperation = 'destination-out';
    g.beginPath();
    g.moveTo(30, 256);
    g.quadraticCurveTo(512, -40, 994, 256);
    g.closePath();
    g.fill();
    g.globalCompositeOperation = 'source-over';
    // The arch rib.
    g.strokeStyle = accent;
    g.lineWidth = 16;
    g.beginPath();
    g.moveTo(30, 256);
    g.quadraticCurveTo(512, -40, 994, 256);
    g.stroke();
    g.strokeStyle = '#d7b24a';
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(30, 248);
    g.quadraticCurveTo(512, -48, 994, 248);
    g.stroke();
    // Deck fascia with roundels, and spandrel rings.
    g.fillStyle = accent;
    g.fillRect(0, 0, 1024, 26);
    g.fillStyle = '#d7b24a';
    for (let x = 16; x < 1024; x += 32) {
      g.beginPath();
      g.arc(x, 13, 5, 0, Math.PI * 2);
      g.fill();
    }
    g.strokeStyle = accent;
    g.lineWidth = 5;
    for (const side of [0, 1]) {
      for (let k = 0; k < 7; k++) {
        const t = k / 7;
        const x = side ? 1024 - 20 - t * 330 : 20 + t * 330;
        const rad = 34 * (1 - t) + 7;
        const y = 34 + rad;
        g.beginPath();
        g.arc(x + (side ? -rad : rad), y, rad, 0, Math.PI * 2);
        g.stroke();
      }
    }
    const tx = new THREE.CanvasTexture(c);
    tx.colorSpace = THREE.SRGBColorSpace;
    tx.anisotropy = 8;
    return tx;
  });
}
