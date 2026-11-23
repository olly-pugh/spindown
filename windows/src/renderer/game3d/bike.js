// An aero carbon road bike, built from the shared fit (people/fit.js): truncated-aerofoil tubes swept along the
// frame and flared into their junctions, dropped seat stays, an integrated bar and stem, shaped hoods and saddle,
// deep carbon rims with decals, bladed spokes, disc brakes and a full drivetrain.
//
// Everything is merged into one geometry per bike with vertex colours, a per-vertex surface (roughness,
// metalness) and UVs into a small decal atlas, so a bike is one draw call. Parts carry the bone they move with
// (frame, rear wheel, front wheel, cranks).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import * as FIT from './people/fit.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const A = (a) => V(a[0], a[1], a[2]);

// Surfaces: [roughness, metalness].
const PAINT = [0.24, 0.0], CARBON = [0.3, 0.05], RUBBER = [0.85, 0.0], METAL = [0.32, 0.85], SATIN = [0.5, 0.0], ALLOY = [0.38, 0.7];

/** Decal atlas: frame logo, rim decals and tyre sidewall text, drawn once. UV (0.98, 0.98) is plain white. */
let atlas = null;
export function bikeAtlas() {
  if (atlas) return atlas;
  const W = 1024, H = 512;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, W, H);
  // Row 0 (0-128): down tube logo, dark text on white (multiplied by the paint) with a pinstripe.
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, W, 128);
  g.font = 'italic 900 86px "Segoe UI", Arial, sans-serif';
  g.textBaseline = 'middle';
  g.fillStyle = '#111111';
  g.fillText('SPINDOWN', 150, 66);
  // Row 1 (128-256): the same in white-on-paint is not possible with multiply; use light grey text for dark frames.
  g.fillStyle = '#ffffff';
  g.fillRect(0, 128, W, 128);
  g.fillStyle = '#d9d9d9';
  g.fillText('SPINDOWN', 150, 194);
  // Row 2 (256-384): rim decal: white text on black, repeated.
  g.fillStyle = '#141414';
  g.fillRect(0, 256, W, 128);
  g.fillStyle = '#f2f2f2';
  g.font = '900 78px "Segoe UI", Arial, sans-serif';
  for (const x of [20, 532]) g.fillText('SPINDOWN', x, 322);
  g.font = '700 22px "Segoe UI", Arial, sans-serif';
  for (const x of [400, 912]) g.fillText('CARBON 50', x, 324);
  // Row 3 (384-448): tyre sidewall: dark rubber with a tan stripe and small text.
  g.fillStyle = '#151515';
  g.fillRect(0, 384, W, 64);
  g.fillStyle = '#3a3a3a';
  g.font = '700 26px "Segoe UI", Arial, sans-serif';
  for (const x of [60, 572]) g.fillText('ROAD PRO 25', x, 418);
  // Row 4 (448-512): chain links (dark/light dashes) and a carbon weave strip.
  for (let x = 0; x < W; x += 16) {
    g.fillStyle = '#6d6f72';
    g.fillRect(x, 448, 10, 32);
    g.fillStyle = '#2a2b2d';
    g.fillRect(x + 10, 448, 6, 32);
  }
  for (let y = 480; y < 512; y += 4) for (let x = 0; x < W; x += 4) {
    g.fillStyle = ((x + y) / 4) % 2 ? '#e8e8e8' : '#ffffff';
    g.fillRect(x, y, 4, 4);
  }
  // Top-right corner stays pure white (default UV).
  g.fillStyle = '#ffffff';
  g.fillRect(W - 24, 0, 24, 24);
  atlas = new THREE.CanvasTexture(c);
  atlas.colorSpace = THREE.SRGBColorSpace;
  atlas.anisotropy = 8;
  atlas.flipY = false;
  return atlas;
}
const UV_WHITE = [0.99, 0.02];

/** Finishes a geometry: one colour, surface and bone for every vertex; keeps or fills UVs. */
function part(geo, colour, surf, bone, uvFill = UV_WHITE) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
  if (!g.attributes.normal) g.computeVertexNormals();
  const n = g.attributes.position.count;
  if (!g.attributes.uv || uvFill !== 'keep') {
    const uv = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) { uv[i * 2] = UV_WHITE[0]; uv[i * 2 + 1] = UV_WHITE[1]; }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  }
  const col = new Float32Array(n * 3), sf = new Float32Array(n * 2), si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
  const c = new THREE.Color(colour);
  for (let i = 0; i < n; i++) {
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    sf[i * 2] = surf[0]; sf[i * 2 + 1] = surf[1];
    si[i * 4] = bone;
    sw[i * 4] = 1;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('surf', new THREE.BufferAttribute(sf, 2));
  g.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
  g.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
  return g;
}

/**
 * A tube swept along points with an aero cross-section. prof(t) -> [halfWidth, halfDepth, tail] where tail is
 * how blunt the trailing edge is (1 = round, 0.4 = Kamm-tail). The leading edge faces `lead` (default forward,
 * -z). uvRow: [v0, v1] maps the tube's length onto a decal row (u along the length, v round the section).
 */
function aeroTube(pts, prof, { rings = 18, radial = 14, lead = V(0, 0, -1), uv = null, closed = true } = {}) {
  const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
  const pos = [], uvs = [], idx = [], centres = [];
  const p = V(0, 0, 0), t = V(0, 0, 0), side = V(0, 0, 0), dep = V(0, 0, 0);
  // Section outline in [-1,1]^2: a rounded leading edge tapering to a truncated tail (depth axis +1 = trailing).
  const outline = (k, tail) => {
    const a = (k / radial) * Math.PI * 2;
    const x = Math.cos(a), y = Math.sin(a);
    const w = y < 0 ? 1 : 1 - (1 - tail) * y * y;
    return [x * w, y, x];
  };
  for (let r = 0; r <= rings; r++) {
    const u = r / rings;
    curve.getPointAt(u, p);
    curve.getTangentAt(u, t);
    side.set(1, 0, 0).addScaledVector(t, -t.x);
    if (side.lengthSq() < 1e-6) side.set(0, 0, 1);
    side.normalize();
    dep.crossVectors(t, side).normalize();
    if (dep.dot(lead) > 0) dep.negate();
    const [hw, hd, tail] = prof(u);
    centres.push(p.clone());
    for (let k = 0; k <= radial; k++) {
      const [ox, oy, sx] = outline(k % radial, tail);
      pos.push(p.x + side.x * ox * hw + dep.x * oy * hd, p.y + side.y * ox * hw + dep.y * oy * hd, p.z + side.z * ox * hw + dep.z * oy * hd);
      const q = uv ? uv(u, sx, oy) : UV_WHITE;
      uvs.push(q[0], q[1]);
    }
  }
  const row = radial + 1;
  for (let r = 0; r < rings; r++) for (let k = 0; k < radial; k++) {
    const a = r * row + k, b = a + 1, c = a + row, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  // Seams: duplicate first/last column share positions; weld their normals by computing on a welded copy.
  g.computeVertexNormals();
  const na = g.attributes.normal;
  for (let r = 0; r <= rings; r++) {
    const a = r * row, b = a + radial;
    const nx = na.getX(a) + na.getX(b), ny = na.getY(a) + na.getY(b), nz = na.getZ(a) + na.getZ(b);
    const l = Math.hypot(nx, ny, nz) || 1;
    na.setXYZ(a, nx / l, ny / l, nz / l);
    na.setXYZ(b, nx / l, ny / l, nz / l);
  }
  // Inside out? Normals should point away from the axis.
  let out = 0;
  for (let r = 0; r <= rings; r++) for (let k = 0; k < radial; k++) {
    const i = r * row + k, c = centres[r];
    out += (pos[i * 3] - c.x) * na.getX(i) + (pos[i * 3 + 1] - c.y) * na.getY(i) + (pos[i * 3 + 2] - c.z) * na.getZ(i);
  }
  if (out < 0) {
    const ix = g.index.array;
    for (let i = 0; i < ix.length; i += 3) [ix[i + 1], ix[i + 2]] = [ix[i + 2], ix[i + 1]];
    for (let i = 0; i < na.count; i++) na.setXYZ(i, -na.getX(i), -na.getY(i), -na.getZ(i));
  }
  const pieces = [g.toNonIndexed()];
  if (closed) {
    for (const end of [0, rings]) {
      const c = centres[end];
      const tan = end === 0 ? centres[0].clone().sub(centres[1]).normalize() : centres[rings].clone().sub(centres[rings - 1]).normalize();
      const cp = [], cn = [], cu = [];
      for (let k = 0; k < radial; k++) {
        const i0 = end * row + k, i1 = end * row + k + 1;
        let tri = [[c.x, c.y, c.z], [pos[i0 * 3], pos[i0 * 3 + 1], pos[i0 * 3 + 2]], [pos[i1 * 3], pos[i1 * 3 + 1], pos[i1 * 3 + 2]]];
        const e1 = V(tri[1][0] - tri[0][0], tri[1][1] - tri[0][1], tri[1][2] - tri[0][2]), e2 = V(tri[2][0] - tri[0][0], tri[2][1] - tri[0][1], tri[2][2] - tri[0][2]);
        if (e1.cross(e2).dot(tan) < 0) tri = [tri[0], tri[2], tri[1]];
        for (const q of tri) { cp.push(...q); cn.push(tan.x, tan.y, tan.z); cu.push(UV_WHITE[0], UV_WHITE[1]); }
      }
      const cg = new THREE.BufferGeometry();
      cg.setAttribute('position', new THREE.Float32BufferAttribute(cp, 3));
      cg.setAttribute('normal', new THREE.Float32BufferAttribute(cn, 3));
      cg.setAttribute('uv', new THREE.Float32BufferAttribute(cu, 2));
      pieces.push(cg);
    }
  }
  return pieces.length > 1 ? mergeGeometries(pieces, false) : pieces[0];
}

/** Makes a closed blob's triangles face away from its centre (spheres and lathes built inside out). */
function fixWinding(g) {
  return g;
}

/** Round tube through points (radius may vary along it). */
function roundTube(pts, r, { rings = 12, radial = 8 } = {}) {
  return aeroTube(pts, (u) => {
    const rr = typeof r === 'function' ? r(u) : r;
    return [rr, rr, 1];
  }, { rings, radial });
}

/** A solid of revolution about the x axis (wheel parts): profile [[radius, x], ...]. */
function lathe(profile, segments = 48, uvRow = null) {
  const g = new THREE.LatheGeometry(profile.map(([r, x]) => new THREE.Vector2(r, x)), segments);
  // Lathe revolves about y: turn it so it revolves about x.
  g.rotateZ(-Math.PI / 2);
  if (uvRow) {
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) {
      const v = uv.getY(i);
      uv.setXY(i, (uv.getX(i) * 2) % 1.0001, uvRow[0] + (uvRow[1] - uvRow[0]) * v);
    }
  }
  return g;
}

/** Rim decal UVs: round the rim (two repeats) and down the sidewall, not mirrored on either side. */
function rimUV(g, rOut, rIn, row) {
  const p = g.attributes.position, uv = g.attributes.uv;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const r = Math.hypot(y, z), a = Math.atan2(z, y);
    const side = x >= 0 ? 1 : -1;
    const u = (((side * a) / Math.PI) % 1 + 1) % 1;
    const v = Math.max(0, Math.min(1, (rOut - 0.002 - r) / (rOut - rIn - 0.004)));
    uv.setXY(i, 0.01 + u * 0.98, row[0] + (row[1] - row[0]) * (0.08 + 0.84 * v));
  }
  return g;
}

const boxAt = (w, h, d, at, rx = 0, ry = 0, rz = 0) => {
  const g = new THREE.BoxGeometry(w, h, d);
  g.rotateX(rx); g.rotateY(ry); g.rotateZ(rz);
  return g.translate(at.x, at.y, at.z);
};

/**
 * Builds the bike. kit: {bike: {color}, wheels: {id, depth}}. bones: {frame, rear, front, crank}. detail: 'near'|'far'.
 * Returns a BufferGeometry with position, normal, uv, color, surf, skinIndex, skinWeight.
 */
export function buildBike(kit, bones, detail = 'near') {
  const near = detail === 'near';
  const R = near ? 1 : 0.5; // radial/ring density
  const parts = [];
  const add = (g, colour, surf, bone = bones.frame, uv) => parts.push(part(g, colour, surf, bone, uv));
  const frameCol = new THREE.Color(kit.bike.color);
  const lum = frameCol.r * 0.3 + frameCol.g * 0.59 + frameCol.b * 0.11;
  const paint = kit.bike.color;
  const dark = '#141518', carbon = '#1b1c1f', rubber = '#141414', alloy = '#b9bcc0', black = '#0d0d0e';
  const BB = A(FIT.BB), REAR = A(FIT.REAR), FRONT = A(FIT.FRONT), SADDLE = A(FIT.SADDLE), HOOD = A(FIT.HOOD);
  const RAD = Math.round(14 * R), RINGS = Math.round(16 * R);

  // ---- Key frame points ----
  const htTop = V(0, 0.872, -0.414), htBot = V(0, 0.715, -0.462);
  const seatDir = V(0, Math.sin(THREE.MathUtils.degToRad(73.5)), Math.cos(THREE.MathUtils.degToRad(73.5)));
  const onSeat = (y) => BB.clone().addScaledVector(seatDir, (y - BB.y) / seatDir.y);
  const cluster = onSeat(0.8), stayTop = onSeat(0.69);
  const dropR = REAR.clone().add(V(0.064, 0, 0)), dropL = REAR.clone().add(V(-0.064, 0, 0));
  const forkR = FRONT.clone().add(V(0.052, 0, 0)), forkL = FRONT.clone().add(V(-0.052, 0, 0));
  // Decal rows in the atlas: v ranges (flipY false: v = y / H).
  const logoRow = lum > 0.55 ? [0.0, 0.25] : [0.25, 0.5];

  // ---- Frame tubes ----
  // Head tube: tall, deeper at the bottom (tapered steerer), aero section.
  add(aeroTube([htBot.clone().add(V(0, -0.02, -0.006)), htBot.clone().lerp(htTop, 0.5), htTop.clone().add(V(0, 0.012, 0.004))], (u) => [0.025 - 0.004 * u, 0.041 - 0.007 * u, 0.5], { rings: 6, radial: RAD }), paint, PAINT);
  // Down tube: deep aerofoil, flaring into the head tube and the bottom bracket. Logo along its side.
  add(aeroTube([htBot.clone().add(V(0, 0.01, 0.01)), htBot.clone().lerp(BB, 0.35).add(V(0, 0, 0.004)), htBot.clone().lerp(BB, 0.7), BB.clone().add(V(0, 0.035, -0.035))],
    (u) => [0.0225 + 0.008 * Math.max(0, (u - 0.75) * 4) + 0.006 * Math.max(0, (0.15 - u) * 6.7), 0.035 + 0.006 * Math.max(0, (u - 0.8) * 5) + 0.004 * Math.max(0, (0.2 - u) * 5), 0.4],
    { rings: RINGS, radial: RAD, lead: V(0, 0.3, -1).normalize(), uv: (u, x, y) => [x > 0 ? 0.92 - 0.88 * u : 0.04 + 0.88 * u, logoRow[0] + (logoRow[1] - logoRow[0]) * (0.5 - 0.42 * y)] }), paint, PAINT, bones.frame, 'keep');
  // Top tube: slopes down to the seat cluster, flattened, wider at the head tube.
  add(aeroTube([htTop.clone().add(V(0, -0.022, 0.012)), htTop.clone().lerp(cluster, 0.5).add(V(0, 0.004, 0)), cluster.clone().add(V(0, 0.004, -0.01))],
    (u) => [0.02 - 0.004 * u, 0.0205 - 0.003 * u, 0.75], { rings: Math.round(10 * R), radial: RAD, lead: V(0, 1, 0) }), paint, PAINT);
  // Seat tube: aero, curving round the rear wheel near the bottom bracket.
  const stMid = onSeat(0.45).add(V(0, 0, 0.012));
  add(aeroTube([BB.clone().add(V(0, 0.02, 0.012)), stMid, onSeat(0.62), cluster.clone().add(V(0, 0.02, 0))], (u) => [0.019, 0.031 - 0.007 * u, 0.45], { rings: Math.round(12 * R), radial: RAD }), paint, PAINT);
  // Bottom bracket shell.
  add(new THREE.CylinderGeometry(0.03, 0.03, 0.086, Math.round(16 * R)).rotateZ(Math.PI / 2).translate(BB.x, BB.y, BB.z), paint, PAINT);
  add(new THREE.SphereGeometry(0.036, Math.round(12 * R), Math.round(8 * R)).scale(1.05, 1.0, 1.15).translate(BB.x, BB.y + 0.012, BB.z - 0.01), paint, PAINT);
  for (const s of [-1, 1]) {
    // Chain stays: deep at the bottom bracket, tapering to the dropout.
    const dr = s > 0 ? dropR : dropL;
    add(aeroTube([BB.clone().add(V(0.038 * s, -0.004, 0.025)), BB.clone().lerp(dr, 0.5).add(V(0.018 * s, -0.008, 0)), dr.clone().add(V(0, 0.004, -0.012))],
      (u) => [0.011 - 0.003 * u, 0.019 - 0.008 * u, 0.7], { rings: Math.round(10 * R), radial: Math.round(10 * R), lead: V(0, 1, 0) }), paint, PAINT);
    // Dropped seat stays: thin aero, meeting the seat tube below the top tube.
    add(aeroTube([stayTop.clone().add(V(0.016 * s, 0.0, 0.006)), stayTop.clone().lerp(dr, 0.45).add(V(0.034 * s, 0, 0)), dr.clone().add(V(0, 0.014, 0.0))],
      (u) => [0.0085, 0.013 - 0.003 * u, 0.6], { rings: Math.round(10 * R), radial: Math.round(10 * R) }), paint, PAINT);
    // Dropout.
    add(boxAt(0.008, 0.036, 0.034, dr.clone().add(V(0, 0.006, 0))), paint, PAINT);
    // Fork blades: wide fore-aft, from the crown to the axle.
    const fk = s > 0 ? forkR : forkL;
    add(aeroTube([htBot.clone().add(V(0.034 * s, -0.03, -0.004)), htBot.clone().lerp(fk, 0.5).add(V(0.008 * s, 0, -0.008)), fk.clone().add(V(0, 0.012, 0.004))],
      (u) => [0.011 - 0.002 * u, 0.027 - 0.01 * u, 0.45], { rings: Math.round(10 * R), radial: Math.round(10 * R) }), paint, PAINT);
  }
  // Fork crown, integrated with the head tube.
  add(new THREE.SphereGeometry(0.04, Math.round(14 * R), Math.round(8 * R)).scale(1.15, 0.55, 0.95).translate(htBot.x, htBot.y - 0.03, htBot.z - 0.002), paint, PAINT);
  // Seat cluster blend.
  add(new THREE.SphereGeometry(0.027, Math.round(12 * R), Math.round(8 * R)).scale(1, 1.3, 1.25).translate(cluster.x, cluster.y, cluster.z), paint, PAINT);
  add(new THREE.SphereGeometry(0.02, Math.round(10 * R), Math.round(6 * R)).scale(1.4, 1, 1.2).translate(stayTop.x, stayTop.y, stayTop.z + 0.004), paint, PAINT);
  // Seat post: aero (D-shaped), carbon, up the seat tube line to the saddle clamp.
  const clamp = onSeat(SADDLE.y - 0.045);
  add(aeroTube([cluster.clone().add(V(0, 0.01, 0)), clamp], () => [0.0135, 0.02, 0.4], { rings: 3, radial: Math.round(12 * R) }), carbon, CARBON);
  add(boxAt(0.03, 0.022, 0.05, clamp.clone().add(V(0, 0.014, 0.004))), black, SATIN);

  // ---- Saddle: narrow nose, wide flat tail, a central relief channel; rails beneath ----
  {
    const pts = [], hw = [], th = [];
    const prof = [[-0.175, 0.016, -0.012, 0.012], [-0.12, 0.02, -0.006, 0.014], [-0.06, 0.032, -0.003, 0.016], [0.0, 0.055, -0.002, 0.018], [0.05, 0.068, 0.0, 0.019], [0.085, 0.07, 0.004, 0.018], [0.105, 0.064, 0.009, 0.014]];
    for (const [dz, w, dy, t] of prof) { pts.push(V(0, SADDLE.y + dy - 0.008, SADDLE.z + dz)); hw.push(w); th.push(t); }
    const curve = new THREE.CatmullRomCurve3(pts);
    const n = Math.round(20 * R), m = Math.round(16 * R), pos = [], idx = [];
    for (let i = 0; i <= n; i++) {
      const u = i / n, c = curve.getPointAt(u);
      const f = u * (prof.length - 1), k = Math.min(prof.length - 2, Math.floor(f)), fr = f - k;
      const w = hw[k] + (hw[k + 1] - hw[k]) * fr, t = th[k] + (th[k + 1] - th[k]) * fr;
      for (let j = 0; j <= m; j++) {
        const a = (j / m) * Math.PI * 2, x = Math.cos(a), y = Math.sin(a);
        // Flat-topped section with rolled edges; a shallow channel down the middle of the top.
        const top = y > 0 ? 1 - 0.18 * Math.exp(-((x / 0.22) ** 2)) * (1 - Math.abs(2 * u - 1) ** 2) : 1;
        pos.push(c.x + x * w, c.y + (y > 0 ? y ** 0.5 * t * 0.5 * top : y * t * 0.5), c.z);
      }
    }
    for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) {
      const a = i * (m + 1) + j, b = a + 1, c2 = a + m + 1, d = c2 + 1;
      idx.push(a, b, c2, b, d, c2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    add(fixWinding(g.toNonIndexed()), '#151617', SATIN);
    for (const s of [-1, 1]) add(roundTube([V(0.022 * s, SADDLE.y - 0.022, SADDLE.z - 0.13), V(0.026 * s, SADDLE.y - 0.03, SADDLE.z - 0.02), V(0.034 * s, SADDLE.y - 0.024, SADDLE.z + 0.075)], 0.0035, { rings: 6, radial: 5 }), alloy, METAL);
  }

  // ---- Cockpit: one-piece aero bar and stem, hoods with levers, bar tape on the drops ----
  {
    const steer = htTop.clone().add(V(0, 0.034, 0.008));
    const barY = HOOD.y - 0.046, barZ = HOOD.z + 0.078;
    // Spacer and headset cap.
    add(new THREE.CylinderGeometry(0.019, 0.022, 0.03, Math.round(14 * R)).translate(htTop.x, htTop.y + 0.018, htTop.z + 0.004), carbon, CARBON);
    // Stem: from the steerer to the bar centre, slight drop, aero section.
    add(aeroTube([steer, V(0, barY + 0.006, barZ - 0.002)], () => [0.017, 0.016, 0.8], { rings: 3, radial: RAD, lead: V(0, 1, 0) }), carbon, CARBON);
    add(new THREE.SphereGeometry(0.022, Math.round(12 * R), Math.round(8 * R)).scale(1, 0.9, 1.2).translate(steer.x, steer.y, steer.z), carbon, CARBON);
    // Flat aero tops out to the bends (wing section, leading edge forward).
    for (const s of [-1, 1]) {
      const tops = [V(0, barY, barZ), V(0.09 * s, barY, barZ - 0.004), V(0.17 * s, barY - 0.002, barZ - 0.014), V(HOOD.x * s - 0.004 * s, barY - 0.004, barZ - 0.042)];
      add(aeroTube(tops, (u) => [0.0085, 0.022 - 0.008 * u, 0.35], { rings: Math.round(10 * R), radial: Math.round(12 * R), lead: V(0, 0, -1) }), carbon, CARBON);
      // Forward bend to the hoods, then the drops curling down and back (taped).
      const hx = HOOD.x * s;
      const drop = [V(hx, barY - 0.004, barZ - 0.042), V(hx, barY - 0.006, HOOD.z - 0.012), V(hx + 0.004 * s, barY - 0.04, HOOD.z - 0.04), V(hx + 0.008 * s, barY - 0.1, HOOD.z - 0.03), V(hx + 0.01 * s, barY - 0.13, HOOD.z + 0.03), V(hx + 0.01 * s, barY - 0.128, HOOD.z + 0.075)];
      add(roundTube(drop, 0.0128, { rings: Math.round(18 * R), radial: Math.round(9 * R) }), '#121314', RUBBER);
      // Hood: a shaped rubber body over the lever clamp, rising to a horn at the front.
      add(aeroTube([V(hx, barY + 0.004, HOOD.z + 0.035), V(hx, HOOD.y - 0.024, HOOD.z + 0.005), V(hx + 0.002 * s, HOOD.y - 0.012, HOOD.z - 0.03), V(hx + 0.004 * s, HOOD.y - 0.002, HOOD.z - 0.05)],
        (u) => [0.0145 - 0.002 * u, 0.019 + 0.004 * Math.sin(u * Math.PI), 0.9], { rings: Math.round(10 * R), radial: Math.round(10 * R), lead: V(0, 1, 0) }), '#0f0f10', RUBBER);
      // Brake/shift lever blade hanging from the hood front.
      add(aeroTube([V(hx + 0.004 * s, HOOD.y - 0.014, HOOD.z - 0.05), V(hx + 0.006 * s, HOOD.y - 0.075, HOOD.z - 0.06), V(hx + 0.012 * s, HOOD.y - 0.15, HOOD.z - 0.035)],
        (u) => [0.0045, 0.009 - 0.003 * u, 0.6], { rings: Math.round(8 * R), radial: 6 }), '#1a1b1e', CARBON);
    }
    // Out-front mount and computer.
    add(boxAt(0.016, 0.01, 0.07, V(0, barY + 0.004, barZ - 0.05)), black, SATIN);
    add(boxAt(0.05, 0.014, 0.075, V(0, barY + 0.015, barZ - 0.088), -0.12), '#101112', SATIN);
    add(boxAt(0.04, 0.002, 0.056, V(0, barY + 0.0225, barZ - 0.088), -0.12), '#7fb7a3', [0.1, 0.0]);
  }

  // ---- Wheels: deep carbon (or alloy) rims with decals, tyres, hubs, bladed spokes, disc rotors ----
  const depth = Math.max(0.022, kit.wheels?.depth ?? 0.025);
  const deep = depth > 0.03;
  const gold = kit.wheels?.id === 'gold';
  const rimCol = gold ? '#c9a23a' : deep ? '#17181a' : '#26282b';
  const wheel = (at, bone, rear) => {
    const W = [];
    const put = (g, colour, surf, uvKeep) => W.push(part(g.translate(at.x, at.y, at.z), colour, surf, bone, uvKeep ? 'keep' : undefined));
    const seg = near ? 56 : 18;
    // Tyre: round section with a sidewall label band (atlas row 3).
    const tyreR = 0.0125, tyreC = FIT.WHEEL_R - tyreR;
    const tyreProf = [];
    const TP = near ? 12 : 6;
    for (let k = 0; k <= TP; k++) {
      const a = -Math.PI / 2 + (k / TP) * Math.PI * 2 * 0.999;
      tyreProf.push([tyreC + Math.cos(a) * tyreR * 0.95, Math.sin(a) * tyreR]);
    }
    put(lathe(tyreProf, seg), '#161616', RUBBER);
    // Rim: brake track to the spoke bed, a blunt U (toroidal) section. Decals on the sidewalls.
    const rOut = FIT.WHEEL_R - 0.021, rIn = rOut - depth;
    const half = deep ? 0.0135 : 0.0105;
    const rimProf = [[rOut, -half * 0.86], [rOut - depth * 0.15, -half], [rOut - depth * 0.6, -half * 0.96], [rIn + depth * 0.12, -half * 0.72], [rIn, -half * 0.3], [rIn - 0.002, 0], [rIn, half * 0.3], [rIn + depth * 0.12, half * 0.72], [rOut - depth * 0.6, half * 0.96], [rOut - depth * 0.15, half], [rOut, half * 0.86]];
    if (deep) put(rimUV(lathe(rimProf, seg), rOut, rIn, [0.5, 0.75]), gold ? '#e5c76b' : '#ffffff', gold ? ALLOY : CARBON, true);
    else put(lathe(rimProf, seg), rimCol, ALLOY);
    // Hub and flanges.
    put(lathe([[0.012, -0.05], [0.014, -0.04], [0.026, -0.036], [0.026, -0.03], [0.016, -0.026], [0.016, 0.026], [0.024, 0.03], [0.024, 0.036], [0.014, 0.04], [0.012, 0.05]], Math.round(16 * R)), '#1c1d20', SATIN);
    // Bladed spokes.
    const n = near ? (rear ? 24 : 20) : 10;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2, s = i % 2 ? 1 : -1;
      const h = V(0.033 * s, Math.cos(a + 0.2 * s) * 0.024, Math.sin(a + 0.2 * s) * 0.024);
      const r = V(0.003 * s, Math.cos(a) * (rIn - 0.001), Math.sin(a) * (rIn - 0.001));
      const g = new THREE.BoxGeometry(0.0011, 1, 0.0034);
      const dir = r.clone().sub(h), len = dir.length();
      g.scale(1, len, 1);
      // Align the blade along the spoke with its flat face sideways.
      const q = new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), dir.normalize());
      g.applyQuaternion(q).translate((h.x + r.x) / 2, (h.y + r.y) / 2, (h.z + r.z) / 2);
      put(g, '#16171a', SATIN);
    }
    // Disc rotor (left side) and its carrier.
    if (near) put(lathe([[0.079, -0.0442], [0.08, -0.0436], [0.08, -0.0424], [0.079, -0.0418], [0.062, -0.0418], [0.061, -0.0424], [0.061, -0.0436], [0.062, -0.0442], [0.079, -0.0442]], Math.round(36 * R)), '#7e8287', [0.42, 0.6]);
    if (near) put(lathe([[0.061, -0.0432], [0.022, -0.042], [0.022, -0.04], [0.061, -0.041]], Math.round(16 * R)), '#1a1b1d', SATIN);
    if (rear && near) {
      // Cassette: a stack of sprockets on the right.
      for (let k = 0; k < 7; k++) put(lathe([[0.024 + k * 0.0045, 0.018 + k * 0.0042], [0.024 + k * 0.0045, 0.0205 + k * 0.0042]], Math.round(28 * R)), '#9a9da2', METAL);
    }
    return W;
  };
  const rearW = wheel(REAR, bones.rear, true), frontW = wheel(FRONT, bones.front, false);
  // Brake calipers (frame side, not spinning).
  add(boxAt(0.014, 0.026, 0.05, REAR.clone().add(V(-0.05, 0.065, 0.045)), -0.6), black, SATIN);
  add(boxAt(0.014, 0.026, 0.05, FRONT.clone().add(V(-0.05, 0.07, 0.035)), 0.5), black, SATIN);

  // ---- Drivetrain: crankset (on the crank bone), chain, derailleurs ----
  const crank = [];
  const putC = (g, colour, surf, uvKeep) => crank.push(part(g, colour, surf, bones.crank, uvKeep ? 'keep' : undefined));
  // Chainrings 52/36 on a four-arm spider (right side).
  const cx = 0.052;
  for (const [r, x] of [[0.106, cx], [0.074, cx - 0.005]]) putC(lathe([[r - 0.012, x - 0.002], [r, x - 0.0015], [r + 0.002, x], [r, x + 0.0015], [r - 0.012, x + 0.002]], Math.round(48 * R)).translate(BB.x, BB.y, BB.z), '#2a2b2e', METAL);
  for (let k = 0; k < (near ? 4 : 0); k++) {
    const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
    putC(aeroTube([V(cx + 0.006, BB.y, BB.z), V(cx + 0.002, BB.y + Math.cos(a) * 0.098, BB.z + Math.sin(a) * 0.098)], (u) => [0.004, 0.011 - 0.004 * u, 0.9], { rings: 2, radial: 6 }), '#1d1e21', ALLOY);
  }
  // Crank arms: tapered, hollow-forged look; axle.
  for (const s of [1, -1]) {
    const x = (cx + 0.016) * s;
    putC(aeroTube([V(x, BB.y, BB.z), V(x + 0.006 * s, BB.y - FIT.CRANK * s, BB.z)], (u) => [0.0075 - 0.0015 * u, 0.019 - 0.007 * u, 0.85], { rings: 4, radial: Math.round(10 * R), lead: V(0, 0, -1) }), '#1c1d20', ALLOY);
    putC(new THREE.CylinderGeometry(0.0085, 0.0085, 0.016, 10).rotateZ(Math.PI / 2).translate(x + 0.006 * s, BB.y - FIT.CRANK * s, BB.z), '#2a2b2e', ALLOY);
    // Pedal spindle stub out to the pedal.
    putC(new THREE.CylinderGeometry(0.0045, 0.0045, FIT.PEDAL_X - x - 0.01 * s, 8).rotateZ(Math.PI / 2).translate((x + FIT.PEDAL_X * s) / 2, BB.y - FIT.CRANK * s, BB.z), alloy, METAL);
  }
  putC(new THREE.CylinderGeometry(0.012, 0.012, 0.14, 12).rotateZ(Math.PI / 2).translate(BB.x, BB.y, BB.z), '#2a2b2e', ALLOY);
  // Chain: top run from the big ring to the cassette, bottom run via the derailleur pulleys (atlas row 4 links).
  const ring = 0.106, cog = 0.04;
  const top0 = V(cx, BB.y + ring, BB.z + 0.006), top1 = V(cx - 0.004, REAR.y + cog, REAR.z - 0.004);
  const pulleyA = V(cx - 0.004, REAR.y - 0.055, REAR.z + 0.01), pulleyB = V(cx - 0.004, REAR.y - 0.105, REAR.z - 0.012);
  const bot0 = V(cx, BB.y - ring, BB.z + 0.004);
  if (near) add(roundTube([top0, top0.clone().lerp(top1, 0.5), top1], 0.0034, { rings: 12, radial: 5 }), '#5d5f63', METAL);
  if (near) add(roundTube([REAR.clone().add(V(cx - 0.004, -cog, 0.012)), pulleyA, pulleyB, pulleyB.clone().lerp(bot0, 0.5), bot0], 0.0034, { rings: 16, radial: 5 }), '#5d5f63', METAL);
  // Rear derailleur: cage plates and pulleys, body on the hanger.
  add(boxAt(0.006, 0.075, 0.024, V(cx + 0.004, REAR.y - 0.08, REAR.z), 0.3), '#1b1c1f', ALLOY);
  if (near) for (const p of [pulleyA, pulleyB]) add(new THREE.CylinderGeometry(0.011, 0.011, 0.006, 12).rotateZ(Math.PI / 2).translate(p.x, p.y, p.z), '#2b2c2f', SATIN);
  add(boxAt(0.016, 0.03, 0.03, V(cx + 0.012, REAR.y - 0.025, REAR.z + 0.02), 0.5), '#202124', ALLOY);
  // Front derailleur on the seat tube.
  add(boxAt(0.02, 0.022, 0.05, onSeat(BB.y + 0.13).add(V(0.028, 0, -0.03)), 0.3), '#202124', ALLOY);

  // ---- Bottle and cage on the down tube ----
  {
    const a = htBot.clone().lerp(BB, 0.52).add(V(0, 0.032, 0.02)), b = htBot.clone().lerp(BB, 0.24).add(V(0, 0.032, 0.02));
    const axis = b.clone().sub(a).normalize();
    const bottle = new THREE.CylinderGeometry(0.036, 0.036, 0.2, Math.round(16 * R), 1).translate(0, 0.1, 0);
    bottle.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), axis)).translate(a.x, a.y, a.z);
    add(bottle, '#e8e8e6', [0.45, 0]);
    const capAt = a.clone().addScaledVector(axis, 0.215);
    const cap = new THREE.CylinderGeometry(0.014, 0.024, 0.03, 12).applyQuaternion(new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), axis)).translate(capAt.x, capAt.y, capAt.z);
    add(cap, '#16171a', SATIN);
    if (near) for (const sx of [-1, 1]) add(roundTube([a.clone().addScaledVector(axis, 0.01).add(V(0.026 * sx, -0.012, 0)), a.clone().addScaledVector(axis, 0.07).add(V(0.036 * sx, 0.0, 0)), a.clone().addScaledVector(axis, 0.15).add(V(0.034 * sx, 0.004, 0))], 0.0028, { rings: 6, radial: 4 }), carbon, CARBON);
  }
  // Rear light under the saddle.
  add(boxAt(0.028, 0.04, 0.02, onSeat(SADDLE.y - 0.07).add(V(0, 0, 0.024)), 0.3), '#c81c16', [0.3, 0]);

  const all = [...parts, ...rearW, ...frontW, ...crank];
  const g = mergeGeometries(all, false);
  g.computeBoundingSphere();
  return g;
}
