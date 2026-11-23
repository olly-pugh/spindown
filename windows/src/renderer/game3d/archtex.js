// Surfaces for the architecture builders, painted on canvases at start-up and packed into texture arrays so a
// whole chunk of buildings (walls, roofs, stone dressings, joinery and glass) is one draw call. Each vertex
// carries a layer index (archgeo.js); the material looks the layer up and sets roughness and metalness per
// layer. Glazing layers keep glass in their alpha channel: glass is smooth and reflects the sky, while frames,
// glazing bars and tracery are matt and take the vertex colour (so one texture gives white sashes, black
// shopfronts or oak casements).
import * as THREE from 'three';
import * as T from './textures.js';
import { rng } from '../../core/world/noise.js';

// ---- Small canvas helpers (as in textures.js) -----------------------------------------------------------
let SIZE = 512;

function canvas() {
  const c = document.createElement('canvas');
  c.width = c.height = SIZE;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.scale(SIZE / 512, SIZE / 512);
  return [c, g];
}

function speckle(g, n, colours, rMin, rMax, seed, aMin = 0.2, aMax = 0.6, w = 512, h = 512, x0 = 0, y0 = 0) {
  const r = rng(seed);
  for (let i = 0; i < n; i++) {
    g.fillStyle = colours[Math.floor(r() * colours.length)];
    const s = rMin + r() * (rMax - rMin);
    g.globalAlpha = aMin + r() * (aMax - aMin);
    g.fillRect(x0 + r() * w, y0 + r() * h, s, s);
  }
  g.globalAlpha = 1;
}

function mottle(g, n, colours, rMin, rMax, alpha, seed, w = 512, h = 512) {
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

/** Copies an existing texture's canvas (any size) over the whole layer. */
const from = (tex) => (g) => g.drawImage(tex.image, 0, 0, 512, 512);

// ---- Layers ----------------------------------------------------------------------------------------------
// tile: metres per repeat (0 = uv given directly, 0…1 over the element). rough/metal: PBR. glass: alpha is glass.
const DEFS = [];
export const L = {};
function def(key, tile, rough, metal, glass, draw) {
  L[key] = DEFS.length;
  DEFS.push({ key, tile, rough, metal, glass, draw });
}

// Roofs.
def('SLATE', 2.4, 0.62, 0, false, () => from(T.roofTexture('slate')));
def('PANTILE', 2.4, 0.8, 0, false, () => from(T.roofTexture('pantile')));
def('PLAINTILE', 2.4, 0.85, 0, false, () => plainTiles);
def('STONESLATE', 2.4, 0.92, 0, false, () => stoneSlates);
def('LEAD', 2.4, 0.5, 0.25, false, () => from(T.roofTexture('lead')));
// Walling.
def('BRICK', 4, 0.9, 0, false, () => (g) => brickwork(g, GEORGIAN_BRICK));
def('BRICK2', 4, 0.88, 0, false, () => (g) => brickwork(g, VICTORIAN_BRICK));
def('BUFF', 4, 0.9, 0, false, () => (g) => brickwork(g, BUFF_BRICK));
def('RENDER', 4, 0.92, 0, false, () => render);
def('LIMESTONE', 4, 0.9, 0, false, () => from(T.stoneWallTexture({ tone: 'limestone' })));
def('RUBBLE', 4, 0.95, 0, false, () => from(T.stoneWallTexture({ tone: 'rubble' })));
def('DALESLIME', 4, 0.95, 0, false, () => dalesLimestone);
def('ASHLARWALL', 4, 0.85, 0, false, () => ashlarWall);
// Dressings and joinery (near white: the vertex colour gives the paint or stone colour).
def('PAINT', 1, 0.55, 0, false, () => paint);
def('ASHLAR', 2, 0.85, 0, false, () => ashlar);
def('OAK', 1.5, 0.85, 0, false, () => oak);
def('DOOR', 0, 0.5, 0, false, () => doors);
def('ARCHBRICK', 0, 0.9, 0, false, () => gaugedArch);
def('SIGNS0', 0, 0.45, 0, false, () => (g) => signs(g, 0));
def('SIGNS1', 0, 0.45, 0, false, () => (g) => signs(g, 1));
def('DARK', 1, 0.95, 0, false, () => (g) => { g.fillStyle = '#17150f'; g.fillRect(0, 0, 512, 512); mottle(g, 12, ['#262219', '#0b0a08'], 40, 160, 0.4, 3); });
// Glazing (uv 0…1 over the opening; several layers hold four variants in quarters).
def('SASH6', 0, 0.05, 0, true, () => (g) => sashes(g, 3, 2));
def('SASH2', 0, 0.05, 0, true, () => (g) => sashes(g, 2, 1));
def('SASH1', 0, 0.05, 0, true, () => (g) => sashes(g, 1, 1));
def('CASEMENT', 0, 0.08, 0, true, () => casements);
def('LEADED', 0, 0.2, 0, true, () => leaded);
def('SHOP', 0, 0.05, 0, true, () => shopGlass);
def('FAN', 0, 0.08, 0, true, () => fanlight);
def('LANCET', 0, 0.25, 0, true, () => lancets);
def('ROSE', 0, 0.25, 0, true, () => roseWindow);
def('WESTWIN', 0, 0.25, 0, true, () => westWindow);
def('EASTWIN', 0, 0.25, 0, true, () => eastWindow);
def('LOUVRE', 0, 0.9, 0, false, () => louvres);
def('MODERN', 0, 0.04, 0.1, true, () => modernGlass);

export const LAYER_COUNT = DEFS.length;
export const TILES = DEFS.map((d) => d.tile);

// ---- Painters ----------------------------------------------------------------------------------------------

// Brickwork at 128 px per metre: 53 courses of 75 mm in a 4 m tile, 12 Flemish units across.
const GEORGIAN_BRICK = {
  bond: 'flemish', mortar: '#c4b497', seed: 8,
  stretchers: ['#a9532f', '#b5603a', '#9c4a2c', '#c06b42', '#8e4126', '#b0583a', '#a14b34', '#b8653f', '#984a33', '#c47448'],
  headers: ['#7a3e2e', '#6a3628', '#8a4a36', '#5c3428', '#93503a', '#6f4a44', '#a0583c'],
};
const VICTORIAN_BRICK = {
  bond: 'stretcher', mortar: '#9e968a', seed: 18,
  stretchers: ['#8e3e2c', '#9a4632', '#a24c36', '#84392a', '#964434', '#7c3628', '#a8523a', '#8a4030'],
  headers: ['#7a3427'],
};
const BUFF_BRICK = {
  bond: 'stretcher', mortar: '#cfc6b4', seed: 28,
  stretchers: ['#c9ac80', '#bfa074', '#d2b68c', '#b89a70', '#c4a67c', '#d8be96', '#b4966c'],
  headers: ['#b89a70'],
};

function brickwork(g, spec) {
  const r = rng(spec.seed);
  const courses = 53, ch = 512 / courses;
  const unit = 512 / 12, S = unit * (2 / 3), H = unit / 3; // stretcher and header with their joints
  g.fillStyle = spec.mortar;
  g.fillRect(0, 0, 512, 512);
  const brick = (x, y, w, h, col) => {
    const k = 0.9 + r() * 0.2;
    const c = shade(col, k);
    g.fillStyle = c;
    // Wrap round the tile edge so it repeats seamlessly.
    for (const ox of [0, -512]) {
      if (x + ox + w < 0 || x + ox > 512) continue;
      g.fillRect(x + ox + 0.7, y + 0.8, w - 1.4, h - 1.6);
      // Recessed lime joints: a shadow under the brick above, a lit arris below.
      g.fillStyle = 'rgba(40,24,16,0.28)';
      g.fillRect(x + ox + 0.7, y + 0.8, w - 1.4, 1.1);
      g.fillStyle = 'rgba(255,236,214,0.12)';
      g.fillRect(x + ox + 0.7, y + h - 2.2, w - 1.4, 1.2);
      g.fillStyle = c;
    }
    // The odd chipped or flared brick.
    if (r() < 0.06) {
      g.fillStyle = 'rgba(30,18,12,0.35)';
      g.fillRect(x + r() * w * 0.6, y + 1, 2 + r() * 4, h - 2);
    }
  };
  for (let k = 0; k < courses; k++) {
    const y = k * ch;
    if (spec.bond === 'flemish') {
      // Stretcher, header, stretcher… with the headers centred over the stretchers below.
      let x = k % 2 ? S / 2 - H / 2 - unit : 0;
      let header = k % 2 === 1;
      while (x < 512) {
        const w = header ? H : S;
        brick(x, y, w, ch, header ? spec.headers[Math.floor(r() * spec.headers.length)] : spec.stretchers[Math.floor(r() * spec.stretchers.length)]);
        x += w;
        header = !header;
      }
    } else {
      let x = k % 2 ? -S / 2 : 0;
      while (x < 512) {
        brick(x, y, S, ch, spec.stretchers[Math.floor(r() * spec.stretchers.length)]);
        x += S;
      }
    }
  }
  // Weathering: soot, rain-washed patches and a few lime-run streaks.
  mottle(g, 36, ['#3c2418', '#d9a888', '#5a3a2a', '#e6c0a0'], 30, 140, 0.11, spec.seed + 1);
  speckle(g, 7000, ['#2c1a12', '#e8c8ac', '#7a4a34'], 0.8, 1.8, spec.seed + 2, 0.06, 0.22);
}

function plainTiles(g) {
  // Handmade clay plain tiles, 265 × 165 mm laid at a 100 mm gauge: rows of small overlapping tiles.
  const cols = ['#9a4a32', '#a8573a', '#8a4030', '#b4623f', '#94472f', '#a2513a', '#7e3a2a'];
  g.fillStyle = '#3e1d14';
  g.fillRect(0, 0, 512, 512);
  const r = rng(41);
  const rowH = 512 / 24, tw = 512 / 14;
  for (let row = 0; row < 24; row++) {
    const off = row % 2 ? tw / 2 : 0;
    for (let k = -1; k <= 14; k++) {
      const x = k * tw + off + (r() - 0.5) * 2;
      const base = cols[Math.floor(r() * cols.length)];
      const grd = g.createLinearGradient(0, row * rowH, 0, (row + 1) * rowH);
      grd.addColorStop(0, shade(base, 0.72));
      grd.addColorStop(0.35, base);
      grd.addColorStop(1, shade(base, 1.12));
      g.fillStyle = grd;
      g.beginPath();
      g.roundRect(x + 0.8, row * rowH, tw - 1.6, rowH - 0.6, [0, 0, 3, 3]);
      g.fill();
    }
  }
  mottle(g, 26, ['#5f6a3a', '#3c2a1c', '#c98a62', '#6e7a48'], 20, 90, 0.18, 43);
  speckle(g, 3000, ['#7c8a4a', '#d8c08a', '#2c1c14'], 1, 3, 44, 0.12, 0.4);
}

function stoneSlates(g) {
  // Dales stone slates: thick sandstone flags in random widths, dark gaps, lichen and moss.
  const cols = ['#7d7769', '#8a8474', '#716b5e', '#958e7c', '#686357', '#837c6c', '#9a927f'];
  g.fillStyle = '#2b2924';
  g.fillRect(0, 0, 512, 512);
  const r = rng(52);
  let y = 0;
  while (y < 512) {
    const h = Math.min(512 - y, 30 + Math.floor(r() * 3) * 6);
    let x = -r() * 50;
    while (x < 512) {
      const w = 40 + r() * 70;
      const base = cols[Math.floor(r() * cols.length)];
      const grd = g.createLinearGradient(0, y, 0, y + h);
      grd.addColorStop(0, shade(base, 0.7));
      grd.addColorStop(0.3, base);
      grd.addColorStop(1, shade(base, 1.1));
      g.fillStyle = grd;
      g.beginPath();
      g.roundRect(x + 1.2, y + 0.5, w - 2.4, h - 1.5, [1, 1, 5, 5]);
      g.fill();
      x += w;
    }
    y += h;
    if (y > 500) y = 512;
  }
  mottle(g, 34, ['#6f7a3c', '#b8b27a', '#3c3a30', '#8a9a52'], 14, 70, 0.2, 53);
  speckle(g, 5000, ['#c8c27a', '#9aa85a', '#2a2822', '#e0dcc0'], 1, 3.5, 54, 0.15, 0.5);
}

function render(g) {
  g.fillStyle = '#f2eee4';
  g.fillRect(0, 0, 512, 512);
  mottle(g, 40, ['#e2dccd', '#fbf9f2', '#d8d0bd', '#efe8d6'], 40, 180, 0.3, 61);
  speckle(g, 9000, ['#e0d9c9', '#fffef8', '#cbc3b0'], 1, 2.5, 62, 0.08, 0.25);
  // Faint streaks of weathering down from sills and copings.
  const r = rng(63);
  for (let i = 0; i < 26; i++) {
    const x = r() * 512, w = 4 + r() * 18, y = r() * 512, h = 60 + r() * 200;
    const grd = g.createLinearGradient(0, y, 0, y + h);
    grd.addColorStop(0, 'rgba(90,82,66,0.1)');
    grd.addColorStop(1, 'rgba(90,82,66,0)');
    g.fillStyle = grd;
    g.fillRect(x, y, w, h);
  }
}

function ashlarWall(g) {
  // York's magnesian limestone ashlar: 333 mm courses of long, finely jointed blocks, pale cream-grey, darkened by
  // soot in patches and streaked by rain.
  g.fillStyle = '#b9b19c';
  g.fillRect(0, 0, 512, 512);
  const r = rng(201);
  const cols = ['#e6dfcc', '#e1d9c4', '#ebe4d2', '#ddd4be', '#e8e0ca', '#d8d0ba', '#efe8d8'];
  const ch = 512 / 12;
  for (let k = 0; k < 12; k++) {
    let x = -r() * 120;
    while (x < 512) {
      const w = 76 + r() * 90;
      const c = r() < 0.08 ? shade(cols[0], 0.84) : cols[Math.floor(r() * cols.length)];
      g.fillStyle = c;
      for (const ox of [0, 512]) {
        if (x + w - ox < 0) continue;
        g.fillRect(x - ox + 0.8, k * ch + 0.8, w - 1.6, ch - 1.6);
      }
      g.fillStyle = 'rgba(255,255,255,0.08)';
      g.fillRect(x + 1, k * ch + ch - 3, w - 2, 1.5);
      x += w;
    }
  }
  mottle(g, 40, ['#8c8270', '#f4efe2', '#a29a86', '#6e6658'], 30, 140, 0.12, 202);
  speckle(g, 9000, ['#b0a890', '#faf6ec', '#8a8270'], 0.8, 1.8, 203, 0.08, 0.25);
  for (let i = 0; i < 30; i++) {
    const x = r() * 512, w = 3 + r() * 14, y = r() * 512, h = 80 + r() * 240;
    const grd = g.createLinearGradient(0, y, 0, y + h);
    grd.addColorStop(0, 'rgba(70,64,52,0.12)');
    grd.addColorStop(1, 'rgba(70,64,52,0)');
    g.fillStyle = grd;
    g.fillRect(x, y, w, h);
  }
}

function dalesLimestone(g) {
  // Carboniferous limestone in random rubble courses with lime mortar: pale grey, a few rusty and dark stones.
  g.fillStyle = '#9a968c';
  g.fillRect(0, 0, 512, 512);
  const cols = ['#c9c6bd', '#b8b4aa', '#d6d3ca', '#aaa69b', '#c2bcae', '#bdb8ab', '#a59f92', '#cfc9bb'];
  const r = rng(71);
  let y = 0;
  while (y < 512) {
    const h = Math.min(512 - y, 18 + r() * 22);
    let x = -r() * 40;
    while (x < 512) {
      const w = 24 + r() * 58;
      g.fillStyle = cols[Math.floor(r() * cols.length)];
      g.beginPath();
      g.roundRect(x + 1.6, y + 1.4 + r() * 2, w - 3.2, h - 3.4 - r() * 2, 5 + r() * 4);
      g.fill();
      g.fillStyle = 'rgba(255,255,255,0.12)';
      g.fillRect(x + 4, y + 3, w - 10, 2);
      g.fillStyle = 'rgba(0,0,0,0.1)';
      g.fillRect(x + 4, y + h - 6, w - 10, 2.5);
      x += w;
    }
    y += h;
    if (y > 496) y = 512;
  }
  mottle(g, 30, ['#7c8460', '#e4e0d4', '#6e6a5e', '#a69a7c'], 20, 100, 0.18, 72);
  speckle(g, 6000, ['#4e4a42', '#ecebe4', '#7b8456', '#d0c48e'], 0.8, 2.4, 73, 0.1, 0.35);
}

function paint(g) {
  g.fillStyle = '#f5f3ee';
  g.fillRect(0, 0, 512, 512);
  const r = rng(81);
  for (let i = 0; i < 900; i++) {
    g.fillStyle = r() < 0.5 ? 'rgba(0,0,0,0.025)' : 'rgba(255,255,255,0.05)';
    g.fillRect(r() * 512, r() * 512, 1 + r() * 2, 20 + r() * 80);
  }
  mottle(g, 16, ['#e6e2d8', '#ffffff'], 40, 140, 0.2, 82);
}

function ashlar(g) {
  g.fillStyle = '#efe9db';
  g.fillRect(0, 0, 512, 512);
  mottle(g, 34, ['#ddd4c0', '#f8f4ea', '#d2c8b2', '#e8e0cc'], 30, 140, 0.3, 91);
  speckle(g, 12000, ['#d8cfbb', '#fbf8f0', '#c4baa4', '#b2a890'], 0.8, 2, 92, 0.1, 0.35);
  // Fine diagonal tooling.
  g.strokeStyle = 'rgba(120,108,84,0.06)';
  g.lineWidth = 1;
  for (let x = -512; x < 512; x += 5) {
    g.beginPath();
    g.moveTo(x, 512);
    g.lineTo(x + 512, 0);
    g.stroke();
  }
  // Dark weathering in patches.
  mottle(g, 12, ['#8f8670', '#6f6a5c'], 20, 70, 0.12, 93);
}

function oak(g) {
  // Weathered oak, silvery brown, grain running along v; darkened by vertex colour for tarred timbers.
  g.fillStyle = '#9a8c7c';
  g.fillRect(0, 0, 512, 512);
  const r = rng(101);
  for (let i = 0; i < 520; i++) {
    const x = r() * 512, w = 0.8 + r() * 3.5;
    g.fillStyle = r() < 0.55 ? `rgba(60,46,34,${0.1 + r() * 0.25})` : `rgba(210,200,184,${0.08 + r() * 0.15})`;
    g.fillRect(x, 0, w, 512);
  }
  for (let i = 0; i < 40; i++) {
    // Shakes and splits.
    const x = r() * 512, y = r() * 512, h = 30 + r() * 140;
    g.fillStyle = 'rgba(30,22,16,0.55)';
    g.fillRect(x, y, 1.6, h);
  }
  mottle(g, 18, ['#5a4a3c', '#b4a894', '#6e5e4c'], 30, 120, 0.2, 102);
}

function doors(g) {
  // Four door leaves across u (each 128 × 512, drawn pale so the vertex colour paints them): Georgian six-panel,
  // Victorian four-panel with glazed top panels, a boarded and ledged door, a half-glazed shop door.
  g.fillStyle = '#e9e7e2';
  g.fillRect(0, 0, 512, 512);
  const panel = (x, y, w, h) => {
    g.fillStyle = 'rgba(0,0,0,0.28)';
    g.fillRect(x, y, w, 3);
    g.fillRect(x, y, 3, h);
    g.fillStyle = 'rgba(255,255,255,0.45)';
    g.fillRect(x, y + h - 3, w, 3);
    g.fillRect(x + w - 3, y, 3, h);
    g.fillStyle = 'rgba(0,0,0,0.06)';
    g.fillRect(x + 8, y + 8, w - 16, h - 16);
    g.fillStyle = 'rgba(255,255,255,0.18)';
    g.fillRect(x + 8, y + h - 12, w - 16, 3);
  };
  const glassPanel = (x, y, w, h) => {
    const grd = g.createLinearGradient(x, y, x + w, y + h);
    grd.addColorStop(0, '#53606a');
    grd.addColorStop(1, '#1d242a');
    g.fillStyle = grd;
    g.fillRect(x, y, w, h);
    g.fillStyle = 'rgba(200,220,235,0.18)';
    g.fillRect(x + w * 0.15, y, w * 0.18, h);
  };
  const furniture = (x, knobX) => {
    g.fillStyle = '#c9a646';
    g.beginPath();
    g.arc(x + knobX, 270, 5, 0, Math.PI * 2);
    g.fill();
    g.fillRect(x + 44, 236, 40, 9); // letter plate
  };
  // 0: Georgian six-panel.
  let x = 0;
  for (const [y, h] of [[18, 70], [104, 150], [270, 222]]) for (const px of [14, 68]) panel(x + px, y, 46, h);
  furniture(x, 112);
  // 1: Victorian four-panel, top two glazed.
  x = 128;
  glassPanel(x + 16, 20, 42, 200);
  glassPanel(x + 70, 20, 42, 200);
  for (const px of [16, 70]) {
    g.strokeStyle = 'rgba(0,0,0,0.3)';
    g.lineWidth = 3;
    g.strokeRect(x + px, 20, 42, 200);
  }
  for (const px of [16, 70]) panel(x + px, 252, 42, 238);
  furniture(x, 112);
  // 2: Boarded and ledged.
  x = 256;
  for (let k = 0; k < 6; k++) {
    g.fillStyle = k % 2 ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.06)';
    g.fillRect(x + k * 21.3, 0, 21.3, 512);
    g.fillStyle = 'rgba(0,0,0,0.3)';
    g.fillRect(x + k * 21.3, 0, 1.6, 512);
  }
  for (const y of [70, 250, 430]) {
    g.fillStyle = 'rgba(0,0,0,0.22)';
    g.fillRect(x + 6, y + 18, 116, 4);
    g.fillStyle = 'rgba(255,255,255,0.12)';
    g.fillRect(x + 6, y, 116, 18);
  }
  g.fillStyle = '#26221e';
  g.fillRect(x + 100, 250, 7, 30);
  // 3: Half-glazed shop door.
  x = 384;
  glassPanel(x + 14, 16, 100, 280);
  g.strokeStyle = 'rgba(0,0,0,0.35)';
  g.lineWidth = 4;
  g.strokeRect(x + 14, 16, 100, 280);
  panel(x + 14, 318, 100, 170);
  g.fillStyle = '#c9a646';
  g.fillRect(x + 92, 300, 18, 6);
}

function gaugedArch(g) {
  // A flat gauged arch of rubbed bricks (u across the arch, v up): finely jointed, a shade brighter than the
  // walling, the joints radiating from a point below the opening.
  g.fillStyle = '#e8cdb8';
  g.fillRect(0, 0, 512, 512);
  const n = 17;
  const r = rng(111);
  for (let i = 0; i < n; i++) {
    const t0 = i / n, t1 = (i + 1) / n;
    const bx0 = 34 + 444 * t0, bx1 = 34 + 444 * t1;
    const tx0 = 512 * t0, tx1 = 512 * t1;
    g.fillStyle = shade('#b4603c', 0.94 + r() * 0.1);
    g.beginPath();
    g.moveTo(tx0 + 1.2, 0);
    g.lineTo(tx1 - 1.2, 0);
    g.lineTo(bx1 - 1.2, 512);
    g.lineTo(bx0 + 1.2, 512);
    g.closePath();
    g.fill();
  }
  speckle(g, 2500, ['#7a3a24', '#e8b498'], 1, 2.5, 112, 0.06, 0.2);
  mottle(g, 8, ['#4a2a1c'], 60, 180, 0.08, 113);
}

export const SIGN_NAMES = [
  'TEA ROOMS', 'ANTIQUES', 'BOOKSELLERS', 'THE BAKEHOUSE', 'CYCLES', 'DELICATESSEN', 'FLORIST', 'BUTCHER',
  'SWEET SHOP', 'GALLERY', 'WOOL SHOP', 'CHEESEMONGER', 'FUDGE KITCHEN', 'OPTICIANS', 'BARBER', 'PIE SHOP',
];
export const SIGN_PAINTS = ['#1f3a2b', '#22305a', '#5c1f26', '#1b1b1d', '#5f4419', '#23484a', '#6e2a3a', '#ece4cc', '#33452a', '#2b4f6e', '#40303a', '#e6d9b8', '#1f3a2b', '#3a2a22', '#22305a', '#5c1f26'];

function signs(g, half) {
  // Eight fascia boards per layer, one per 64-pixel row: painted board, moulded edges and gilt or cream letters.
  for (let k = 0; k < 8; k++) {
    const i = half * 8 + k;
    const y = k * 64;
    const bg = SIGN_PAINTS[i];
    const light = new THREE.Color(bg).getHSL({ h: 0, s: 0, l: 0 }).l > 0.6;
    g.fillStyle = bg;
    g.fillRect(0, y, 512, 64);
    g.fillStyle = 'rgba(255,255,255,0.12)';
    g.fillRect(0, y + 2, 512, 3);
    g.fillStyle = 'rgba(0,0,0,0.3)';
    g.fillRect(0, y + 59, 512, 5);
    g.fillStyle = light ? '#2a241c' : i % 3 === 0 ? '#e9d9a6' : '#d9b65c';
    g.font = `${i % 2 ? 700 : 600} 34px Georgia, "Times New Roman", serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const name = SIGN_NAMES[i];
    const w = g.measureText(name).width;
    g.save();
    g.translate(256, y + 33);
    g.scale(Math.min(1, 470 / w), 1);
    g.fillStyle = 'rgba(0,0,0,0.35)';
    g.fillText(name, 1.5, 1.5);
    g.fillStyle = light ? '#2a241c' : i % 3 === 0 ? '#efe2b8' : '#dcb95e';
    g.fillText(name, 0, 0);
    g.restore();
  }
}

/** Dark glass with a hint of a room beyond: curtains, a blind, a lit lamp. (x,y,w,h) in pixels. */
function pane(g, x, y, w, h, r, room) {
  const grd = g.createLinearGradient(x, y, x + w * 0.3, y + h);
  grd.addColorStop(0, '#34414c');
  grd.addColorStop(0.5, '#1b232a');
  grd.addColorStop(1, '#12171c');
  g.fillStyle = grd;
  g.fillRect(x, y, w, h);
  if (room) room(x, y, w, h);
  g.fillStyle = 'rgba(190,210,225,0.07)';
  g.beginPath();
  g.moveTo(x, y + h * 0.7);
  g.lineTo(x + w * 0.6, y);
  g.lineTo(x + w * 0.9, y);
  g.lineTo(x, y + h);
  g.fill();
  void r;
}

/**
 * Sash windows in four variants (quarters of the layer): nx × ny panes in each sash, a box frame, meeting rail
 * and horns. Drawn for an opening about 1.8 times taller than wide, so the bars come out evenly thick.
 */
function sashes(g, nx, ny) {
  const r = rng(nx * 10 + ny);
  for (let q = 0; q < 4; q++) {
    const X = (q % 2) * 256, Y = Math.floor(q / 2) * 256;
    g.save();
    g.beginPath();
    g.rect(X, Y, 256, 256);
    g.clip();
    // Interior: glass everywhere first (alpha 1), then the frame (alpha 0) over it.
    const curtains = ['rgba(222,210,188,0.85)', 'rgba(150,52,52,0.75)', 'rgba(196,206,214,0.8)', 'rgba(70,98,80,0.75)'][q];
    const room = (x, y, w, h) => {
      if (q === 1 || q === 3) {
        g.fillStyle = curtains;
        g.fillRect(x, y, w * 0.16, h);
        g.fillRect(x + w * 0.84, y, w * 0.16, h);
      }
      if (q === 2) {
        g.fillStyle = 'rgba(232,226,208,0.9)';
        g.fillRect(x, y, w, h * 0.3);
      }
      if (q === 3) {
        const grd = g.createRadialGradient(x + w * 0.5, y + h * 0.72, 2, x + w * 0.5, y + h * 0.72, w * 0.5);
        grd.addColorStop(0, 'rgba(255,214,150,0.55)');
        grd.addColorStop(1, 'rgba(255,214,150,0)');
        g.fillStyle = grd;
        g.fillRect(x, y, w, h);
      }
    };
    pane(g, X, Y, 256, 256, r, room);
    g.restore();
  }
  // Frames: drawn into the alpha channel by painting opaque white bars over a glass-alpha canvas later.
  return { nx, ny };
}

/** Frame bars for the sash layers, drawn as rectangles in a quarter (alpha 0 marks frame). */
function sashFrames(nx, ny) {
  const bars = [];
  const fx = 14, fy = 9; // box frame (u, v in px of a 256 quarter)
  bars.push([0, 0, 256, fy], [0, 256 - fy - 6, 256, fy + 6], [0, 0, fx, 256], [256 - fx, 0, fx, 256]);
  const mid = 128;
  bars.push([0, mid - 5, 256, 10]); // meeting rail
  const top = [fy, mid - 5], bot = [mid + 5, 256 - fy - 6];
  for (const [y0, y1] of [top, bot]) {
    for (let i = 1; i < nx; i++) bars.push([fx + ((256 - 2 * fx) * i) / nx - 3, y0, 6, y1 - y0]);
    for (let j = 1; j < ny; j++) bars.push([fx, y0 + ((y1 - y0) * j) / ny - 2, 256 - 2 * fx, 4]);
  }
  // Sash stiles inside the box frame.
  bars.push([fx, top[0], 5, bot[1] - top[0]], [256 - fx - 5, top[0], 5, bot[1] - top[0]]);
  if (nx < 3) {
    // Victorian horns below the upper sash's meeting rail.
    bars.push([fx, mid + 5, 8, 12], [256 - fx - 8, mid + 5, 8, 12]);
  }
  return bars;
}

function casements(g) {
  // Small-paned casements (two lights side by side across the quarter) for Dales farmhouses.
  const r = rng(121);
  for (let q = 0; q < 4; q++) {
    const X = (q % 2) * 256, Y = Math.floor(q / 2) * 256;
    pane(g, X, Y, 256, 256, r, q === 1 ? (x, y, w, h) => { g.fillStyle = 'rgba(214,206,186,0.8)'; g.fillRect(x, y, w * 0.2, h); g.fillRect(x + w * 0.8, y, w * 0.2, h); } : null);
  }
}

function casementFrames() {
  const bars = [];
  const f = 12;
  bars.push([0, 0, 256, f], [0, 256 - f, 256, f], [0, 0, f, 256], [256 - f, 0, f, 256]);
  for (let i = 1; i < 3; i++) bars.push([f + ((256 - 2 * f) * i) / 3 - 2.5, f, 5, 256 - 2 * f]);
  for (let j = 1; j < 4; j++) bars.push([f, f + ((256 - 2 * f) * j) / 4 - 2, 256 - 2 * f, 4]);
  return bars;
}

function leaded(g) {
  // Diamond leaded lights in an oak frame with a mullion: timber-framed houses.
  const r = rng(131);
  for (let q = 0; q < 4; q++) {
    const X = (q % 2) * 256, Y = Math.floor(q / 2) * 256;
    g.save();
    g.beginPath();
    g.rect(X, Y, 256, 256);
    g.clip();
    pane(g, X, Y, 256, 256, r, null);
    // Slightly greenish old glass, uneven.
    g.fillStyle = 'rgba(120,150,120,0.12)';
    g.fillRect(X, Y, 256, 256);
    g.strokeStyle = 'rgba(70,72,70,0.9)';
    g.lineWidth = 1.6;
    for (let k = -256; k < 512; k += 22) {
      g.beginPath();
      g.moveTo(X + k, Y);
      g.lineTo(X + k + 256, Y + 256);
      g.moveTo(X + k + 256, Y);
      g.lineTo(X + k, Y + 256);
      g.stroke();
    }
    g.restore();
  }
}

function leadedFrames() {
  const f = 14;
  return [[0, 0, 256, f], [0, 256 - f, 256, f], [0, 0, f, 256], [256 - f, 0, f, 256], [128 - 6, 0, 12, 256], [0, 92, 256, 10]];
}

function shopGlass(g) {
  // Big shop windows: plate glass over goods on shelves, a lit interior, a row of small transom lights.
  const r = rng(141);
  const goods = ['#e8c56a', '#c75a4a', '#7fa36a', '#f1e7d0', '#5a7fb0', '#d98a3a', '#a46aa8', '#efd8a8', '#6a4a3a'];
  for (let q = 0; q < 4; q++) {
    const X = (q % 2) * 256, Y = Math.floor(q / 2) * 256;
    g.save();
    g.beginPath();
    g.rect(X, Y, 256, 256);
    g.clip();
    const grd = g.createLinearGradient(X, Y, X, Y + 256);
    grd.addColorStop(0, '#2a3138');
    grd.addColorStop(0.6, '#3a3630');
    grd.addColorStop(1, '#4a4238');
    g.fillStyle = grd;
    g.fillRect(X, Y, 256, 256);
    // Warm interior light.
    const lg = g.createRadialGradient(X + 128, Y + 120, 10, X + 128, Y + 120, 170);
    lg.addColorStop(0, 'rgba(255,226,170,0.45)');
    lg.addColorStop(1, 'rgba(255,226,170,0)');
    g.fillStyle = lg;
    g.fillRect(X, Y, 256, 256);
    // Shelves and goods.
    for (const sy of [118, 168, 214]) {
      g.fillStyle = 'rgba(40,30,22,0.9)';
      g.fillRect(X + 10, Y + sy, 236, 5);
      let x = X + 14;
      while (x < X + 240) {
        const w = 8 + r() * 20, h = 12 + r() * 26;
        g.fillStyle = goods[Math.floor(r() * goods.length)];
        g.fillRect(x, Y + sy - h, w, h);
        g.fillStyle = 'rgba(0,0,0,0.25)';
        g.fillRect(x + w - 2, Y + sy - h, 2, h);
        x += w + 2 + r() * 6;
      }
    }
    // Reflections.
    g.fillStyle = 'rgba(200,220,235,0.12)';
    g.beginPath();
    g.moveTo(X, Y + 180);
    g.lineTo(X + 140, Y + 40);
    g.lineTo(X + 190, Y + 40);
    g.lineTo(X, Y + 240);
    g.fill();
    g.restore();
  }
}

function shopFrames() {
  // Transom bar with small lights above, a central glazing bar, a frame.
  const f = 9;
  const bars = [[0, 0, 256, f], [0, 256 - f, 256, f], [0, 0, f, 256], [256 - f, 0, f, 256], [0, 52, 256, 8], [125, 52, 6, 204]];
  for (let k = 1; k < 4; k++) bars.push([(256 * k) / 4 - 2, 0, 4, 56]);
  return bars;
}

function fanlight(g) {
  const r = rng(151);
  pane(g, 0, 0, 512, 512, r, null);
}

function fanFrames() {
  return null; // drawn as a path below
}

function lancets(g) {
  // Gothic windows (one variant per quarter strip, 128 × 512): grisaille and coloured glass in lead cames,
  // stone mullions dividing 2, 3, 4 or 5 lights, cusped heads and a transom. The pointed outline comes from the
  // geometry; the head tracery assumes an equilateral arch over the top of the strip.
  const r = rng(161);
  const cols = ['#7d93a8', '#9aa59a', '#b8b49a', '#c9b071', '#6a3a4a', '#38507a', '#7a2c2c', '#4c6e5a', '#a8b4b8', '#d8d0b0'];
  for (let q = 0; q < 4; q++) {
    const X = q * 128;
    // Glass: mostly grisaille with bands of colour, broken into small quarries.
    for (let y = 0; y < 512; y += 9) {
      for (let x = 0; x < 128; x += 7) {
        const band = Math.floor(y / 64) % 3 === 1;
        g.fillStyle = band ? cols[3 + Math.floor(r() * 6)] : cols[Math.floor(r() * 3) + (r() < 0.15 ? 7 : 0)];
        g.globalAlpha = 0.85;
        g.fillRect(X + x, y, 7, 9);
      }
    }
    g.globalAlpha = 1;
    g.fillStyle = 'rgba(10,14,20,0.55)';
    g.fillRect(X, 0, 128, 512);
    g.strokeStyle = 'rgba(30,30,32,0.7)';
    g.lineWidth = 1;
    for (let y = 0; y < 512; y += 9) {
      g.beginPath();
      g.moveTo(X, y);
      g.lineTo(X + 128, y);
      g.stroke();
    }
  }
}

function lancetFrames() {
  return null;
}

function roseWindow(g) {
  // A wheel window: radiating lights of red and white glass round a central rosette.
  const cx = 256, cy = 256;
  const r = rng(171);
  g.fillStyle = '#1c2230';
  g.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 2600; i++) {
    const a = r() * Math.PI * 2, d = Math.sqrt(r()) * 250;
    g.fillStyle = ['#b03a3a', '#d8d0b4', '#c9a54a', '#3a5a9a', '#e6e0cc', '#7a2c2c', '#4a7a5a'][Math.floor(r() * 7)];
    g.globalAlpha = 0.75;
    g.fillRect(cx + Math.cos(a) * d - 3, cy + Math.sin(a) * d - 3, 6, 6);
  }
  g.globalAlpha = 1;
  void cx;
}

function westWindow(g) {
  // The Great West Window: eight lights under flowing (curvilinear) tracery with the "heart" in the head.
  const r = rng(181);
  g.fillStyle = '#1a2230';
  g.fillRect(0, 0, 512, 512);
  const cols = ['#9aa59a', '#b8b49a', '#c9a54a', '#7a2c2c', '#38507a', '#a8b4b8', '#d8d0b0', '#5a3a6a'];
  for (let y = 0; y < 512; y += 8) {
    for (let x = 0; x < 512; x += 6) {
      g.fillStyle = cols[Math.floor(r() * cols.length)];
      g.globalAlpha = 0.7;
      g.fillRect(x, y, 6, 8);
    }
  }
  g.globalAlpha = 1;
  g.fillStyle = 'rgba(10,14,20,0.45)';
  g.fillRect(0, 0, 512, 512);
}

function eastWindow(g) {
  westWindow(g);
}

function louvres(g) {
  // Belfry louvre boards behind two pointed lights.
  g.fillStyle = '#2c2924';
  g.fillRect(0, 0, 512, 512);
  for (let y = 0; y < 512; y += 22) {
    const grd = g.createLinearGradient(0, y, 0, y + 22);
    grd.addColorStop(0, '#6e675c');
    grd.addColorStop(0.6, '#4a453d');
    grd.addColorStop(1, '#16140f');
    g.fillStyle = grd;
    g.fillRect(0, y, 512, 22);
  }
}

function modernGlass(g) {
  // Curtain-wall or ribbon glazing for modern blocks: blue-grey glass, thin dark mullions every quarter.
  const r = rng(191);
  for (let q = 0; q < 4; q++) {
    const X = (q % 2) * 256, Y = Math.floor(q / 2) * 256;
    const grd = g.createLinearGradient(X, Y, X + 80, Y + 256);
    grd.addColorStop(0, '#5d7486');
    grd.addColorStop(0.5, '#2d3c49');
    grd.addColorStop(1, '#1d2731');
    g.fillStyle = grd;
    g.fillRect(X, Y, 256, 256);
    if (q % 2) {
      g.fillStyle = 'rgba(230,230,224,0.7)';
      g.fillRect(X, Y, 256, 50 + r() * 60);
    }
  }
}

function modernFrames() {
  const f = 6;
  return [[0, 0, 256, f], [0, 256 - f, 256, f], [0, 0, f, 256], [256 - f, 0, f, 256], [126, 0, 4, 256]];
}

// Frame masks per glazing layer: rectangles in a 256 × 256 quarter (repeated in all four), alpha 0 = frame.
const FRAMES = {
  SASH6: () => sashFrames(3, 2),
  SASH2: () => sashFrames(2, 1),
  SASH1: () => sashFrames(1, 1),
  CASEMENT: casementFrames,
  LEADED: leadedFrames,
  SHOP: shopFrames,
  MODERN: modernFrames,
};

/** Paints the frame colour (near white, so the vertex colour paints it) and marks it in alpha. */
function applyFrames(key, img) {
  const d = img.data, S = img.width, k = S / 512;
  const setFrame = (x0, y0, w, h) => {
    const xa = Math.max(0, Math.floor(x0 * k)), ya = Math.max(0, Math.floor(y0 * k));
    const xb = Math.min(S, Math.ceil((x0 + w) * k)), yb = Math.min(S, Math.ceil((y0 + h) * k));
    for (let y = ya; y < yb; y++) {
      for (let x = xa; x < xb; x++) {
        const i = (y * S + x) * 4;
        // A little shading so the bars read as mouldings.
        const edge = y === ya || x === xa ? 0.82 : y === yb - 1 || x === xb - 1 ? 1.0 : 0.94;
        d[i] = d[i + 1] = d[i + 2] = Math.round(240 * edge);
        d[i + 3] = 0;
      }
    }
  };
  const bars = FRAMES[key]?.();
  if (bars) {
    for (let q = 0; q < 4; q++) {
      const X = (q % 2) * 256, Y = Math.floor(q / 2) * 256;
      for (const [x, y, w, h] of bars) setFrame(X + x, Y + y, w, h);
    }
  }
  if (key === 'FAN') {
    // A semicircular fanlight: radiating bars from the middle of the bottom edge, a frame round the arc.
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u = x / S, v = 1 - y / S; // v up from the bottom edge
        const dx = (u - 0.5) * 2, dy = v * 2; // the arc is radius 1 in these units (full width)
        const rr = Math.hypot(dx, dy);
        const a = Math.atan2(dy, dx);
        const spoke = Math.abs(((a / Math.PI) * 8) % 1 - 0.5) > 0.44 && rr > 0.18;
        const frame = rr > 0.9 || v < 0.05 || (rr > 0.16 && rr < 0.24) || spoke;
        if (rr > 1) {
          const i = (y * S + x) * 4;
          d[i] = d[i + 1] = d[i + 2] = 230;
          d[i + 3] = 0;
        } else if (frame) {
          const i = (y * S + x) * 4;
          d[i] = d[i + 1] = d[i + 2] = 236;
          d[i + 3] = 0;
        }
      }
    }
  }
  if (key === 'LANCET') {
    // Stone tracery per quarter strip: frame, mullions for 2–5 lights, a transom, cusped heads.
    for (let q = 0; q < 4; q++) {
      const lights = q + 2;
      const X0 = q * 128;
      for (let y = 0; y < S; y++) {
        for (let x = Math.floor(X0 * k); x < Math.floor((X0 + 128) * k); x++) {
          const u = (x / k - X0) / 128, v = y / S; // v down from the top
          const top = 128 / 512 * 0.9; // the arch occupies about the top 22% of a 3.5:1 opening
          let frame = u < 0.05 || u > 0.95 || v > 0.985;
          const li = Math.floor(u * lights), lu = u * lights - li;
          if (!frame && v > top * 0.85) frame = (lu < 0.07 || lu > 0.93) && li > -1 && (u > 0.05 && u < 0.95) && ((li > 0 && lu < 0.07) || (li < lights - 1 && lu > 0.93));
          if (!frame && Math.abs(v - 0.58) < 0.006) frame = true; // transom
          // Pointed, cusped light heads just below the arch.
          if (!frame && v > top * 0.85 && v < top * 0.85 + 0.06) {
            const hv = (v - top * 0.85) / 0.06; // 0 at the apex row … 1 at the springing
            const half = Math.abs(lu - 0.5) * 2; // 0 middle … 1 edge of the light
            if (half > 1 - (1 - (1 - hv) ** 2) * 0.9 - 0.05 && half < 1.02 - (1 - hv) * 0.8) frame = true;
          }
          // Head tracery: circles (foiled) in the arch zone.
          if (!frame && v < top * 0.85) {
            const cy = top * 0.48, rr = Math.hypot((u - 0.5) * 1.0, (v - cy) * 4);
            frame = Math.abs(rr - 0.16) < 0.022 || (lights > 2 && Math.abs(u - 0.5) < 0.025 && v > cy + 0.05);
          }
          if (frame) {
            const i = (y * S + x) * 4;
            d[i] = d[i + 1] = d[i + 2] = 226;
            d[i + 3] = 0;
          }
        }
      }
    }
  }
  if (key === 'ROSE') {
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const dx = x / S - 0.5, dy = y / S - 0.5, rr = Math.hypot(dx, dy) * 2, a = Math.atan2(dy, dx);
        const spokes = 24;
        const sp = Math.abs(((a / (2 * Math.PI)) * spokes + 100) % 1 - 0.5);
        let frame = rr > 0.96 || Math.abs(rr - 0.32) < 0.03 || Math.abs(rr - 0.64) < 0.025 || (rr > 0.32 && sp > 0.44) || rr < 0.08;
        if (!frame && rr > 0.64) frame = sp > 0.47 || Math.abs(((a / (2 * Math.PI)) * spokes * 2 + 100) % 1 - 0.5) > 0.47;
        if (rr > 1) frame = true;
        if (frame) {
          const i = (y * S + x) * 4;
          d[i] = d[i + 1] = d[i + 2] = 224;
          d[i + 3] = 0;
        }
      }
    }
  }
  if (key === 'WESTWIN' || key === 'EASTWIN') {
    // Eight (west) or nine (east) lights; the west head has flowing tracery round a heart, the east a grid.
    const lights = key === 'WESTWIN' ? 8 : 9;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u = x / S, v = y / S; // v down from the top; the pointed head is the top ~40%
        let frame = u < 0.025 || u > 0.975 || v > 0.99;
        const lu = (u * lights) % 1;
        if (!frame && v > 0.42) frame = lu < 0.06 || lu > 0.94 || Math.abs(v - 0.71) < 0.008;
        if (!frame && v <= 0.42) {
          if (key === 'WESTWIN') {
            // Two great reticulated arcs and the heart between them.
            const hx = (u - 0.5) / 0.22, hy = (v - 0.2) / 0.2;
            const heart = (hx * hx + hy * hy - 1) ** 3 - hx * hx * (-hy) ** 3;
            frame = Math.abs(heart) < 0.06 || Math.abs(Math.hypot((u - 0.27) * 2, (v - 0.4) * 2.4) - 0.42) < 0.02 || Math.abs(Math.hypot((u - 0.73) * 2, (v - 0.4) * 2.4) - 0.42) < 0.02;
            if (!frame) frame = Math.abs(((u * 16) % 1) - 0.5) > 0.46 && v > 0.32;
          } else {
            frame = lu < 0.05 || lu > 0.95 || Math.abs(((v * 18) % 1) - 0.5) > 0.44;
          }
        }
        if (frame) {
          const i = (y * S + x) * 4;
          d[i] = d[i + 1] = d[i + 2] = 224;
          d[i + 3] = 0;
        }
      }
    }
  }
}

// ---- Packing and the material ----------------------------------------------------------------------------

let built = null;

/** The surface texture array (built once per detail level). */
export function surfaceArray(detail = 1) {
  const size = Math.max(64, Math.round(512 * detail));
  if (built && built.size === size) return built.tex;
  SIZE = size;
  const n = DEFS.length;
  const data = new Uint8Array(size * size * 4 * n);
  DEFS.forEach((d, li) => {
    const [c, g] = canvas();
    const draw = d.draw();
    draw(g);
    const img = g.getImageData(0, 0, size, size);
    // Opaque layers get alpha 1; glazing keeps glass at alpha 1 and frames at 0.
    for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
    if (d.glass) applyFrames(d.key, img);
    // Flip rows so v = 0 is the bottom of each painting (as CanvasTexture does).
    const row = size * 4, base = li * size * size * 4;
    for (let y = 0; y < size; y++) data.set(img.data.subarray(y * row, (y + 1) * row), base + (size - 1 - y) * row);
    void c;
  });
  const tex = new THREE.DataArrayTexture(data, size, size, n);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  built = { size, tex };
  return tex;
}

/** The far-facade texture array: whole painted facades (textures.facadeTexture) for distant buildings. */
export const FACADE_KINDS = ['brick', 'brick2', 'render', 'stone', 'shop', 'timber', 'church', 'office', 'cottage', 'barn'];
let facadeBuilt = null;
export function facadeArray(detail = 1) {
  const w = Math.max(64, Math.round(512 * detail)), h = Math.round(w * 1.5);
  if (facadeBuilt && facadeBuilt.w === w) return facadeBuilt.tex;
  const n = FACADE_KINDS.length;
  const data = new Uint8Array(w * h * 4 * n);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  FACADE_KINDS.forEach((k, li) => {
    g.clearRect(0, 0, w, h);
    g.drawImage(T.facadeTexture(k).image, 0, 0, w, h);
    const img = g.getImageData(0, 0, w, h);
    const row = w * 4, base = li * w * h * 4;
    for (let y = 0; y < h; y++) data.set(img.data.subarray(y * row, (y + 1) * row), base + (h - 1 - y) * row);
  });
  const tex = new THREE.DataArrayTexture(data, w, h, n);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  facadeBuilt = { w, tex };
  return tex;
}

/**
 * A standard material that reads its colour from a texture array by the per-vertex `layer` attribute, with
 * roughness/metalness per layer and glass layers (alpha = glass) taking the vertex colour only on the frame.
 */
export function layeredMaterial(arrayTex, { pbr = null, ...params } = {}) {
  const n = arrayTex.image.depth;
  const table = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const d = pbr ? pbr[i] : null;
    table[i * 3] = d?.rough ?? 0.9;
    table[i * 3 + 1] = d?.metal ?? 0;
    table[i * 3 + 2] = d?.glass ? 1 : 0;
  }
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0, ...params });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.layerMap = { value: arrayTex };
    shader.uniforms.layerPBR = { value: table };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float layer;\nvarying vec3 vLUv;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\n\tvLUv = vec3( uv, layer );');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform highp sampler2DArray layerMap;\nuniform float layerPBR[${n * 3}];\nvarying vec3 vLUv;`)
      .replace('#include <map_fragment>', `
        int li = int( vLUv.z + 0.5 );
        vec4 lTex = texture( layerMap, vec3( vLUv.xy, float( li ) ) );
        float lGlass = layerPBR[ li * 3 + 2 ] * lTex.a;
        diffuseColor.rgb *= lTex.rgb;
      `)
      .replace('#include <color_fragment>', `
        #if defined( USE_COLOR )
          diffuseColor.rgb *= mix( vColor.rgb, vec3( 1.0 ), lGlass );
        #endif
      `)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = mix( 0.75, layerPBR[ li * 3 ], layerPBR[ li * 3 + 2 ] > 0.5 ? lTex.a : 1.0 );')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = layerPBR[ li * 3 + 1 ] * ( layerPBR[ li * 3 + 2 ] > 0.5 ? lTex.a : 1.0 );')
      // Glass reflects the sky more strongly than a plain dielectric would show at this exposure.
      .replace('#include <lights_fragment_maps>', '#include <lights_fragment_maps>\n\tradiance *= 1.0 + 1.3 * lGlass;');
  };
  m.customProgramCacheKey = () => `arch-layers-${n}-${pbr ? 'pbr' : 'flat'}`;
  return m;
}

let mats = null;
/** Shared materials: surfaces (walls, roofs, dressings, glass) and far facades. */
export function materials(detail = 1) {
  const key = Math.round(512 * detail);
  if (mats && mats.key === key) return mats;
  const surf = surfaceArray(detail);
  mats = {
    key,
    surface: layeredMaterial(surf, { pbr: DEFS }),
    facade: layeredMaterial(facadeArray(detail), {}),
  };
  return mats;
}
