// Procedural textures for trees, hedges and verges, drawn on canvases at start-up (no image files to ship):
//  - the leaf atlas: sprays of oak, ash, sycamore, hawthorn, birch, lime, Scots pine and spruce foliage drawn
//    leaf by leaf with real alpha, plus hedge sprigs and grass tufts;
//  - the bark atlas: one strip per species (oak's ridges, ash's diamonds, birch's lenticels, the Scots pine's
//    orange plates...) with a matching normal map;
//  - the impostor atlas: every tree template painted side-on for the far stand-ins, with a normal map.
// Foliage textures are DataTextures rather than canvas textures, so that (a) transparent texels carry leaf
// colour instead of black, which stops dark fringes round every leaf, and (b) each mip level is rescaled to
// keep the same alpha coverage as the full-size image, so trees do not thin out and go see-through into the
// distance (the usual failure of alpha-tested foliage).
import * as THREE from 'three';
import { rng, hash2 } from '../../core/world/noise.js';

const TAU = Math.PI * 2;
const cache = new Map();
function once(key, make) {
  if (!cache.has(key)) cache.set(key, make());
  return cache.get(key);
}

export function canvas2d(w, h = w) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d', { willReadFrequently: true })];
}

// ---- Canvas → DataTexture with filled transparent texels and coverage-preserving mips -------------------

/** Straight-alpha RGBA texels of a canvas, rows flipped so the canvas top is v = 1 (as for an image). */
function texels(c) {
  const g = c.getContext('2d', { willReadFrequently: true });
  const w = c.width, h = c.height;
  const src = g.getImageData(0, 0, w, h).data;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) out.set(src.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
  return out;
}

/**
 * Push-pull fill: every texel's colour becomes its own colour where it is opaque, blended towards the
 * average colour of its neighbourhood as it becomes transparent. Alpha is left alone.
 */
function fillTransparent(px, w, h) {
  const levels = [];
  let lw = w, lh = h;
  let cur = new Float32Array(w * h * 4);
  for (let i = 0, n = w * h; i < n; i++) {
    const a = px[i * 4 + 3] / 255;
    const k = a > 0.01 ? a : 0;
    cur[i * 4] = px[i * 4] * k;
    cur[i * 4 + 1] = px[i * 4 + 1] * k;
    cur[i * 4 + 2] = px[i * 4 + 2] * k;
    cur[i * 4 + 3] = k;
  }
  levels.push([cur, lw, lh]);
  while (lw > 1 || lh > 1) {
    const nw = Math.max(1, lw >> 1), nh = Math.max(1, lh >> 1);
    const nxt = new Float32Array(nw * nh * 4);
    for (let y = 0; y < nh; y++) {
      const y0 = Math.min(lh - 1, y * 2) * lw, y1 = Math.min(lh - 1, y * 2 + 1) * lw;
      for (let x = 0; x < nw; x++) {
        const x0 = Math.min(lw - 1, x * 2), x1 = Math.min(lw - 1, x * 2 + 1);
        const a = (y0 + x0) * 4, b = (y0 + x1) * 4, c = (y1 + x0) * 4, d = (y1 + x1) * 4, o = (y * nw + x) * 4;
        for (let k = 0; k < 4; k++) nxt[o + k] = 0.25 * (cur[a + k] + cur[b + k] + cur[c + k] + cur[d + k]);
      }
    }
    levels.push([nxt, nw, nh]);
    cur = nxt;
    lw = nw;
    lh = nh;
  }
  {
    const [d] = levels[levels.length - 1];
    const k = d[3] > 0 ? 1 / d[3] : 0;
    d[0] *= k;
    d[1] *= k;
    d[2] *= k;
    d[3] = 1;
  }
  for (let l = levels.length - 2; l >= 0; l--) {
    const [d, cw, ch] = levels[l];
    const [p, pw, ph] = levels[l + 1];
    for (let y = 0; y < ch; y++) {
      const py = Math.min(ph - 1, y >> 1) * pw;
      for (let x = 0; x < cw; x++) {
        const o = (y * cw + x) * 4, q = (py + Math.min(pw - 1, x >> 1)) * 4;
        const miss = 1 - Math.min(1, d[o + 3]);
        d[o] += miss * p[q];
        d[o + 1] += miss * p[q + 1];
        d[o + 2] += miss * p[q + 2];
        d[o + 3] = 1;
      }
    }
  }
  const [d0] = levels[0];
  for (let i = 0, n = w * h; i < n; i++) {
    px[i * 4] = d0[i * 4];
    px[i * 4 + 1] = d0[i * 4 + 1];
    px[i * 4 + 2] = d0[i * 4 + 2];
  }
}

/** Fraction of texels in a rectangle whose alpha is at least t (0…255). */
function histogram(px, w, x0, y0, x1, y1) {
  const hist = new Uint32Array(256);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) hist[px[(y * w + x) * 4 + 3]]++;
  return hist;
}
function coverage(hist, t) {
  let n = 0, total = 0;
  const from = Math.max(0, Math.min(256, Math.ceil(t)));
  for (let i = 0; i < 256; i++) {
    total += hist[i];
    if (i >= from) n += hist[i];
  }
  return total ? n / total : 0;
}

/**
 * The mip chain of RGBA texels down to 1×1 (box filter). With `threshold`, each level's alpha is scaled per
 * grid cell so the share of texels passing the alpha test stays what it is at full size.
 */
function mipChain(px, w, h, { threshold = 0, grid = [1, 1] } = {}) {
  const levels = [{ data: px, width: w, height: h }];
  const t = threshold * 255;
  const [gc, gr] = grid;
  const target = [];
  if (t > 0) {
    for (let j = 0; j < gr; j++) for (let i = 0; i < gc; i++) target.push(coverage(histogram(px, w, Math.floor((i * w) / gc), Math.floor((j * h) / gr), Math.floor(((i + 1) * w) / gc), Math.floor(((j + 1) * h) / gr)), t));
  }
  let cur = px, cw = w, ch = h;
  while (cw > 1 || ch > 1) {
    const nw = Math.max(1, cw >> 1), nh = Math.max(1, ch >> 1);
    const nxt = new Uint8Array(nw * nh * 4);
    for (let y = 0; y < nh; y++) {
      const y0 = Math.min(ch - 1, y * 2) * cw, y1 = Math.min(ch - 1, y * 2 + 1) * cw;
      for (let x = 0; x < nw; x++) {
        const x0 = Math.min(cw - 1, x * 2), x1 = Math.min(cw - 1, x * 2 + 1);
        const a = (y0 + x0) * 4, b = (y0 + x1) * 4, c = (y1 + x0) * 4, d = (y1 + x1) * 4, o = (y * nw + x) * 4;
        for (let k = 0; k < 4; k++) nxt[o + k] = (cur[a + k] + cur[b + k] + cur[c + k] + cur[d + k] + 2) >> 2;
      }
    }
    if (t > 0) {
      const cellsFit = nw / gc >= 2 && nh / gr >= 2;
      const cols = cellsFit ? gc : 1, rows = cellsFit ? gr : 1;
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const want = cellsFit ? target[j * gc + i] : target.reduce((s, v) => s + v, 0) / target.length;
          if (want <= 0) continue;
          const x0 = Math.floor((i * nw) / cols), x1 = Math.floor(((i + 1) * nw) / cols), yy0 = Math.floor((j * nh) / rows), yy1 = Math.floor(((j + 1) * nh) / rows);
          const hist = histogram(nxt, nw, x0, yy0, x1, yy1);
          // Find the alpha scale s at which coverage(alpha * s >= t) matches the full-size coverage.
          let lo = 0.25, hi = 8;
          for (let it = 0; it < 14; it++) {
            const s = (lo + hi) / 2;
            if (coverage(hist, t / s) < want) lo = s;
            else hi = s;
          }
          const s = (lo + hi) / 2;
          for (let y = yy0; y < yy1; y++) for (let x = x0; x < x1; x++) { const o = (y * nw + x) * 4 + 3; nxt[o] = Math.min(255, Math.round(nxt[o] * s)); }
        }
      }
    }
    levels.push({ data: nxt, width: nw, height: nh });
    cur = nxt;
    cw = nw;
    ch = nh;
  }
  return levels;
}

/** A mipmapped DataTexture from texels (already flipped) and its mip chain. */
function dataTexture(levels, { srgb = true, wrapS = THREE.ClampToEdgeWrapping, wrapT = THREE.ClampToEdgeWrapping, anisotropy = 4 } = {}) {
  const { data, width, height } = levels[0];
  const tex = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.mipmaps = levels;
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = wrapS;
  tex.wrapT = wrapT;
  tex.anisotropy = anisotropy;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** Foliage texture from a canvas: transparent texels filled with leaf colour, coverage-preserving mips. */
export function foliageTexture(c, { threshold = 0.5, grid = [1, 1], wrapS, wrapT } = {}) {
  const px = texels(c);
  fillTransparent(px, c.width, c.height);
  return dataTexture(mipChain(px, c.width, c.height, { threshold, grid }), { wrapS, wrapT });
}

/** Tangent-space normal map (OpenGL convention) from a height field in a canvas's luminance. */
export function normalMapFrom(c, { strength = 2, wrapX = true, wrapY = true, columns = 1 } = {}) {
  const px = texels(c);
  const w = c.width, h = c.height;
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) lum[i] = (px[i * 4] * 0.3 + px[i * 4 + 1] * 0.59 + px[i * 4 + 2] * 0.11) / 255;
  const out = new Uint8Array(w * h * 4);
  const colW = w / columns;
  let base = 0;
  const at = (x, y) => {
    // Wrap x within the current column, so each bark strip tiles round its own trunk.
    const lx = wrapX ? base + ((((x - base) % colW) + colW) % colW) : Math.min(w - 1, Math.max(0, x));
    const ly = wrapY ? ((y % h) + h) % h : Math.min(h - 1, Math.max(0, y));
    return lum[ly * w + Math.floor(lx)];
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      base = Math.floor(x / colW) * colW;
      const dx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1)) - (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
      const dy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1)) - (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
      // texels are flipped (row 0 = bottom), so +y here is up the texture.
      let nx = -dx * strength, ny = -dy * strength, nz = 1;
      const l = Math.hypot(nx, ny, nz);
      nx /= l;
      ny /= l;
      nz /= l;
      const o = (y * w + x) * 4;
      out[o] = Math.round((nx * 0.5 + 0.5) * 255);
      out[o + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      out[o + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      out[o + 3] = 255;
    }
  }
  return dataTexture(mipChain(out, w, h), { srgb: false, wrapS: wrapX && columns === 1 ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping, wrapT: wrapY ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping });
}

// ---- Leaf shapes -------------------------------------------------------------------------------------
// Each outline is drawn with its stalk at the origin and its tip at (0, -1) (canvas y points down).

function lobed(g, w, n) {
  g.moveTo(0, 0);
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    g.lineTo(w(t), -t);
  }
  for (let i = n - 1; i >= 1; i--) {
    const t = i / n;
    g.lineTo(-w(t), -t);
  }
}

const LEAF = {
  // English oak: four or five rounded lobes a side, widest beyond the middle.
  oak: (g) => lobed(g, (t) => 0.3 * Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.05)), 0.7) * (0.68 + 0.32 * Math.cos(t * Math.PI * 9)), 30),
  // Hawthorn: small, deeply three-to-five lobed.
  hawthorn: (g) => lobed(g, (t) => 0.44 * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.75)), 0.6) * (0.5 + 0.5 * Math.cos(t * Math.PI * 6.5)), 26),
  // Birch: triangular with a drawn-out tip and a toothed edge.
  birch: (g) => lobed(g, (t) => 0.38 * Math.pow(Math.min(1, t * 3.4), 0.55) * Math.pow(1 - t, 1.05) * (1 + 0.07 * Math.sin(t * 70)), 30),
  // Ash leaflet: narrow and pointed.
  leaflet: (g) => lobed(g, (t) => 0.17 * Math.pow(Math.sin(Math.PI * t), 0.85), 16),
  // Sycamore: five pointed lobes from the stalk.
  palmate: (g) => {
    const n = 70;
    for (let i = 0; i <= n; i++) {
      const th = -Math.PI + (i / n) * TAU;
      const r = 0.52 * (0.42 + 0.58 * Math.pow(Math.abs(Math.cos(2.5 * th)), 0.5)) * (Math.abs(th) > 2.75 ? 0.55 : 1);
      const x = Math.sin(th) * r, y = -0.48 - Math.cos(th) * r;
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
  },
  // Lime: heart-shaped, the two basal lobes reaching back past the stalk.
  heart: (g) => {
    const n = 40;
    for (let i = 0; i <= n; i++) {
      const t = (i / n) * TAU;
      const x = 16 * Math.pow(Math.sin(t), 3), y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
      const X = (x / 22) * 0.62, Y = (y - 5) / 22;
      if (i === 0) g.moveTo(X, Y);
      else g.lineTo(X, Y);
    }
  },
};

const jitter = (hex, r, amount = 0.12, light = 0) => {
  const c = new THREE.Color(hex);
  const k = 1 + (r() - 0.5) * 2 * amount + light;
  c.r = Math.min(1, c.r * k * (1 + (r() - 0.5) * 0.06));
  c.g = Math.min(1, c.g * k);
  c.b = Math.min(1, c.b * k * (1 + (r() - 0.5) * 0.08));
  return `#${c.getHexString()}`;
};

const shadeHex = (hex, k) => {
  const c = new THREE.Color(hex);
  return `#${c.setRGB(Math.min(1, c.r * k), Math.min(1, c.g * k), Math.min(1, c.b * k)).getHexString()}`;
};

function drawLeaf(g, x, y, ang, len, kind, col, r, { width = 1 } = {}) {
  g.save();
  g.translate(x, y);
  g.rotate(ang);
  g.scale(len * width, len);
  g.beginPath();
  LEAF[kind](g);
  g.closePath();
  // Darker at the stalk, lighter towards the tip and one edge, so each leaf reads as curved and lit.
  if (len > 12) {
    const grd = g.createLinearGradient(-0.3, -0.05, 0.3, -0.95);
    grd.addColorStop(0, shadeHex(col, 0.74));
    grd.addColorStop(1, shadeHex(col, 1.1));
    g.fillStyle = grd;
  } else g.fillStyle = col;
  g.fill();
  if (len > 16) {
    g.beginPath();
    g.moveTo(0, -0.04);
    g.lineTo(0, -0.8);
    g.lineWidth = 0.9 / len;
    g.strokeStyle = 'rgba(225,235,190,0.2)';
    g.stroke();
  }
  g.restore();
}

/** A tapered twig as a polyline [x, y, ...] from thick to thin. */
function drawTwig(g, pts, w0, w1, col) {
  g.strokeStyle = col;
  g.lineCap = 'round';
  const n = pts.length / 2;
  for (let i = 0; i < n - 1; i++) {
    g.lineWidth = w0 + (w1 - w0) * (i / Math.max(1, n - 2));
    g.beginPath();
    g.moveTo(pts[i * 2], pts[i * 2 + 1]);
    g.lineTo(pts[i * 2 + 2], pts[i * 2 + 3]);
    g.stroke();
  }
}

/** A curving twig from (x, y) at angle `ang` (0 = up, clockwise positive), `len` px in `n` steps. */
function twigPath(x, y, ang, len, n, bend, r) {
  const pts = [x, y];
  let a = ang;
  for (let i = 0; i < n; i++) {
    a += bend / n + (r() - 0.5) * 0.25;
    x += Math.sin(a) * (len / n);
    y -= Math.cos(a) * (len / n);
    pts.push(x, y);
  }
  return pts;
}

const pointAlong = (pts, t) => {
  const n = pts.length / 2 - 1;
  const f = Math.min(n - 1e-6, Math.max(0, t * n));
  const i = Math.floor(f), k = f - i;
  const x = pts[i * 2] + (pts[i * 2 + 2] - pts[i * 2]) * k, y = pts[i * 2 + 1] + (pts[i * 2 + 3] - pts[i * 2 + 1]) * k;
  const ang = Math.atan2(pts[i * 2 + 2] - pts[i * 2], -(pts[i * 2 + 3] - pts[i * 2 + 1]));
  return [x, y, ang];
};

/**
 * A spray of broad leaves filling a cell of size S at (ox, oy): a main twig rising from the bottom middle,
 * side twigs, and leaves along them. spec: {leaf, len, width, colours, twig, sides, density, droop}.
 */
function broadSpray(g, ox, oy, S, spec, seed) {
  const r = rng(seed);
  const leaves = [];
  const twigs = [];
  const sideCount = spec.sides;
  // A few sprays in each cell, so the card reads as a leafy clump rather than one stalk.
  for (let s = 0; s < spec.stems; s++) {
    const bx = ox + S * (0.5 + (s - (spec.stems - 1) / 2) * 0.16 + (r() - 0.5) * 0.06);
    const main = twigPath(bx, oy + S * 0.985, (s - (spec.stems - 1) / 2) * 0.32 + (r() - 0.5) * 0.25, S * spec.reach * (0.85 + r() * 0.2), 6, (r() - 0.5) * 0.5, r);
    twigs.push([main, 2.6, 1.0]);
    for (let i = 0; i < sideCount; i++) {
      const t = 0.18 + (0.78 * (i + r() * 0.5)) / sideCount;
      const [x, y, a] = pointAlong(main, t);
      const side = i % 2 ? 1 : -1;
      const ang = a + side * (spec.sideAngle + (r() - 0.5) * 0.4) + spec.droop * side;
      const len = S * spec.sideLen * (1.05 - 0.55 * t) * (0.8 + r() * 0.4);
      const tw = twigPath(x, y, ang, len, 4, -side * 0.3 + spec.droop * side * 0.6, r);
      twigs.push([tw, 1.5, 0.6]);
      const n = Math.max(2, Math.round((len / (S * spec.len)) * spec.density));
      for (let k = 0; k < n; k++) {
        const [lx, ly, la] = pointAlong(tw, 0.25 + (0.75 * (k + 0.5)) / n);
        const sd = k % 2 ? 1 : -1;
        leaves.push([lx, ly, la + sd * (0.5 + r() * 0.6)]);
      }
      const [ex, ey, ea] = pointAlong(tw, 1);
      leaves.push([ex, ey, ea + (r() - 0.5) * 0.3]);
    }
    for (let k = 0; k < spec.density; k++) {
      const [lx, ly, la] = pointAlong(main, 0.3 + (0.7 * k) / spec.density);
      leaves.push([lx, ly, la + (k % 2 ? 1 : -1) * (0.45 + r() * 0.5)]);
    }
    const [ex, ey, ea] = pointAlong(main, 1);
    leaves.push([ex, ey, ea]);
  }
  for (const [pts, w0, w1] of twigs) drawTwig(g, pts, w0, w1, spec.twig);
  // Leaves in random order so light and dark ones overlap naturally.
  for (let i = leaves.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [leaves[i], leaves[j]] = [leaves[j], leaves[i]];
  }
  for (const [x, y, a] of leaves) {
    const shade = r();
    const light = shade < 0.2 ? -0.28 : shade > 0.85 ? 0.14 : 0;
    const col = jitter(spec.colours[Math.floor(r() * spec.colours.length)], r, 0.1, light);
    drawLeaf(g, x, y, a, S * spec.len * (0.75 + r() * 0.5), spec.leaf, col, r, { width: spec.width });
  }
}

/** Ash: opposite pinnate leaves of 9–13 narrow leaflets on long stalks; an airy, pale spray. */
function ashSpray(g, ox, oy, S, seed) {
  const r = rng(seed);
  const colours = ['#6f8f3d', '#7d9b47', '#62813a', '#88a650', '#58773a'];
  const leaves = [];
  for (const lean of [-0.28, 0.28]) {
    const main = twigPath(ox + S * (0.5 + lean * 0.3), oy + S * 0.985, lean + (r() - 0.5) * 0.2, S * 0.6, 5, (r() - 0.5) * 0.3, r);
    drawTwig(g, main, 2.6, 1.3, '#6a6656');
    for (let i = 0; i < 4; i++) {
      const [x, y, a] = pointAlong(main, Math.min(1, 0.28 + i * 0.22));
      for (const side of [-1, 1]) leaves.push([x, y, a + side * (0.7 + r() * 0.35) - (i === 3 ? side * 0.35 : 0)]);
    }
    const [ex, ey, ea] = pointAlong(main, 1);
    leaves.push([ex, ey, ea]);
  }
  for (const [x, y, a] of leaves) {
    const L = S * (0.36 + r() * 0.12);
    const rach = twigPath(x, y, a, L, 5, (r() - 0.5) * 0.6, r);
    drawTwig(g, rach, 1.3, 0.6, '#5f6e3a');
    const pairs = 4 + Math.floor(r() * 2);
    for (let k = 0; k < pairs; k++) {
      const [lx, ly, la] = pointAlong(rach, 0.22 + (0.72 * k) / pairs);
      for (const sd of [-1, 1]) {
        const col = jitter(colours[Math.floor(r() * colours.length)], r, 0.1, r() < 0.2 ? -0.25 : 0);
        drawLeaf(g, lx, ly, la + sd * (1.05 + (r() - 0.5) * 0.3), S * 0.085 * (0.85 + r() * 0.3), 'leaflet', col, r);
      }
    }
    const [tx, ty, ta] = pointAlong(rach, 1);
    drawLeaf(g, tx, ty, ta, S * 0.09, 'leaflet', jitter(colours[0], r), r);
  }
}

/** Scots pine: twigs ending in brushes of paired, blue-green needles. */
function pineSpray(g, ox, oy, S, seed) {
  const r = rng(seed);
  const colours = ['#4e6b58', '#5b7a63', '#41604c', '#6a8a70', '#4a6650'];
  const tufts = [];
  const main = twigPath(ox + S * 0.5, oy + S * 0.98, (r() - 0.5) * 0.3, S * 0.6, 5, (r() - 0.5) * 0.5, r);
  drawTwig(g, main, 3.2, 1.8, '#7a5236');
  for (let i = 0; i < 5; i++) {
    const [x, y, a] = pointAlong(main, 0.35 + i * 0.13);
    const side = i % 2 ? 1 : -1;
    const tw = twigPath(x, y, a + side * (0.7 + r() * 0.3), S * (0.24 - i * 0.02), 3, -side * 0.2, r);
    drawTwig(g, tw, 2, 1.2, '#7a5236');
    tufts.push(tw);
  }
  tufts.push(main);
  for (const tw of tufts) {
    for (let k = 0; k < 4; k++) {
      const [x, y, a] = pointAlong(tw, 0.35 + k * 0.21);
      const n = k === 3 ? 34 : 18;
      for (let i = 0; i < n; i++) {
        const ang = a + (r() - 0.5) * (k === 3 ? 2.6 : 2.0);
        const L = S * (0.1 + r() * 0.05);
        g.strokeStyle = jitter(colours[Math.floor(r() * colours.length)], r, 0.12, r() < 0.2 ? -0.25 : 0);
        g.lineWidth = 1.5;
        g.beginPath();
        g.moveTo(x, y);
        g.quadraticCurveTo(x + Math.sin(ang) * L * 0.5 + (r() - 0.5) * 3, y - Math.cos(ang) * L * 0.5, x + Math.sin(ang) * L, y - Math.cos(ang) * L);
        g.stroke();
      }
    }
  }
}

/** Spruce: a flat, feathery spray of short dark needles, paler at the new growth at the tips. */
function spruceSpray(g, ox, oy, S, seed) {
  const r = rng(seed);
  const colours = ['#2c4a2d', '#365837', '#243f27', '#3f6140', '#30502f'];
  const main = twigPath(ox + S * 0.5, oy + S * 0.985, (r() - 0.5) * 0.15, S * 0.9, 6, (r() - 0.5) * 0.25, r);
  const twigs = [main];
  for (let i = 0; i < 9; i++) {
    const t = 0.12 + i * 0.095;
    const [x, y, a] = pointAlong(main, t);
    for (const side of [-1, 1]) {
      const tw = twigPath(x, y, a + side * (0.85 + (r() - 0.5) * 0.2), S * (0.36 - t * 0.26) * (0.85 + r() * 0.3), 4, -side * 0.25, r);
      twigs.push(tw);
      if (i % 2 === 0) {
        const [x2, y2, a2] = pointAlong(tw, 0.5);
        twigs.push(twigPath(x2, y2, a2 + side * 0.7, S * 0.09, 2, 0, r));
      }
    }
  }
  for (const tw of twigs) drawTwig(g, tw, tw === main ? 2.4 : 1.4, 0.8, '#5a4a38');
  for (const tw of twigs) {
    const n = Math.max(6, Math.round(tw.length * 2.2));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      const [x, y, a] = pointAlong(tw, t);
      const tip = t > 0.8 && r() < 0.6;
      for (const sd of [-1, 1]) {
        const ang = a + sd * (0.9 + (r() - 0.5) * 0.5);
        const L = S * (0.028 + r() * 0.012);
        g.strokeStyle = tip ? jitter('#5a7f42', r, 0.1) : jitter(colours[Math.floor(r() * colours.length)], r, 0.12, r() < 0.25 ? -0.25 : 0);
        g.lineWidth = 1.6;
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(x + Math.sin(ang) * L, y - Math.cos(ang) * L);
        g.stroke();
      }
    }
  }
}

/** A tuft of grass blades fanning out from the bottom of the cell; `seeds` adds tall flowering stems. */
function grassTuft(g, ox, oy, S, seed, { seeds = false, colours = ['#5d7d34', '#6e8c3c', '#7f9a45', '#566f30', '#8c9a52', '#a3a265'] } = {}) {
  const r = rng(seed);
  const blades = seeds ? 46 : 64;
  for (let i = 0; i < blades; i++) {
    const bx = ox + S * (0.5 + (r() - 0.5) * 0.5);
    const lean = (bx - (ox + S / 2)) / (S / 2) * 0.6 + (r() - 0.5) * 0.7;
    const L = S * (0.45 + r() * 0.5);
    const w = 2.2 + r() * 2.4;
    const tx = bx + Math.sin(lean) * L, ty = oy + S - Math.cos(lean) * L * 0.95;
    const cx = bx + Math.sin(lean) * L * 0.3, cy = oy + S - L * 0.6;
    g.fillStyle = jitter(colours[Math.floor(r() * colours.length)], r, 0.12, r() < 0.25 ? -0.3 : 0);
    g.beginPath();
    g.moveTo(bx - w / 2, oy + S);
    g.quadraticCurveTo(cx - w / 3, cy, tx, ty);
    g.quadraticCurveTo(cx + w / 3, cy, bx + w / 2, oy + S);
    g.fill();
  }
  if (seeds) {
    for (let i = 0; i < 9; i++) {
      const bx = ox + S * (0.5 + (r() - 0.5) * 0.4), lean = (r() - 0.5) * 0.5;
      const L = S * (0.75 + r() * 0.2);
      const tx = bx + Math.sin(lean) * L, ty = oy + S - Math.cos(lean) * L;
      g.strokeStyle = '#8a8a55';
      g.lineWidth = 1.3;
      g.beginPath();
      g.moveTo(bx, oy + S);
      g.quadraticCurveTo(bx + Math.sin(lean) * L * 0.4, oy + S - L * 0.55, tx, ty);
      g.stroke();
      g.fillStyle = r() < 0.5 ? '#b8a676' : '#9a8a6a';
      g.beginPath();
      g.ellipse(tx, ty + 8, 2.6, 10, lean, 0, TAU);
      g.fill();
    }
  }
}

/** Cow parsley: umbels of tiny white flowers on fine stems over feathery leaves (verges in May and June). */
function cowParsley(g, ox, oy, S, seed) {
  const r = rng(seed);
  grassTuft(g, ox + S * 0.1, oy + S * 0.35, S * 0.8, seed + 1, { colours: ['#4f6e2e', '#5d7c36', '#46632a'] });
  for (let i = 0; i < 6; i++) {
    const bx = ox + S * (0.3 + r() * 0.4), tx = bx + (r() - 0.5) * S * 0.4, ty = oy + S * (0.1 + r() * 0.25);
    g.strokeStyle = '#6b8a45';
    g.lineWidth = 1.6;
    g.beginPath();
    g.moveTo(bx, oy + S);
    g.quadraticCurveTo((bx + tx) / 2, (oy + S + ty) / 2, tx, ty);
    g.stroke();
    for (let k = 0; k < 9; k++) {
      const a = (k / 9) * TAU, rr = S * (0.04 + r() * 0.03);
      const ux = tx + Math.cos(a) * rr, uy = ty - Math.abs(Math.sin(a)) * rr * 0.4;
      g.strokeStyle = '#7d9a55';
      g.lineWidth = 0.8;
      g.beginPath();
      g.moveTo(tx, ty + 4);
      g.lineTo(ux, uy);
      g.stroke();
      g.fillStyle = r() < 0.5 ? '#f4f3e8' : '#e8e9dc';
      g.beginPath();
      g.arc(ux, uy, 2.6 + r() * 1.2, 0, TAU);
      g.fill();
    }
  }
}

// ---- The leaf atlas ------------------------------------------------------------------------------------

const BROAD = {
  oak: { leaf: 'oak', len: 0.12, width: 1, colours: ['#4a682e', '#557539', '#3d5927', '#62803f', '#466431'], twig: '#5b4c3a', stems: 2, reach: 0.78, sides: 6, sideLen: 0.34, sideAngle: 0.9, density: 4, droop: 0 },
  sycamore: { leaf: 'palmate', len: 0.2, width: 1, colours: ['#3e6229', '#4a6f31', '#365622', '#557a39', '#43662c'], twig: '#5d5040', stems: 2, reach: 0.8, sides: 5, sideLen: 0.3, sideAngle: 0.85, density: 2, droop: 0 },
  hawthorn: { leaf: 'hawthorn', len: 0.075, width: 1, colours: ['#3d5f2a', '#476b31', '#34521f', '#517439', '#3a5a28'], twig: '#4f463c', stems: 3, reach: 0.8, sides: 7, sideLen: 0.3, sideAngle: 0.95, density: 6, droop: 0 },
  birch: { leaf: 'birch', len: 0.085, width: 1, colours: ['#7a9a3e', '#87a847', '#6c8c37', '#94b350', '#7f9f42'], twig: '#4a3c30', stems: 3, reach: 0.82, sides: 6, sideLen: 0.32, sideAngle: 0.7, density: 5, droop: 0.35 },
  lime: { leaf: 'heart', len: 0.15, width: 1, colours: ['#56803a', '#648d41', '#4b7233', '#709849', '#5a8540'], twig: '#5a4a3a', stems: 2, reach: 0.8, sides: 6, sideLen: 0.32, sideAngle: 0.9, density: 3, droop: 0.1 },
  hedge: { leaf: 'hawthorn', len: 0.07, width: 1.05, colours: ['#3f612b', '#4a6e32', '#36561f', '#56793c', '#5d7f3e'], twig: '#4f463c', stems: 4, reach: 0.85, sides: 6, sideLen: 0.28, sideAngle: 0.8, density: 6, droop: 0 },
};

/** Cell order in the 4 × 4 leaf atlas. */
export const LEAF_CELLS = ['oak', 'ash', 'sycamore', 'hawthorn', 'birch', 'lime', 'pine', 'spruce', 'hedge', 'grass', 'grassSeed', 'parsley', 'oak2', 'sycamore2', 'hawthorn2', 'lime2'];

/**
 * The leaf atlas: 4 × 4 cells, each a spray of one kind of foliage with alpha. Returns {texture, canvas,
 * size, cellSize, rect(name) → {u0, v0, u1, v1} (UV rect, inset), px(name) → [x, y] (canvas top-left)}.
 */
export function leafAtlas(size = 1024) {
  return once(`leaves-${size}`, () => {
    const [c, g] = canvas2d(size);
    const S = size / 4;
    // Each spray is drawn (at 256 px per cell) on a roomy scratch canvas with its stalk at (384, 636), then
    // scaled down if need be to fit its cell with a margin: no leaf is ever cut off by a straight cell edge.
    const [sc, sg] = canvas2d(768, 640);
    const BX = 384, BY = 636;
    LEAF_CELLS.forEach((name, i) => {
      sg.clearRect(0, 0, 768, 640);
      const base = name.replace(/2$/, '');
      const seed = 100 + i * 17;
      if (BROAD[base]) broadSpray(sg, 256, 384, 256, BROAD[base], seed);
      else if (base === 'ash') ashSpray(sg, 256, 384, 256, seed);
      else if (base === 'pine') pineSpray(sg, 256, 384, 256, seed);
      else if (base === 'spruce') spruceSpray(sg, 256, 384, 256, seed);
      else if (base === 'grass') grassTuft(sg, 256, 384, 256, seed);
      else if (base === 'grassSeed') grassTuft(sg, 256, 384, 256, seed, { seeds: true });
      else if (base === 'parsley') cowParsley(sg, 256, 384, 256, seed);
      // Foliage reads darker than the pasture round it; the textures are drawn a little light.
      const dark = base === 'grass' || base === 'grassSeed' || base === 'parsley' ? 1 : base === 'pine' || base === 'spruce' ? 0.9 : 0.84;
      if (dark < 1) {
        sg.globalCompositeOperation = 'source-atop';
        sg.fillStyle = `rgba(0,0,0,${1 - dark})`;
        sg.fillRect(0, 0, 768, 640);
        sg.globalCompositeOperation = 'source-over';
      }
      const a = sg.getImageData(0, 0, 768, 640).data;
      let minX = 768, maxX = 0, minY = 640, maxY = 0;
      for (let y = 0; y < 640; y += 2) for (let x = 0; x < 768; x += 2) if (a[(y * 768 + x) * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      const m = 5;
      const by = Math.max(BY, maxY);
      const s = Math.min((256 / 2 - m) / Math.max(1, BX - minX, maxX - BX), (256 - 2 * m) / Math.max(1, by - minY), 1) * (S / 256);
      const ox = (i % 4) * S, oy = Math.floor(i / 4) * S;
      g.save();
      g.beginPath();
      g.rect(ox, oy, S, S);
      g.clip();
      g.setTransform(s, 0, 0, s, ox + S / 2 - BX * s, oy + S - m * (S / 256) - by * s);
      g.drawImage(sc, 0, 0);
      g.restore();
    });
    const texture = foliageTexture(c, { threshold: 0.5, grid: [4, 4] });
    const inset = 2 / size;
    const rect = (name) => {
      const i = LEAF_CELLS.indexOf(name);
      const col = i % 4, row = Math.floor(i / 4);
      return { u0: col / 4 + inset, u1: (col + 1) / 4 - inset, v0: 1 - (row + 1) / 4 + inset, v1: 1 - row / 4 - inset };
    };
    const px = (name) => {
      const i = LEAF_CELLS.indexOf(name);
      return [(i % 4) * S, Math.floor(i / 4) * S];
    };
    return { texture, canvas: c, size, cellSize: S, rect, px };
  });
}

// ---- Hedges ------------------------------------------------------------------------------------------

/**
 * Hawthorn hedge textures, tiling along the hedge:
 *  - body: dense small leaves over dark gaps, 2 m × 2 m, opaque, with a normal map for its lumpiness;
 *  - fringe: the same foliage dense at the bottom, breaking up into sprigs and single leaves towards a ragged
 *    top (alpha), 2 m along × 0.6 m, for the fins that soften the hedge's outline.
 */
export function hedgeTextures() {
  return once('hedge', () => {
    const colours = ['#3c5d29', '#466a31', '#34521f', '#527438', '#5a7b3c', '#3f5f2b'];
    const leafAt = (g, x, y, a, len, r, light = 0, H = 0) => {
      const col = jitter(colours[Math.floor(r() * colours.length)], r, 0.12, light);
      // Copies across the edges so the tile wraps (vertically too when H is given).
      const xs = x < 20 ? [x, x + 512] : x > 492 ? [x, x - 512] : [x];
      const ys = !H ? [y] : y < 20 ? [y, y + H] : y > H - 20 ? [y, y - H] : [y];
      for (const px of xs) for (const py of ys) drawLeaf(g, px, py, a, len, 'hawthorn', col, r);
    };
    // Body.
    const [bc, bg] = canvas2d(512, 512);
    bg.fillStyle = '#23321a';
    bg.fillRect(0, 0, 512, 512);
    const rb = rng(71);
    for (let i = 0; i < 4200; i++) {
      const x = rb() * 512, y = rb() * 512;
      const shade = rb();
      // Deeper leaves (drawn first) darker, so the surface reads as layered.
      const light = i < 1500 ? -0.25 : shade < 0.15 ? -0.15 : shade > 0.85 ? 0.14 : 0.04;
      leafAt(bg, x, y, rb() * TAU, 9 + rb() * 7, rb, light, 512);
    }
    // Fringe.
    const [fc, fg] = canvas2d(512, 160);
    const rf = rng(72);
    for (let i = 0; i < 1500; i++) {
      // Dense low down, thinning upwards; sprigs reach the top.
      const y = 160 - Math.pow(rf(), 1.8) * 150;
      const x = rf() * 512;
      leafAt(fg, x, y, (rf() - 0.5) * 2.4, 8 + rf() * 6, rf, y > 110 ? -0.2 : 0);
    }
    for (let i = 0; i < 26; i++) {
      // Sprigs: a thin twig with a few leaves, poking up out of the top.
      const x0 = rf() * 512, len = 40 + rf() * 70;
      const pts = twigPath(x0, 160, (rf() - 0.5) * 0.8, len, 4, (rf() - 0.5) * 0.6, rf);
      for (const ox of [-512, 0, 512]) drawTwig(fg, pts.map((v, k) => (k % 2 ? v : v + ox)), 1.6, 0.7, '#4a4036');
      for (let k = 0; k < 7; k++) {
        const [lx, ly, la] = pointAlong(pts, 0.3 + k * 0.1);
        leafAt(fg, lx, ly, la + (k % 2 ? 1 : -1) * (0.6 + rf() * 0.5), 8 + rf() * 5, rf);
      }
    }
    // The fringe faces the sky more than the body does: drawn darker so the two match once lit.
    fg.globalCompositeOperation = 'source-atop';
    fg.fillStyle = 'rgba(0,0,0,0.3)';
    fg.fillRect(0, 0, 512, 160);
    fg.globalCompositeOperation = 'source-over';
    const body = foliageTexture(bc, { threshold: 0, wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping });
    const bodyNormal = normalMapFrom(bc, { strength: 3 });
    const fringe = foliageTexture(fc, { threshold: 0.5, wrapS: THREE.RepeatWrapping });
    return { body, bodyNormal, fringe };
  });
}

// ---- The bark atlas ------------------------------------------------------------------------------------

export const BARK_COLUMNS = ['oak', 'ash', 'sycamore', 'hawthorn', 'birch', 'lime', 'pine', 'spruce'];
/** Average bark colour of each species (for the impostors' branches). */
export const BARK_MEAN = { oak: '#4f483e', ash: '#6f6e66', sycamore: '#706a60', hawthorn: '#5a5248', birch: '#cfcdc4', lime: '#5c564c', pine: '#94593a', spruce: '#5a5046' };

/** Value noise that tiles with period (px, py) lattice cells. */
function tnoise(x, y, px, py, seed) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const x0 = ((xi % px) + px) % px, x1 = (x0 + 1) % px, y0 = ((yi % py) + py) % py, y1 = (y0 + 1) % py;
  const a = hash2(x0, y0, seed), b = hash2(x1, y0, seed), c = hash2(x0, y1, seed), d = hash2(x1, y1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
/** Tiling fractal noise over u, v in [0, 1) with fx × fy cells in its first octave. */
function tfbm(u, v, fx, fy, oct, seed) {
  let s = 0, n = 0, amp = 0.5, f = 1;
  for (let o = 0; o < oct; o++) {
    s += amp * tnoise(u * fx * f, v * fy * f, fx * f, fy * f, seed + o * 31);
    n += amp;
    amp *= 0.5;
    f *= 2;
  }
  return s / n;
}
const sstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const mixRGB = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const rgb = (hex) => {
  const c = new THREE.Color(hex);
  return [c.r * 255, c.g * 255, c.b * 255];
};

/**
 * One species' bark as colour per (u round the trunk, v along it), both in [0, 1) and tiling. Returns
 * [r, g, b] (0–255). Drawn at half resolution and smoothed up.
 */
const BARK = {
  // English oak: deep fissures between long, rough, grey-brown ridges, with lichen.
  oak(u, v) {
    const n = tfbm(u, v, 7, 3, 3, 11) + 0.18 * tfbm(u, v, 22, 9, 2, 12);
    const ridge = sstep(0.43, 0.6, n);
    const tone = 0.85 + 0.3 * tfbm(u, v, 14, 8, 2, 13);
    let c = mixRGB(rgb('#1a1612'), rgb('#62594c'), ridge).map((x) => x * tone);
    const lichen = sstep(0.68, 0.76, tfbm(u, v, 10, 7, 3, 14)) * ridge;
    return mixRGB(c, rgb('#8c977a'), lichen * 0.55);
  },
  // Ash: pale grey with a net of interlacing shallow fissures.
  ash(u, v) {
    const w = 0.35 * tfbm(u, v, 6, 4, 2, 21);
    const d1 = Math.abs(((u * 6 + v * 5 + w) % 1) - 0.5), d2 = Math.abs(((u * 6 - v * 5 + w + 10) % 1) - 0.5);
    const crack = 1 - sstep(0.03, 0.1, Math.min(d1, d2));
    const tone = 0.88 + 0.24 * tfbm(u, v, 12, 10, 2, 22);
    return mixRGB(rgb('#6f6e66'), rgb('#2c2b27'), crack * 0.85).map((x) => x * tone);
  },
  // Sycamore: smooth grey-pink, flaking in small plates that show orange-brown beneath.
  sycamore(u, v) {
    const p = tfbm(u, v, 9, 7, 3, 31);
    const plate = sstep(0.58, 0.62, p), edge = sstep(0.55, 0.585, p) - plate;
    const tone = 0.9 + 0.2 * tfbm(u, v, 18, 12, 2, 32);
    let c = mixRGB(rgb('#7a7067'), rgb('#9a7f62'), plate * 0.8);
    c = mixRGB(c, rgb('#2e2924'), Math.max(0, edge) * 0.9);
    return c.map((x) => x * tone);
  },
  // Hawthorn: grey-brown, fluted and finely cracked.
  hawthorn(u, v) {
    const flute = 0.5 + 0.5 * Math.sin((u * 7 + 0.4 * tfbm(u, v, 4, 3, 2, 41)) * Math.PI * 2);
    const crack = sstep(0.62, 0.7, tfbm(u, v, 16, 10, 2, 42));
    return mixRGB(mixRGB(rgb('#3c362f'), rgb('#6a6155'), flute), rgb('#211d19'), crack * 0.8);
  },
  // Silver birch: white and papery, dark horizontal lenticels, and black fissured patches.
  birch(u, v) {
    const len = sstep(0.62, 0.7, tfbm(u, v, 3, 44, 2, 51)) * sstep(0.45, 0.55, tfbm(u, v, 8, 6, 2, 52));
    const black = sstep(0.7, 0.78, tfbm(u, v, 5, 4, 3, 53));
    const tone = 0.9 + 0.12 * tfbm(u, v, 10, 8, 2, 54);
    let c = mixRGB(rgb('#ddd9cf'), rgb('#cfc4b6'), tfbm(u, v, 6, 5, 2, 55) * 0.6).map((x) => x * tone);
    c = mixRGB(c, rgb('#2a2622'), len * 0.9);
    return mixRGB(c, rgb('#1f1c19'), black);
  },
  // Lime: grey-brown with a fine network of shallow ridges.
  lime(u, v) {
    const n = tfbm(u, v, 12, 4, 3, 61);
    const ridge = sstep(0.42, 0.58, n);
    return mixRGB(rgb('#24201b'), rgb('#5e574c'), ridge).map((x) => x * (0.88 + 0.24 * tfbm(u, v, 20, 9, 2, 62)));
  },
  // Scots pine (upper trunk): thin papery plates in orange and red-brown with dark seams.
  pine(u, v) {
    const p = tfbm(u, v, 10, 9, 3, 71);
    const seam = 1 - sstep(0.015, 0.05, Math.abs(p - 0.5));
    const tone = tfbm(u, v, 14, 12, 2, 72);
    const c = mixRGB(rgb('#8f4728'), rgb('#c2703f'), tone);
    return mixRGB(c, rgb('#3a2014'), seam * 0.85);
  },
  // Spruce: grey-brown with small round scales.
  spruce(u, v) {
    const s = tfbm(u, v, 24, 30, 2, 81);
    const scale = sstep(0.5, 0.62, s);
    return mixRGB(rgb('#2b251f'), rgb('#62574b'), scale).map((x) => x * (0.9 + 0.2 * tfbm(u, v, 8, 10, 2, 82)));
  },
};

/** Bark strips, one column per species: U round the trunk, V along it (repeat 4 × the circumference). */
export function barkAtlas() {
  return once('bark', () => {
    const W = 128, H = 512, w = 64, h = 256;
    const [c, g] = canvas2d(W * BARK_COLUMNS.length, H);
    BARK_COLUMNS.forEach((kind, i) => {
      // Bark is dark: under the game's bright sky light it is drawn darker than it looks on paper.
      const dark = kind === 'birch' ? 0.85 : 0.74;
      // Computed at half resolution, then scaled up bilinearly with wrap-around so the strip tiles both ways.
      const half = new Float32Array(w * h * 3);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const col = BARK[kind](x / w, y / h);
          half.set([col[0] * dark, col[1] * dark, col[2] * dark], (y * w + x) * 3);
        }
      }
      const img = g.createImageData(W, H);
      for (let y = 0; y < H; y++) {
        const fy = (y + 0.5) / 2 - 0.5, y0 = Math.floor(fy), ty = fy - y0;
        const ya = ((y0 % h) + h) % h, yb = (ya + 1) % h;
        for (let x = 0; x < W; x++) {
          const fx = (x + 0.5) / 2 - 0.5, x0 = Math.floor(fx), tx = fx - x0;
          const xa = ((x0 % w) + w) % w, xb = (xa + 1) % w;
          const o = (y * W + x) * 4;
          for (let k = 0; k < 3; k++) {
            const top = half[(ya * w + xa) * 3 + k] * (1 - tx) + half[(ya * w + xb) * 3 + k] * tx;
            const bot = half[(yb * w + xa) * 3 + k] * (1 - tx) + half[(yb * w + xb) * 3 + k] * tx;
            img.data[o + k] = top * (1 - ty) + bot * ty;
          }
          img.data[o + 3] = 255;
        }
      }
      g.putImageData(img, i * W, 0);
    });
    const map = foliageTexture(c, { threshold: 0, wrapT: THREE.RepeatWrapping });
    const normalMap = normalMapFrom(c, { strength: 4.5, columns: BARK_COLUMNS.length });
    const column = (kind) => {
      const i = BARK_COLUMNS.indexOf(kind);
      return { u0: (i + 0.02) / BARK_COLUMNS.length, u1: (i + 0.98) / BARK_COLUMNS.length };
    };
    return { map, normalMap, column };
  });
}

// ---- Impostor atlas ----------------------------------------------------------------------------------

/**
 * Paints far-tree impostors. items: [{cards: [{tl, tr, bl, z, shade, cell}], branches: [{pts: [[x,y,z]...],
 * rad: [...], shade}], bark (CSS colour), crown: {cx, cy, rx, ry}, halfW, yMin, yMax}] in metres, viewed from
 * +z. Returns {map, normalMap, cells: [{u0, v0, u1, v1, w, h, y0}]} where w × h metres is the quad size and y0
 * its bottom.
 */
export function impostorAtlas(items, atlas, { cell = 256 } = {}) {
  const cols = 8, rows = Math.ceil(items.length / cols);
  const W = cols * cell, H = Math.max(1, rows) * cell;
  const [c, g] = canvas2d(W, H);
  // Leaf cells pre-shaded at a few brightnesses (multiply, keeping alpha).
  const LEVELS = 8;
  const shaded = new Map();
  const S = atlas.cellSize;
  const shadedCell = (name) => {
    if (shaded.has(name)) return shaded.get(name);
    const [sc, sg] = canvas2d(S * LEVELS, S);
    const [x0, y0] = atlas.px(name);
    for (let l = 0; l < LEVELS; l++) {
      const k = 0.3 + (0.75 * l) / (LEVELS - 1);
      sg.globalCompositeOperation = 'source-over';
      sg.drawImage(atlas.canvas, x0, y0, S, S, l * S, 0, S, S);
      // Darken (or lighten) the leaves without touching their alpha.
      sg.globalCompositeOperation = 'source-atop';
      sg.fillStyle = k < 1 ? `rgba(0,0,0,${1 - k})` : `rgba(255,255,255,${(k - 1) * 0.6})`;
      sg.fillRect(l * S, 0, S, S);
    }
    sg.globalCompositeOperation = 'source-over';
    shaded.set(name, sc);
    return sc;
  };
  const cells = [];
  const margin = 4;
  items.forEach((it, idx) => {
    const ox = (idx % cols) * cell, oy = Math.floor(idx / cols) * cell;
    const span = Math.max(2 * it.halfW, it.yMax - it.yMin);
    const s = (cell - 2 * margin) / span;
    const px = (x) => ox + cell / 2 + x * s;
    const py = (y) => oy + cell - margin - (y - it.yMin) * s;
    g.save();
    g.beginPath();
    g.rect(ox, oy, cell, cell);
    g.clip();
    // Trunk and limbs first: they show below the crown and through its gaps.
    g.lineCap = 'round';
    g.lineJoin = 'round';
    for (const b of it.branches) {
      const col = new THREE.Color(it.bark).multiplyScalar(b.shade ?? 0.8);
      g.strokeStyle = `#${col.getHexString()}`;
      for (let i = 0; i < b.pts.length - 1; i++) {
        g.lineWidth = Math.max(0.8, (b.rad[i] + b.rad[i + 1]) * s);
        g.beginPath();
        g.moveTo(px(b.pts[i][0]), py(b.pts[i][1]));
        g.lineTo(px(b.pts[i + 1][0]), py(b.pts[i + 1][1]));
        g.stroke();
      }
    }
    const cards = it.cards.slice().sort((a, b) => a.z - b.z);
    for (const cd of cards) {
      const src = shadedCell(cd.cell);
      const l = Math.max(0, Math.min(LEVELS - 1, Math.round(((cd.shade - 0.3) / 0.75) * (LEVELS - 1))));
      const TL = [px(cd.tl[0]), py(cd.tl[1])], TR = [px(cd.tr[0]), py(cd.tr[1])], BL = [px(cd.bl[0]), py(cd.bl[1])];
      g.setTransform((TR[0] - TL[0]) / S, (TR[1] - TL[1]) / S, (BL[0] - TL[0]) / S, (BL[1] - TL[1]) / S, TL[0], TL[1]);
      g.drawImage(src, l * S, 0, S, S, 0, 0, S, S);
      g.setTransform(1, 0, 0, 1, 0, 0);
    }
    g.restore();
    const u0 = ox / W, u1 = (ox + cell) / W;
    const v1 = 1 - oy / H, v0 = 1 - (oy + cell) / H;
    cells.push({ u0, u1, v0, v1, w: cell / s, h: cell / s, y0: it.yMin - margin / s, crown: { x: px(it.crown.cx), y: py(it.crown.cy), rx: it.crown.rx * s, ry: it.crown.ry * s }, ox, oy });
  });
  // Normal map: a fitted ellipsoid per crown with leafy relief from the painted luminance.
  const px = texels(c);
  const nrm = new Uint8Array(W * H * 4);
  const lum = (x, y) => {
    // texels are flipped: canvas row y is texel row H-1-y.
    const o = ((H - 1 - y) * W + x) * 4;
    return px[o + 3] < 30 ? 0 : (px[o] + px[o + 1] + px[o + 2]) / 765;
  };
  for (const cl of cells) {
    for (let y = cl.oy; y < cl.oy + cell; y++) {
      for (let x = cl.ox; x < cl.ox + cell; x++) {
        const o = ((H - 1 - y) * W + x) * 4;
        let nx = 0, ny = 0, nz = 1;
        if (px[o + 3] > 0) {
          const dx = (x - cl.crown.x) / Math.max(1, cl.crown.rx), dy = (cl.crown.y - y) / Math.max(1, cl.crown.ry);
          const d2 = dx * dx + dy * dy;
          if (d2 < 1) {
            nx = dx;
            ny = dy;
            nz = Math.sqrt(1 - d2);
          } else {
            const d = Math.sqrt(d2);
            nx = dx / d;
            ny = dy / d;
            nz = 0.15;
          }
          nx *= 0.8;
          ny *= 0.8;
          nz += 0.35;
          // Leaf-clump relief from the painted brightness.
          if (x > cl.ox && x < cl.ox + cell - 1 && y > cl.oy && y < cl.oy + cell - 1) {
            nx += (lum(x - 1, y) - lum(x + 1, y)) * 1.2;
            ny += (lum(x, y + 1) - lum(x, y - 1)) * 1.2;
          }
          const l = Math.hypot(nx, ny, nz);
          nx /= l;
          ny /= l;
          nz /= l;
        }
        nrm[o] = Math.round((nx * 0.5 + 0.5) * 255);
        nrm[o + 1] = Math.round((ny * 0.5 + 0.5) * 255);
        nrm[o + 2] = Math.round((nz * 0.5 + 0.5) * 255);
        nrm[o + 3] = 255;
      }
    }
  }
  fillTransparent(px, W, H);
  const map = dataTexture(mipChain(px, W, H, { threshold: 0.5, grid: [cols, Math.max(1, rows)] }));
  const normalMap = dataTexture(mipChain(nrm, W, H), { srgb: false });
  return { map, normalMap, cells };
}
