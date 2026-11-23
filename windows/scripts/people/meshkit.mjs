// Mesh assembly and packing for the people build: OBJ-style faces (quads/tris with per-corner UVs) to indexed
// triangle meshes with compact vertex attributes, and a small binary container the game unpacks (see
// src/renderer/game3d/people/pack.js).
import { V3 } from './skeleton.mjs';

/** Smooth per-vertex normals (area weighted) for coords over faces [{v: [...]}]. */
export function vertexNormals(coords, faces, n = coords.length / 3) {
  const N = new Float64Array(n * 3);
  for (const f of faces) {
    const vs = f.v;
    for (let k = 1; k < vs.length - 1; k++) {
      const a = vs[0], b = vs[k], c = vs[k + 1];
      const ax = coords[a * 3], ay = coords[a * 3 + 1], az = coords[a * 3 + 2];
      const ux = coords[b * 3] - ax, uy = coords[b * 3 + 1] - ay, uz = coords[b * 3 + 2] - az;
      const vx = coords[c * 3] - ax, vy = coords[c * 3 + 1] - ay, vz = coords[c * 3 + 2] - az;
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      for (const v of [a, b, c]) { N[v * 3] += nx; N[v * 3 + 1] += ny; N[v * 3 + 2] += nz; }
    }
  }
  for (let i = 0; i < n; i++) {
    const l = Math.hypot(N[i * 3], N[i * 3 + 1], N[i * 3 + 2]) || 1;
    N[i * 3] /= l; N[i * 3 + 1] /= l; N[i * 3 + 2] /= l;
  }
  return N;
}

/** Four strongest runtime-bone influences per vertex, as [indices, weights] quantised to sum to 255. */
export function quantiseWeights(list) {
  const top = [...list].sort((a, b) => b[1] - a[1]).slice(0, 4);
  const s = top.reduce((a, [, w]) => a + w, 0) || 1;
  const idx = [0, 0, 0, 0], w = [0, 0, 0, 0];
  let acc = 0;
  top.forEach(([b, x], i) => {
    idx[i] = b;
    w[i] = Math.round((x / s) * 255);
    acc += w[i];
  });
  if (top.length) w[0] += 255 - acc;
  return [idx, w];
}

/**
 * Builds an indexed triangle mesh. src: {faces, vt, posed, rest?, normals?, weights?: per-vertex [[runtimeBone, w]],
 * kit?: per-vertex [4 floats 0..1], keep?: (face) => bool}. One output vertex per (vertex, uv) pair.
 */
export function assemble(src) {
  const { faces, vt, posed } = src;
  const normals = src.normals ?? vertexNormals(posed, faces);
  const map = new Map();
  const P = [], NN = [], UV = [], SI = [], SW = [], RP = [], KW = [], ORIG = [], index = [];
  const vid = (v, t) => {
    const key = v * 65536 + (t + 1);
    let i = map.get(key);
    if (i !== undefined) return i;
    i = P.length / 3;
    map.set(key, i);
    ORIG.push(v);
    P.push(posed[v * 3], posed[v * 3 + 1], posed[v * 3 + 2]);
    NN.push(normals[v * 3], normals[v * 3 + 1], normals[v * 3 + 2]);
    if (vt) UV.push(t >= 0 ? vt[t * 2] : 0, t >= 0 ? vt[t * 2 + 1] : 0);
    if (src.weights) {
      const [a, b] = quantiseWeights(src.weights[v] ?? []);
      SI.push(...a);
      SW.push(...b);
    }
    if (src.rest) RP.push(src.rest[v * 3], src.rest[v * 3 + 1], src.rest[v * 3 + 2]);
    if (src.kit) KW.push(...src.kit[v].map((x) => Math.round(Math.max(0, Math.min(1, x)) * 255)));
    return i;
  };
  for (const f of faces) {
    if (src.keep && !src.keep(f)) continue;
    const ids = f.v.map((v, k) => vid(v, f.t[k]));
    // Quads: split along the shorter diagonal.
    if (ids.length === 4) {
      const d02 = V3.len(V3.sub(P.slice(ids[0] * 3, ids[0] * 3 + 3), P.slice(ids[2] * 3, ids[2] * 3 + 3)));
      const d13 = V3.len(V3.sub(P.slice(ids[1] * 3, ids[1] * 3 + 3), P.slice(ids[3] * 3, ids[3] * 3 + 3)));
      if (d02 <= d13) index.push(ids[0], ids[1], ids[2], ids[0], ids[2], ids[3]);
      else index.push(ids[0], ids[1], ids[3], ids[1], ids[2], ids[3]);
    } else for (let k = 1; k < ids.length - 1; k++) index.push(ids[0], ids[k], ids[k + 1]);
  }
  const n = P.length / 3;
  const out = {
    count: n,
    position: Float32Array.from(P),
    normal: Int8Array.from(NN.map((x) => Math.round(x * 127))),
    index: n > 65535 ? Uint32Array.from(index) : Uint16Array.from(index),
    orig: Int32Array.from(ORIG),
  };
  if (vt) out.uv = Uint16Array.from(UV.map((x) => Math.round(Math.max(0, Math.min(1, x)) * 65535)));
  if (src.weights) {
    out.skinIndex = Uint8Array.from(SI);
    out.skinWeight = Uint8Array.from(SW);
  }
  if (src.rest) out.rest = Int16Array.from(RP.map((x) => Math.round(Math.max(-1, Math.min(1, x)) * 32767)));
  if (src.kit) out.kit = Uint8Array.from(KW);
  return out;
}

// Attribute layout: name -> [itemSize, normalized]. The type comes from the typed array.
export const LAYOUT = {
  position: [3, false], normal: [3, true], uv: [2, true], skinIndex: [4, false], skinWeight: [4, true], rest: [3, true], kit: [4, true],
  color: [3, true], region: [1, false], arm: [1, true], uv2: [2, true], edge: [1, true],
  positionB: [3, false], normalB: [3, true], part: [1, false],
};
const TYPES = { Float32Array: 'f32', Int8Array: 'i8', Uint8Array: 'u8', Int16Array: 'i16', Uint16Array: 'u16', Uint32Array: 'u32', Int32Array: 'i32' };

/** Packs meshes {name: {attr: TypedArray, index}} and a JSON meta into one buffer. */
export function pack(meta, meshes) {
  const chunks = [];
  let offset = 0;
  const desc = {};
  const put = (arr) => {
    const pad = (4 - (offset % 4)) % 4;
    if (pad) {
      chunks.push(new Uint8Array(pad));
      offset += pad;
    }
    const at = offset;
    const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
    chunks.push(bytes);
    offset += bytes.byteLength;
    return at;
  };
  for (const [name, m] of Object.entries(meshes)) {
    const d = { count: m.count, attributes: {} };
    for (const [k, arr] of Object.entries(m)) {
      if (k === 'count' || k === 'orig' || !ArrayBuffer.isView(arr)) continue;
      const type = TYPES[arr.constructor.name];
      if (k === 'index') d.index = { type, offset: put(arr), length: arr.length };
      else {
        const [size, normalized] = LAYOUT[k] ?? [1, false];
        d.attributes[k] = { type, offset: put(arr), length: arr.length, size, normalized };
      }
    }
    desc[name] = d;
  }
  const json = new TextEncoder().encode(JSON.stringify({ ...meta, meshes: desc }));
  const head = new Uint8Array(8 + json.length + ((4 - (json.length % 4)) % 4));
  const dv = new DataView(head.buffer);
  dv.setUint32(0, 0x31504c50, true); // 'PLP1'
  dv.setUint32(4, json.length, true);
  head.set(json, 8);
  const body = new Uint8Array(offset);
  let o = 0;
  for (const c of chunks) {
    body.set(c, o);
    o += c.byteLength;
  }
  const out = new Uint8Array(head.length + body.length);
  out.set(head, 0);
  out.set(body, head.length);
  return out;
}
