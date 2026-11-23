// Readers for MakeHuman 1.1 assets (CC0): the hm08 base mesh, targets, the default skeleton and weights, and
// proxy / clothes fitting files. Used only by build-people.mjs at development time; nothing here ships.
import fs from 'node:fs';

/** Wavefront OBJ with groups: {v: Float64Array, vt: Float64Array, faces: [{v: [], t: [], g}], groups: [names]}. */
export function readObj(file) {
  const v = [], vt = [], faces = [], groups = [];
  let g = -1;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.startsWith('v ')) {
      const p = line.split(/\s+/);
      v.push(+p[1], +p[2], +p[3]);
    } else if (line.startsWith('vt ')) {
      const p = line.split(/\s+/);
      vt.push(+p[1], +p[2]);
    } else if (line.startsWith('f ')) {
      const p = line.trim().split(/\s+/).slice(1);
      faces.push({ v: p.map((q) => +q.split('/')[0] - 1), t: p.map((q) => (q.split('/')[1] ? +q.split('/')[1] - 1 : -1)), g });
    } else if (line.startsWith('g ')) {
      groups.push(line.slice(2).trim());
      g = groups.length - 1;
    }
  }
  return { v: Float64Array.from(v), vt: Float64Array.from(vt), faces, groups };
}

/** A target: sparse vertex offsets. */
export function readTarget(file) {
  const idx = [], d = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line || line[0] === '#') continue;
    const p = line.trim().split(/\s+/);
    if (p.length < 4) continue;
    idx.push(+p[0]);
    d.push(+p[1], +p[2], +p[3]);
  }
  return { idx: Int32Array.from(idx), d: Float64Array.from(d) };
}

export function applyTarget(coords, target, w) {
  if (!w) return;
  const { idx, d } = target;
  for (let i = 0; i < idx.length; i++) {
    const o = idx[i] * 3;
    coords[o] += d[i * 3] * w;
    coords[o + 1] += d[i * 3 + 1] * w;
    coords[o + 2] += d[i * 3 + 2] * w;
  }
}

/**
 * Proxy (.proxy) or clothes (.mhclo) fitting: each vertex is a weighted sum of three reference vertices of the
 * base mesh plus an offset scaled by the distance between pairs of reference vertices.
 */
export function readFitting(file) {
  const refs = [], w = [], off = [], scale = [null, null, null];
  let objFile = null, inVerts = false, name = null, deleteVerts = [];
  let inDelete = false;
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const p = line.split(/\s+/);
    if (inVerts) {
      if (/^[0-9]/.test(p[0]) && (p.length === 9 || p.length === 1)) {
        if (p.length === 9) {
          refs.push(+p[0], +p[1], +p[2]);
          w.push(+p[3], +p[4], +p[5]);
          off.push(+p[6], +p[7], +p[8]);
        } else {
          refs.push(+p[0], +p[0], +p[0]);
          w.push(1, 0, 0);
          off.push(0, 0, 0);
        }
        continue;
      }
      inVerts = false;
    }
    if (inDelete) {
      if (/^[0-9]/.test(p[0])) {
        for (const q of p) {
          if (q.includes('-')) {
            const [a, b] = q.split('-').map(Number);
            for (let i = a; i <= b; i++) deleteVerts.push(i);
          } else deleteVerts.push(+q);
        }
        continue;
      }
      inDelete = false;
    }
    if (p[0] === 'verts') inVerts = true;
    else if (p[0] === 'delete_verts') inDelete = true;
    else if (p[0] === 'obj_file') objFile = p[1];
    else if (p[0] === 'name') name = p.slice(1).join(' ');
    else if (p[0] === 'x_scale') scale[0] = [+p[1], +p[2], +p[3]];
    else if (p[0] === 'y_scale') scale[1] = [+p[1], +p[2], +p[3]];
    else if (p[0] === 'z_scale') scale[2] = [+p[1], +p[2], +p[3]];
  }
  return { name, objFile, refs: Int32Array.from(refs), w: Float64Array.from(w), off: Float64Array.from(off), scale, deleteVerts };
}

/** Fitted coordinates of a proxy/clothes mesh on the (shaped, posed) base mesh coordinates. */
export function fitCoords(fit, coords) {
  const n = fit.refs.length / 3;
  const s = fit.scale.map((sc, a) => (sc ? Math.abs(coords[sc[0] * 3 + a] - coords[sc[1] * 3 + a]) / sc[2] : 1));
  const out = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < 3; a++) {
      out[i * 3 + a] = coords[fit.refs[i * 3] * 3 + a] * fit.w[i * 3] + coords[fit.refs[i * 3 + 1] * 3 + a] * fit.w[i * 3 + 1] + coords[fit.refs[i * 3 + 2] * 3 + a] * fit.w[i * 3 + 2] + fit.off[i * 3 + a] * s[a];
    }
  }
  return out;
}

export const readJSON = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
