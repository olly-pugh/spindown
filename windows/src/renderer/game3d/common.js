// Shared scenery builders: the road ribbon, arches and banners, trees, walls, hedges, house fronts and roofs,
// lamp posts and spectators. Everything repeated is instanced or merged, and split into square chunks so the
// renderer can skip what is off screen and the scene can hide (or simplify) what is far away.
import * as THREE from 'three';
import { crowd } from './crowd.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import * as T from './textures.js';
import { rng, hash2 } from '../../core/world/noise.js';

/** A colour from a CSS string, in the renderer's linear working space (for vertex and instance colours). */
export const colour = (c) => new THREE.Color(c);

/** Normalises geometries to position/normal/uv/color so they can be merged. */
export function mergeAll(list, { uv = true, colour: withColour = false } = {}) {
  const out = list.map((g) => {
    let n = g.index ? g.toNonIndexed() : g;
    for (const k of Object.keys(n.attributes)) if (!['position', 'normal', 'uv', 'color'].includes(k)) n.deleteAttribute(k);
    if (!n.attributes.normal) n.computeVertexNormals();
    if (uv && !n.attributes.uv) n.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n.attributes.position.count * 2), 2));
    if (!uv && n.attributes.uv) n.deleteAttribute('uv');
    if (withColour && !n.attributes.color) {
      const c = new Float32Array(n.attributes.position.count * 3).fill(1);
      n.setAttribute('color', new THREE.BufferAttribute(c, 3));
    }
    if (!withColour && n.attributes.color) n.deleteAttribute('color');
    return n;
  });
  return out.length ? mergeGeometries(out, false) : new THREE.BufferGeometry();
}

/**
 * Instanced copies of one geometry, split into square chunks so the renderer can skip chunks that are off
 * screen (and out of the shadow camera), and the scene can hide distant ones. items: [{matrix, colour?}].
 * Returns a Group whose children are InstancedMeshes with userData.centre / radius. `minDistance` hides a
 * chunk when the camera is nearer than that (for a low-detail stand-in of something drawn in full close up).
 */
export function chunked(geo, mat, items, { chunk = 220, shadows = true, receive = false, maxDistance = Infinity, minDistance = 0 } = {}) {
  const group = new THREE.Group();
  const cells = new Map();
  const v = new THREE.Vector3();
  for (const it of items) {
    v.setFromMatrixPosition(it.matrix);
    const key = `${Math.floor(v.x / chunk)},${Math.floor(v.z / chunk)}`;
    let list = cells.get(key);
    if (!list) cells.set(key, (list = []));
    list.push(it);
  }
  for (const list of cells.values()) {
    const mesh = new THREE.InstancedMesh(geo, mat, list.length);
    list.forEach((it, i) => {
      mesh.setMatrixAt(i, it.matrix);
      if (it.colour) mesh.setColorAt(i, it.colour);
    });
    mesh.computeBoundingSphere();
    mesh.castShadow = shadows;
    mesh.receiveShadow = receive;
    mesh.userData.centre = mesh.boundingSphere.center.clone();
    mesh.userData.radius = mesh.boundingSphere.radius;
    mesh.userData.maxDistance = maxDistance;
    mesh.userData.minDistance = minDistance;
    group.add(mesh);
  }
  group.userData.chunked = true;
  return group;
}

/**
 * Merges many small geometries into one mesh per square chunk. parts: [{geo, x, z}] (x/z decide the chunk).
 * The meshes get userData.centre / radius / maxDistance like `chunked`.
 */
export function mergedChunks(parts, mat, { chunk = 300, shadows = true, receive = true, maxDistance = Infinity, uv = true, colour: withColour = false } = {}) {
  const group = new THREE.Group();
  const cells = new Map();
  for (const p of parts) {
    if (!p.geo) continue;
    const key = `${Math.floor(p.x / chunk)},${Math.floor(p.z / chunk)}`;
    let list = cells.get(key);
    if (!list) cells.set(key, (list = []));
    list.push(p.geo);
  }
  for (const list of cells.values()) {
    const geo = mergeAll(list, { uv, colour: withColour });
    const mesh = new THREE.Mesh(geo, mat);
    geo.computeBoundingSphere();
    mesh.castShadow = shadows;
    mesh.receiveShadow = receive;
    mesh.userData.centre = geo.boundingSphere.center.clone();
    mesh.userData.radius = geo.boundingSphere.radius;
    mesh.userData.maxDistance = maxDistance;
    mesh.userData.minDistance = 0;
    group.add(mesh);
  }
  return group;
}

/** Hides chunks beyond their draw distance from the camera (or nearer than their minimum). */
export function cullChunks(root, camera) {
  root.traverse((o) => {
    if (o.isMesh && o.userData.maxDistance !== undefined && o.userData.centre) {
      const d = camera.position.distanceTo(o.userData.centre);
      o.visible = d - o.userData.radius < o.userData.maxDistance && d >= (o.userData.minDistance ?? 0);
    }
  });
}

const M4 = () => new THREE.Matrix4();

export function tint(geo, c) {
  const col = typeof c === 'string' ? colour(c) : c;
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = col.r;
    arr[i * 3 + 1] = col.g;
    arr[i * 3 + 2] = col.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

/** Vertex colours that run from `low` at the bottom of the geometry to `high` at the top (soft shading). */
export function shadeY(geo, low, high, c = '#ffffff') {
  const col = typeof c === 'string' ? colour(c) : c;
  geo.computeBoundingBox();
  const y0 = geo.boundingBox.min.y, y1 = geo.boundingBox.max.y;
  const p = geo.attributes.position;
  const arr = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const k = low + (high - low) * ((p.getY(i) - y0) / Math.max(1e-6, y1 - y0));
    arr[i * 3] = col.r * k;
    arr[i * 3 + 1] = col.g * k;
    arr[i * 3 + 2] = col.b * k;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

/**
 * A standard material whose colour map is sampled at two scales and modulated by a third, very large one, so
 * that grass and ground do not show a repeating tile into the distance.
 */
export function groundMaterial(params) {
  const m = new THREE.MeshStandardMaterial(params);
  m.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `
      #ifdef USE_MAP
        vec4 sampledDiffuseColor = texture2D( map, vMapUv );
        vec3 wide = texture2D( map, vMapUv * 0.137 + vec2( 0.31, 0.17 ) ).rgb;
        vec3 vast = texture2D( map, vMapUv * 0.0193 + vec2( 0.11, 0.53 ) ).rgb;
        float l1 = dot( wide, vec3( 0.333 ) ), l2 = dot( vast, vec3( 0.333 ) );
        sampledDiffuseColor.rgb = mix( sampledDiffuseColor.rgb, wide, 0.4 ) * clamp( 0.5 + 0.5 * l2 / max( 0.02, l1 ), 0.6, 1.4 );
        diffuseColor *= sampledDiffuseColor;
      #endif
    `);
  };
  m.customProgramCacheKey = () => 'ground-detail';
  return m;
}

/**
 * A ribbon along the route: `left`/`right` lateral offsets (metres, right positive), `lift` above the road
 * height, uv across 0..1 and along every `uvLength` metres.
 */
export function ribbon(route, { left, right, lift = 0, uvLength = 8, from = 0, to = route.length, step = 2, heightAt = null, uvAcross = 1 }) {
  const pos = [], uv = [], idx = [];
  const p = {};
  let k = 0;
  for (let d = from; d <= to + 0.01; d += step, k++) {
    route.position(d, 0, p);
    const h = p.heading;
    const cx = Math.cos(h), cz = Math.sin(h);
    const yL = heightAt ? heightAt(p.x + cx * left, p.z + cz * left, d) : p.y;
    const yR = heightAt ? heightAt(p.x + cx * right, p.z + cz * right, d) : p.y;
    pos.push(p.x + cx * left, yL + lift, p.z + cz * left, p.x + cx * right, yR + lift, p.z + cz * right);
    uv.push(0, d / uvLength, uvAcross, d / uvLength);
    if (k > 0) {
      // Counter-clockwise seen from above, so the surface faces up.
      const a = (k - 1) * 2, b = k * 2;
      idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** A ribbon along any polyline [x,z,...] at a fixed height (York streets). */
export function polylineRibbon(points, width, y, uvLength = 8) {
  return profileAlong(points, [[-width / 2, y], [width / 2, y]], { uvLength, uvAcross: 1 });
}

/**
 * Sweeps a cross-section along a polyline [x,z,...]. profile: [[offset, y], ...] from left to right (looking
 * along the line), going over the top, so every strip faces outwards. Each strip has its own vertices, which
 * keeps the edges between strips crisp. UV: u along (per uvLength metres), v across (per uvV metres, or 0…1
 * across the whole profile when uvAcross is set).
 */
export function profileAlong(points, profile, { uvLength = 4, uvV = 4, uvAcross = 0, closed = false } = {}) {
  const n = points.length / 2;
  if (n < 2) return null;
  const pos = [], uv = [], idx = [];
  // Mitred normals and distance along.
  const nrm = new Float32Array(n * 2), along = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const pi = closed ? (i - 1 + n) % n : Math.max(0, i - 1), ni = closed ? (i + 1) % n : Math.min(n - 1, i + 1);
    let dx = points[ni * 2] - points[pi * 2], dz = points[ni * 2 + 1] - points[pi * 2 + 1];
    const len = Math.hypot(dx, dz) || 1;
    dx /= len;
    dz /= len;
    nrm[i * 2] = -dz;
    nrm[i * 2 + 1] = dx;
    if (i > 0) along[i] = along[i - 1] + Math.hypot(points[i * 2] - points[i * 2 - 2], points[i * 2 + 1] - points[i * 2 - 1]);
  }
  let across = 0, total = 0;
  for (let j = 0; j < profile.length - 1; j++) total += Math.hypot(profile[j + 1][0] - profile[j][0], profile[j + 1][1] - profile[j][1]);
  for (let j = 0; j < profile.length - 1; j++) {
    const [o1, y1] = profile[j], [o2, y2] = profile[j + 1];
    const w = Math.hypot(o2 - o1, y2 - y1);
    const v1 = uvAcross ? (across / total) * uvAcross : across / uvV, v2 = uvAcross ? ((across + w) / total) * uvAcross : (across + w) / uvV;
    const base = pos.length / 3;
    for (let i = 0; i < n; i++) {
      const x = points[i * 2], z = points[i * 2 + 1], nx = nrm[i * 2], nz = nrm[i * 2 + 1];
      pos.push(x + nx * o1, y1, z + nz * o1, x + nx * o2, y2, z + nz * o2);
      if (uvAcross) uv.push(v1, along[i] / uvLength, v2, along[i] / uvLength);
      else uv.push(along[i] / uvLength, v1, along[i] / uvLength, v2);
      if (i > 0) {
        const a = base + (i - 1) * 2, b = base + i * 2;
        idx.push(a, a + 1, b, a + 1, b + 1, b);
      }
    }
    across += w;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * A vertical strip along the route at a lateral offset (barriers, bridge sides, embankments): from
 * `bottom(d, y)` to `top(d, y)` above sea level, where y is the road height at d. uvSpan: stretch U 0…1 over
 * the whole strip instead of repeating.
 */
export function routeWall(route, { lateral, from = 0, to = route.length, step = 2, bottom, top, uvLength = 4, uvHeight = 4, uvSpan = false }) {
  const pos = [], uv = [], idx = [];
  const p = {};
  let k = 0;
  for (let d = from; d <= to + 0.01; d += step, k++) {
    route.position(d, lateral, p);
    const y0 = bottom(d, p.y), y1 = top(d, p.y);
    pos.push(p.x, y0, p.z, p.x, y1, p.z);
    const u = uvSpan ? (d - from) / (to - from) : (d - from) / uvLength;
    if (uvSpan) uv.push(u, 0, u, 1);
    else uv.push(u, 0, u, (y1 - y0) / uvHeight);
    if (k > 0) {
      const a = (k - 1) * 2, b = k * 2;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export function roadMaterial(opts) {
  return new THREE.MeshStandardMaterial({ map: T.roadTexture(opts), roughness: 0.88, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
}

/** A banner arch over the road at distance d: a truss gantry on two legs with a printed banner. */
export function arch(route, d, text, { width = 9, colour: bg = '#1d7f46', height = 5.2 } = {}) {
  const g = new THREE.Group();
  const p = route.position(d);
  const postMat = new THREE.MeshStandardMaterial({ color: '#202327', roughness: 0.45, metalness: 0.5 });
  const parts = [];
  for (const s of [-1, 1]) {
    parts.push(new THREE.CylinderGeometry(0.11, 0.11, height, 10).translate((s * width) / 2, height / 2, 0));
    parts.push(new THREE.BoxGeometry(0.9, 0.12, 0.9).translate((s * width) / 2, 0.06, 0)); // ballast foot
    parts.push(new THREE.CylinderGeometry(0.05, 0.05, 2.2, 6).rotateZ(s * 0.75).translate((s * width) / 2 - s * 0.75, height - 1.2, 0)); // knee brace
  }
  parts.push(new THREE.BoxGeometry(width + 0.3, 0.1, 0.34).translate(0, height + 0.3, 0));
  parts.push(new THREE.BoxGeometry(width + 0.3, 0.1, 0.34).translate(0, height - 1.1, 0));
  const posts = new THREE.Mesh(mergeAll(parts), postMat);
  posts.castShadow = true;
  g.add(posts);
  const tex = T.textTexture(text, { bg, width: 1024, height: 160, font: '800 96px Segoe UI, Arial, sans-serif' });
  const bannerMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.75 });
  const side = new THREE.MeshStandardMaterial({ color: bg, roughness: 0.75 });
  const banner = new THREE.Mesh(new THREE.BoxGeometry(width - 0.1, 1.3, 0.22), [side, side, side, side, bannerMat, bannerMat]);
  banner.position.set(0, height - 0.4, 0);
  banner.castShadow = true;
  g.add(banner);
  g.position.set(p.x, p.y, p.z);
  g.rotation.y = -p.heading;
  return g;
}

/** A lumpy sphere: an icosahedron pushed in and out by smooth noise. */
function lump(radius, detail, seed, amount = 0.22) {
  const g = new THREE.IcosahedronGeometry(radius, detail);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const k = 1 + amount * (Math.sin(x * 2.1 / radius + seed) * Math.sin(y * 2.7 / radius + seed * 1.7) + Math.sin(z * 2.3 / radius + seed * 0.6) * 0.7);
    p.setXYZ(i, x * k, y * k, z * k);
  }
  return g;
}

/** Tree geometry templates: trunks, a full canopy of several lumps and a cheap far stand-in, each for broadleaf and conifer. */
export function treeTemplates() {
  const r = rng(77);
  // Broadleaf: a main dome with smaller lumps around and below it.
  const centre = new THREE.Vector3(0, 5.4, 0);
  const blobs = [lump(2.5, 1, 1).scale(1.05, 0.9, 1.05).translate(0, 6.0, 0)];
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + r() * 0.8;
    const rad = 1.5 + r() * 0.6;
    blobs.push(lump(rad, 1, 3 + i * 2.3).scale(1, 0.85, 1).translate(Math.cos(a) * 1.9, 4.5 + r() * 1.2, Math.sin(a) * 1.9));
  }
  const soften = (geo, c, low, high, yMin, yMax) => {
    // Blend each lump's normals towards "outwards from the whole crown" so it lights as one soft mass, and
    // darken the underside and the inside.
    const g = geo.index ? geo.toNonIndexed() : geo;
    const p = g.attributes.position, n = g.attributes.normal;
    const col = new Float32Array(p.count * 3);
    const v = new THREE.Vector3(), o = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(n, i);
      o.fromBufferAttribute(p, i).sub(c);
      const out = o.length();
      o.normalize();
      v.lerp(o, 0.6).normalize();
      n.setXYZ(i, v.x, v.y, v.z);
      const t = Math.min(1, Math.max(0, (p.getY(i) - yMin) / (yMax - yMin)));
      const k = (low + (high - low) * t) * (0.8 + 0.2 * Math.min(1, out / 2.6));
      col[i * 3] = k * (0.92 + 0.08 * t);
      col[i * 3 + 1] = k;
      col[i * 3 + 2] = k * (0.8 + 0.1 * (1 - t));
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return g;
  };
  const canopy = soften(mergeAll(blobs, { uv: true }), centre, 0.5, 1.12, 3.0, 8.2);
  const farTrunk = new THREE.CylinderGeometry(0.22, 0.34, 3.6, 4, 1, true).translate(0, 1.8, 0);
  const canopyFar = soften(mergeAll([lump(2.9, 0, 1).scale(1.15, 0.95, 1.15).translate(0, 5.6, 0)], { uv: true }), centre, 0.6, 1.05, 3.0, 8.2);
  const withTrunk = (crown) => {
    // The stand-in keeps a stub of trunk (tinted by the crown's colour, so drawn warm to come out brown).
    const t = tint(farTrunk.clone(), new THREE.Color(1.5, 0.7, 0.9));
    return mergeAll([crown, t], { colour: true });
  };
  // Trunk with two boughs reaching into the crown.
  const trunk = mergeAll([
    new THREE.CylinderGeometry(0.2, 0.36, 3.6, 7).translate(0, 1.8, 0),
    new THREE.CylinderGeometry(0.09, 0.17, 2.6, 5).rotateZ(0.6).translate(-0.75, 4.2, 0),
    new THREE.CylinderGeometry(0.09, 0.17, 2.4, 5).rotateZ(-0.5).rotateY(0.9).translate(0.55, 4.3, 0.3),
  ]);
  shadeY(trunk, 0.75, 1.05);
  // Conifer: stacked drooping cones.
  const cones = [];
  for (let i = 0; i < 4; i++) cones.push(new THREE.ConeGeometry(2.3 - i * 0.5, 3.0, 9, 1, true).translate(0, 2.6 + i * 1.75, 0));
  const conifer = soften(mergeAll(cones, { uv: true }), new THREE.Vector3(0, 5, 0), 0.5, 1.1, 1.2, 9.4);
  const coniferFar = soften(mergeAll([new THREE.ConeGeometry(2.3, 8.2, 6, 1, true).translate(0, 5.2, 0)], { uv: true }), new THREE.Vector3(0, 5, 0), 0.55, 1.05, 1.2, 9.4);
  return { trunk, canopy, canopyFar: withTrunk(canopyFar), conifer, coniferFar: withTrunk(coniferFar) };
}

/**
 * Instanced trees at the given placements [{x, y, z, s (scale), kind: 'broad'|'conifer', hue, sx, sy, rot}],
 * in chunks: full crowns close by, a single low-poly lump each beyond `lod` metres.
 */
export function trees(placements, { shadows = true, maxDistance = 1800, lod = 240 } = {}) {
  const group = new THREE.Group();
  const t = treeTemplates();
  const trunkMat = new THREE.MeshStandardMaterial({ map: T.barkTexture(), vertexColors: true, roughness: 0.95 });
  const broadMat = new THREE.MeshStandardMaterial({ map: T.leafTexture('oak'), vertexColors: true, roughness: 0.92 });
  const conMat = new THREE.MeshStandardMaterial({ map: T.leafTexture('conifer'), vertexColors: true, roughness: 0.92 });
  const q = new THREE.Quaternion(), e = new THREE.Euler();
  const items = placements.map((p) => {
    e.set(0, p.rot ?? 0, 0);
    q.setFromEuler(e);
    const m = M4().compose(new THREE.Vector3(p.x, p.y - 0.25, p.z), q, new THREE.Vector3(p.s * (p.sx ?? 1), p.s * (p.sy ?? 1), p.s * (p.sx ?? 1)));
    const c = new THREE.Color();
    const h = p.hue ?? 0;
    if (p.kind === 'conifer') c.setHSL(0.36 + h * 0.04, 0.4, 0.14 + h * 0.03);
    else c.setHSL(0.27 + h * 0.06, 0.5 + h * 0.1, 0.235 + h * 0.05);
    return { matrix: m, colour: c, kind: p.kind };
  });
  const broad = items.filter((i) => i.kind !== 'conifer'), con = items.filter((i) => i.kind === 'conifer');
  const chunk = 160;
  group.add(chunked(t.trunk, trunkMat, items.map((i) => ({ matrix: i.matrix })), { chunk, shadows, maxDistance: lod }));
  group.add(chunked(t.canopy, broadMat, broad, { chunk, shadows, maxDistance: lod }));
  group.add(chunked(t.conifer, conMat, con, { chunk, shadows, maxDistance: lod }));
  group.add(chunked(t.canopyFar, broadMat, broad, { chunk, shadows: false, minDistance: lod * 0.82, maxDistance }));
  group.add(chunked(t.coniferFar, conMat, con, { chunk, shadows: false, minDistance: lod * 0.82, maxDistance }));
  return group;
}

/**
 * Field boundaries as continuous extruded strips that follow the ground: segments [{x1,z1,x2,z2,y1,y2}].
 * kind 'wall': a dry-stone wall 1.25 m high, 0.6 m at the foot tapering to 0.34 m under its coping stones.
 * kind 'hedge': a clipped but shaggy hawthorn hedge about 1.6 m high whose height and width wander.
 * Merged into one mesh per chunk.
 */
export function linear(segments, kind, { shadows = true, maxDistance = 700, chunk = 200 } = {}) {
  const cells = new Map();
  const wall = kind === 'wall';
  const cellFor = (x, z) => {
    const key = `${Math.floor(x / chunk)},${Math.floor(z / chunk)}`;
    let c = cells.get(key);
    if (!c) cells.set(key, (c = { pos: [], nrm: [], uv: [], col: [], idx: [] }));
    return c;
  };
  // Cross-sections as [offset, height, normalX (across), normalY, v, shade].
  const wallProfile = [[-0.3, -0.2, -1, 0.12, 0, 0.8], [-0.17, 1.25, -1, 0.12, 1, 1], [-0.17, 1.25, 0, 1, 0.9, 1.05], [0.17, 1.25, 0, 1, 0.97, 1.05], [0.17, 1.25, 1, 0.12, 1, 1], [0.3, -0.2, 1, 0.12, 0, 0.8]];
  const hedgeProfile = [[-0.62, -0.2, -1, 0.05, 0, 0.5], [-0.72, 0.75, -1, 0.25, 0.3, 0.8], [-0.42, 1.5, -0.6, 0.8, 0.55, 1.05], [0.42, 1.5, 0.6, 0.8, 0.8, 1.1], [0.72, 0.75, 1, 0.25, 1.05, 0.85], [0.62, -0.2, 1, 0.05, 1.35, 0.5]];
  const profile = wall ? wallProfile : hedgeProfile;
  const green = colour('#648f47');
  for (const sg of segments) {
    const dx = sg.x2 - sg.x1, dz = sg.z2 - sg.z1;
    const len = Math.hypot(dx, dz);
    if (len < 0.05) continue;
    const ax = -dz / len, az = dx / len; // across
    const c = cellFor((sg.x1 + sg.x2) / 2, (sg.z1 + sg.z2) / 2);
    const base = c.pos.length / 3;
    // U runs along the wall from a position hash so neighbouring segments line up closely enough.
    const u0 = (sg.x1 * 0.37 + sg.z1 * 0.61) / (wall ? 2.6 : 2.5), u1 = u0 + len / (wall ? 2.6 : 2.5);
    const ends = [[sg.x1, sg.y1, sg.z1, u0], [sg.x2, sg.y2, sg.z2, u1]];
    for (let e = 0; e < 2; e++) {
      const [x, y, z, u] = ends[e];
      // Hedges wander in height and width; the wobble depends only on the point, so segment ends meet.
      const hs = wall ? 1 : 0.85 + 0.45 * hash2(Math.round(x * 3), Math.round(z * 3), 31);
      const ws = wall ? 1 : 0.85 + 0.4 * hash2(Math.round(z * 3), Math.round(x * 3), 32);
      const tone = wall ? 1 : 0.85 + 0.3 * hash2(Math.round(x), Math.round(z), 33);
      for (const [o, h, nx, ny, v, sh] of profile) {
        c.pos.push(x + ax * o * ws, y + h * (h > 0 ? hs : 1), z + az * o * ws);
        const l = Math.hypot(nx, ny);
        c.nrm.push((ax * nx) / l, ny / l, (az * nx) / l);
        c.uv.push(u, v);
        if (wall) c.col.push(sh, sh, sh);
        else c.col.push(green.r * sh * tone, green.g * sh * tone, green.b * sh * (2 - tone));
      }
    }
    const n = profile.length;
    for (let j = 0; j < n - 1; j++) {
      if (wall && j % 2 === 1) continue; // the wall profile lists each face's two edges separately
      const a = base + j, b = base + j + 1, a2 = base + n + j, b2 = base + n + j + 1;
      c.idx.push(a, b, a2, b, b2, a2);
    }
  }
  const mat = wall
    ? new THREE.MeshStandardMaterial({ map: T.stoneWallTexture(), vertexColors: true, roughness: 0.95, side: THREE.DoubleSide })
    : new THREE.MeshStandardMaterial({ map: T.leafTexture('oak'), vertexColors: true, roughness: 0.95, side: THREE.DoubleSide });
  const group = new THREE.Group();
  for (const c of cells.values()) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(c.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(c.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(c.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(c.col, 3));
    g.setIndex(c.idx);
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, mat);
    mesh.castShadow = shadows;
    mesh.receiveShadow = true;
    mesh.userData.centre = g.boundingSphere.center.clone();
    mesh.userData.radius = g.boundingSphere.radius;
    mesh.userData.maxDistance = maxDistance;
    mesh.userData.minDistance = 0;
    group.add(mesh);
  }
  return group;
}

/**
 * House fronts round a footprint ring [x,z,...]: every wall is split into a ground-floor band and upper
 * storeys, and into whole window bays, so the facade texture (see textures.facadeTexture) never cuts a
 * window in half or puts a front door on the third floor. Vertex colours carry the paint/brick tint, darker
 * at the foot of the wall.
 */
export function facadeRing(ring, y0, h, tintCol = '#ffffff', { storey = 3 } = {}) {
  const col = typeof tintCol === 'string' ? colour(tintCol) : tintCol;
  let area = 0;
  for (let i = 0; i < ring.length; i += 2) {
    const j = (i + 2) % ring.length;
    area += ring[i] * ring[j + 1] - ring[j] * ring[i + 1];
  }
  const pts = area > 0 ? ring : reverseRing(ring);
  const pos = [], uv = [], cols = [];
  const n = pts.length / 2;
  const storeys = Math.max(1, Math.round(h / storey));
  const sh = h / storeys;
  const quad = (ax, az, bx, bz, ya, yb, ua, ub, va, vb, ka, kb) => {
    pos.push(ax, ya, az, ax, yb, az, bx, ya, bz, bx, ya, bz, ax, yb, az, bx, yb, bz);
    uv.push(ua, va, ua, vb, ub, va, ub, va, ua, vb, ub, vb);
    for (const k of [ka, kb, ka, ka, kb, kb]) cols.push(col.r * k, col.g * k, col.b * k);
  };
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = pts[i * 2], az = pts[i * 2 + 1], bx = pts[j * 2], bz = pts[j * 2 + 1];
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 0.05) continue;
    let ua, ub;
    if (len < 2.6) {
      // Too narrow for a window: use the blank strip between the bays.
      ua = 0.345 + len / 8;
      ub = 0.345;
    } else {
      ua = Math.max(1, Math.round(len / 4)) / 2;
      ub = 0;
    }
    quad(ax, az, bx, bz, y0, y0 + sh, ua, ub, 0, 0.25, 0.8, 1);
    let done = 1;
    while (done < storeys) {
      const m = Math.min(3, storeys - done);
      quad(ax, az, bx, bz, y0 + sh * done, y0 + sh * (done + m), ua, ub, 0.25, 0.25 + 0.25 * m, 1, 1);
      done += m;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  g.computeVertexNormals();
  return g;
}

function reverseRing(r) {
  const out = [];
  for (let i = r.length - 2; i >= 0; i -= 2) out.push(r[i], r[i + 1]);
  return out;
}

/**
 * A pitched roof over an oriented rectangle: centre (cx, cz), ridge direction (ax, az) (unit), half-length
 * la along the ridge, half-width lb across it, eaves at height y, ridge rh above. Returns {slopes, gables}:
 * slopes (with overhanging eaves; UVs run along the ridge and up the slope, 2.4 m per repeat) and, unless
 * hipped, the two triangular gable walls (UVs 4 m per repeat, vertex-tinted).
 */
export function roofPrism({ cx, cz, ax, az, la, lb, y, rh, overhang = 0.35, hip = false, gableTint = '#ffffff' }) {
  const bx = -az, bz = ax;
  const P = (u, v, h) => [cx + ax * u + bx * v, h, cz + az * u + bz * v];
  const A = la + overhang, B = lb + overhang;
  const drop = (overhang * rh) / lb, ye = y - drop, yr = y + rh;
  const R = hip ? Math.max(0, la - lb * 0.85) : A;
  const S = Math.hypot(B, rh + drop), TX = 2.4;
  const pos = [], uv = [];
  for (const s of [-1, 1]) {
    pos.push(...P(-A, s * B, ye), ...P(A, s * B, ye), ...P(R, 0, yr), ...P(-A, s * B, ye), ...P(R, 0, yr), ...P(-R, 0, yr));
    uv.push(-A / TX, 0, A / TX, 0, R / TX, S / TX, -A / TX, 0, R / TX, S / TX, -R / TX, S / TX);
  }
  if (hip) {
    const Sh = Math.hypot(A - R, rh + drop);
    for (const s of [-1, 1]) {
      pos.push(...P(s * A, -B, ye), ...P(s * A, B, ye), ...P(s * R, 0, yr));
      uv.push(-B / TX, 0, B / TX, 0, 0, Sh / TX);
    }
  }
  const slopes = new THREE.BufferGeometry();
  slopes.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  slopes.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  slopes.computeVertexNormals();
  let gables = null;
  if (!hip) {
    const gp = [], gu = [];
    for (const s of [-1, 1]) {
      gp.push(...P(s * la, -lb, y), ...P(s * la, lb, y), ...P(s * la, 0, yr));
      gu.push(-lb / 4, 0, lb / 4, 0, 0, rh / 4);
    }
    gables = new THREE.BufferGeometry();
    gables.setAttribute('position', new THREE.Float32BufferAttribute(gp, 3));
    gables.setAttribute('uv', new THREE.Float32BufferAttribute(gu, 2));
    gables.computeVertexNormals();
    tint(gables, gableTint);
  }
  return { slopes, gables };
}

/** A chimney stack with two pots, astride a ridge at (x, y, z); its long side points along (cos rot, −sin rot). */
export function chimney(x, y, z, rot, stackTint = '#ffffff') {
  const stack = new THREE.BoxGeometry(0.95, 1.7, 0.6);
  const uv = stack.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 0.24, uv.getY(i) * 0.42);
  tint(stack, stackTint);
  const cap = tint(new THREE.BoxGeometry(1.08, 0.12, 0.72).translate(0, 0.9, 0), '#b9ae98');
  const pots = [-0.24, 0.24].map((o) => tint(new THREE.CylinderGeometry(0.1, 0.14, 0.45, 6, 1, true).translate(o, 1.15, 0), '#e8a078'));
  for (const g of [cap, ...pots]) {
    const u = g.attributes.uv;
    for (let i = 0; i < u.count; i++) u.setXY(i, 0.5 + u.getX(i) * 0.02, 0.5 + u.getY(i) * 0.02);
  }
  const g = mergeAll([stack, cap, ...pots], { colour: true });
  g.rotateY(rot);
  g.translate(x, y, z);
  return g;
}

/**
 * A row of village buildings. items: [{x, y, z, rot, w (frontage along the street), d (depth), h, kind
 * (facade kind), roof: 'slate'|'pantile'|'stone', tint?, hip?, chimney?}]. The ridge runs along the street.
 * Returns a group of merged meshes (walls per facade kind, roofs per roof kind, gables and chimneys).
 */
export function buildings(items, { shadows = true, gableTexture = null } = {}) {
  const byWall = new Map(), byRoof = new Map(), plain = [];
  for (const b of items) {
    const ax = -Math.sin(b.rot), az = -Math.cos(b.rot), bx = -az, bz = ax;
    const la = b.w / 2, lb = b.d / 2;
    const ring = [];
    for (const [u, v] of [[-la, -lb], [la, -lb], [la, lb], [-la, lb]]) ring.push(b.x + ax * u + bx * v, b.z + az * u + bz * v);
    const walls = facadeRing(ring, b.y - 0.6, b.h + 0.6, b.tint ?? '#ffffff', { storey: b.storey ?? 2.8 });
    (byWall.get(b.kind) ?? byWall.set(b.kind, []).get(b.kind)).push(walls);
    const rh = Math.min(3.4, b.d * 0.4);
    const { slopes, gables } = roofPrism({ cx: b.x, cz: b.z, ax, az, la, lb, y: b.y + b.h, rh, hip: !!b.hip, gableTint: b.gableTint ?? '#ffffff' });
    (byRoof.get(b.roof) ?? byRoof.set(b.roof, []).get(b.roof)).push(slopes);
    if (gables) plain.push(gables);
    if (b.chimney !== false) {
      const off = la - 0.5;
      for (const s of b.w > 8 ? [-1, 1] : [1]) plain.push(chimney(b.x + ax * off * s, b.y + b.h + rh + 0.35, b.z + az * off * s, Math.atan2(-bz, bx), b.gableTint ?? '#ffffff'));
    }
  }
  const group = new THREE.Group();
  for (const [kind, list] of byWall) {
    const mesh = new THREE.Mesh(mergeAll(list, { colour: true }), new THREE.MeshStandardMaterial({ map: T.facadeTexture(kind), vertexColors: true, roughness: 0.92 }));
    mesh.castShadow = shadows;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  for (const [kind, list] of byRoof) {
    const mesh = new THREE.Mesh(mergeAll(list), new THREE.MeshStandardMaterial({ map: T.roofTexture(kind), roughness: 0.85, side: THREE.DoubleSide }));
    mesh.castShadow = shadows;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  if (plain.length) {
    const mesh = new THREE.Mesh(mergeAll(plain, { colour: true }), new THREE.MeshStandardMaterial({ map: gableTexture ?? T.stoneWallTexture({ tone: 'rubble' }), vertexColors: true, roughness: 0.92, side: THREE.DoubleSide }));
    mesh.castShadow = shadows;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}

/** Lamp posts: Victorian cast-iron columns with a glazed lantern, instanced in chunks. */
export function lampPosts(points, { shadows = false } = {}) {
  const iron = '#1f2426';
  const geo = mergeAll([
    tint(new THREE.CylinderGeometry(0.11, 0.15, 0.9, 8).translate(0, 0.45, 0), iron), // fluted base
    tint(new THREE.CylinderGeometry(0.15, 0.15, 0.08, 8).translate(0, 0.94, 0), iron),
    tint(new THREE.CylinderGeometry(0.045, 0.07, 3.0, 8).translate(0, 2.4, 0), iron),
    tint(new THREE.CylinderGeometry(0.02, 0.02, 0.6, 5).rotateZ(Math.PI / 2).translate(0, 3.55, 0), iron), // ladder bar
    tint(new THREE.CylinderGeometry(0.09, 0.05, 0.14, 8).translate(0, 3.95, 0), iron),
    tint(new THREE.CylinderGeometry(0.2, 0.13, 0.42, 6).translate(0, 4.23, 0), '#f3e6b8'), // lantern glass
    tint(new THREE.ConeGeometry(0.27, 0.24, 6).translate(0, 4.56, 0), iron),
    tint(new THREE.SphereGeometry(0.045, 6, 5).translate(0, 4.71, 0), iron),
  ], { colour: true, uv: false });
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.3 });
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
  const items = points.map((p) => {
    q.setFromAxisAngle(up, p.rot);
    return { matrix: m.clone().compose(new THREE.Vector3(p.x, p.y, p.z), q, new THREE.Vector3(1, 1, 1)) };
  });
  return chunked(geo, mat, items, { chunk: 300, shadows, maxDistance: 420 });
}

/** Standing spectators along the road: smooth, individually coloured people who cheer and wave (crowd.js). */
export function spectators(points, opts) {
  return crowd(points, opts);
}

/** A floating, spinning power-up token with a glow ring; `icon` is an emoji drawn on a sprite. */
export function powerupToken() {
  const g = new THREE.Group();
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  sprite.scale.set(1.3, 1.3, 1);
  sprite.position.y = 1.6;
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.8, 0.07, 8, 32), new THREE.MeshStandardMaterial({ color: '#ffd400', emissive: '#ffb000', emissiveIntensity: 1.2, roughness: 0.3 }));
  ring.position.y = 1.6;
  g.add(sprite, ring);
  g.userData = {
    ring,
    draw(icon) {
      ctx.clearRect(0, 0, 128, 128);
      const grd = ctx.createRadialGradient(64, 64, 10, 64, 64, 62);
      grd.addColorStop(0, 'rgba(255,255,255,0.95)');
      grd.addColorStop(0.7, 'rgba(255,220,120,0.55)');
      grd.addColorStop(1, 'rgba(255,200,0,0)');
      ctx.fillStyle = grd;
      ctx.beginPath();
      ctx.arc(64, 64, 62, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = '64px "Segoe UI Emoji", "Apple Color Emoji", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(icon, 64, 70);
      tex.needsUpdate = true;
    },
  };
  g.userData.draw('❓');
  return g;
}
