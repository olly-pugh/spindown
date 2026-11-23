// The spectators: MakeHuman bodies of different ages and builds, dressed in MakeHuman clothes, shoes and hair
// (all CC0), each posed in two key frames (A and B) that the game blends between to cheer, wave, clap or wave a
// flag. Two levels of detail: near (the clothed, textured figure) and far (the 741-vertex proxy body with the
// outfit's colours per vertex).
import fs from 'node:fs';
import path from 'node:path';
import { readObj, readFitting, fitCoords } from './mh.mjs';
import { Skeleton, toGame, fittedWeights, V3, M3 } from './skeleton.mjs';
import { standingPose } from './pose.mjs';
import { vertexNormals } from './meshkit.mjs';
import { simplify, compactMesh } from './simplify.mjs';
import { Builder } from './shells.mjs';

/** Parts, as the crowd shader understands them. */
export const PART = { SKIN: 0, TOP: 1, BOTTOM: 2, HAIR: 3, SHOES: 4, EYES: 5, HAT: 6, FLAG: 7, POLE: 8, PHONE: 9, CAP: 10, BEANIE: 11, BAG: 12 };

/** The people. age: 'young' | 'mid' | 'old' | 'child'. */
const VARIANTS = [
  { name: 'lad-tee', gender: 'male', age: 'young', muscle: 0.6, weight: 0.5, outfit: 'male_casualsuit06', hair: 'short02', shoes: 'shoes05', arms: 'cheer', lean: 0.4, skin: 'm' },
  { name: 'dad-jacket', gender: 'male', age: 'mid', muscle: 0.5, weight: 0.62, outfit: 'male_casualsuit05', hair: 'short04', shoes: 'shoes03', arms: 'clap', lean: -0.5, skin: 'm', beanie: true },
  { name: 'farmer', gender: 'male', age: 'old', muscle: 0.45, weight: 0.6, outfit: 'male_worksuit01', hair: 'short04', shoes: 'shoes03', hat: 'fedora01', arms: 'folded', lean: 0.6, skin: 'o', turn: 0.2 },
  { name: 'man-stripes', gender: 'male', age: 'mid', muscle: 0.45, weight: 0.75, outfit: 'male_casualsuit03', hair: 'short01', shoes: 'shoes01', arms: 'wave', lean: -0.3, skin: 'm', cap: true },
  { name: 'woman-tee', gender: 'female', age: 'young', muscle: 0.5, weight: 0.45, outfit: 'female_casualsuit01', hair: 'ponytail01', shoes: 'shoes05', arms: 'cheer', lean: 0.5, skin: 'f' },
  { name: 'woman-blouse', gender: 'female', age: 'old', muscle: 0.4, weight: 0.6, outfit: 'female_elegantsuit01', hair: 'bob02', shoes: 'shoes04', arms: 'clap', lean: -0.4, skin: 'f', bag: true },
  { name: 'woman-sport', gender: 'female', age: 'young', muscle: 0.6, weight: 0.4, outfit: 'female_sportsuit01', hair: 'long01', shoes: 'shoes02', arms: 'phone', lean: 0.3, skin: 'f', turn: -0.15, phone: true },
  { name: 'kid-boy', gender: 'male', age: 'child', muscle: 0.5, weight: 0.5, outfit: 'male_casualsuit04', hair: 'short03', shoes: 'shoes02', arms: 'cheer', lean: 0, skin: 'm' },
  { name: 'kid-girl', gender: 'female', age: 'child', muscle: 0.5, weight: 0.5, outfit: 'female_casualsuit02', hair: 'bob02', shoes: 'shoes05', arms: 'wave', lean: 0.3, skin: 'f' },
  { name: 'flag-man', gender: 'male', age: 'young', muscle: 0.55, weight: 0.55, outfit: 'male_casualsuit02', hair: 'short02', shoes: 'shoes02', arms: 'flag', flag: true, lean: 0, skin: 'm', cap: true },
  { name: 'woman-jacket', gender: 'female', age: 'mid', muscle: 0.45, weight: 0.55, outfit: 'male_casualsuit05', hair: 'long01', shoes: 'shoes04', arms: 'hips', lean: -0.6, skin: 'f', turn: 0.25, bag: true, beanie: true },
  { name: 'teen', gender: 'male', age: 'young', muscle: 0.45, weight: 0.38, outfit: 'male_casualsuit04', hair: 'afro01', shoes: 'shoes05', arms: 'down', lean: 0.7, skin: 'm', turn: -0.2 },
];

// ---- Texture atlas: 2048 x 2560, 512 cells; hair, shoes, eyes and the flag in 256 quarter-cells ----
export const ATLAS = { w: 2048, h: 2560 };
const cell = (cx, cy, q = null) => (q === null ? [cx * 512, cy * 512, 512, 512] : [cx * 512 + (q % 2) * 256, cy * 512 + Math.floor(q / 2) * 256, 256, 256]);
const LAYOUT = {
  'skin:m': { src: 'skins/young_caucasian_male/young_lightskinned_male_diffuse.png', rect: cell(0, 0) },
  'skin:f': { src: 'skins/young_caucasian_female/young_lightskinned_female_diffuse.png', rect: cell(1, 0) },
  'skin:o': { src: 'skins/old_caucasian_male/old_lightskinned_male_diffuse.png', rect: cell(2, 0) },
  male_casualsuit06: { src: 'clothes/male_casualsuit06/male_casualsuit06_diffuse.png', rect: cell(3, 0) },
  male_casualsuit05: { src: 'clothes/male_casualsuit05/male_casualsuit05_diffuse.png', rect: cell(0, 1) },
  male_worksuit01: { src: 'clothes/male_worksuit01/male_worksuit01_diffuse.png', rect: cell(1, 1) },
  male_casualsuit03: { src: 'clothes/male_casualsuit03/male_casualsuit03_diffuse.png', rect: cell(2, 1) },
  female_casualsuit01: { src: 'clothes/female_casualsuit01/female_casualsuit01_diffuse.png', rect: cell(3, 1), logo: true },
  female_elegantsuit01: { src: 'clothes/female_elegantsuit01/female_elegantsuit01_diffuse.png', rect: cell(0, 2) },
  female_sportsuit01: { src: 'clothes/female_sportsuit01/female_sportsuit01_diffuse.png', rect: cell(1, 2) },
  male_casualsuit04: { src: 'clothes/male_casualsuit04/male_casualsuit04_diffuse.png', rect: cell(2, 2), logo: true },
  female_casualsuit02: { src: 'clothes/female_casualsuit02/female_casualsuit02_diffuse.png', rect: cell(3, 2), logo: true },
  male_casualsuit02: { src: 'clothes/male_casualsuit02/male_casualsuit02_diffuse.png', rect: cell(0, 3), logo: true },
  short02: { src: 'hair/short02/short02_diffuse.png', rect: cell(1, 3, 0), alpha: true },
  short04: { src: 'hair/short04/short04_diffuse.png', rect: cell(1, 3, 1), alpha: true },
  short01: { src: 'hair/short01/short01_diffuse.png', rect: cell(1, 3, 2), alpha: true },
  ponytail01: { src: 'hair/ponytail01/ponytail01_diffuse.png', rect: cell(1, 3, 3), alpha: true },
  long01: { src: 'hair/long01/long01_diffuse.png', rect: cell(2, 3, 0), alpha: true },
  bob02: { src: 'hair/bob02/bob02_diffuse.png', rect: cell(2, 3, 1), alpha: true },
  afro01: { src: 'hair/afro01/afro_diffuse.png', rect: cell(2, 3, 2), alpha: true },
  short03: { src: 'hair/short03/short03_diffuse.png', rect: cell(2, 3, 3), alpha: true },
  shoes02: { src: 'clothes/shoes02/shoes02_diffuse.png', rect: cell(3, 3, 0) },
  shoes03: { src: 'clothes/shoes03/shoes03_diffuse.png', rect: cell(3, 3, 1) },
  shoes04: { src: 'clothes/shoes04/shoes04_diffuse.png', rect: cell(3, 3, 2) },
  shoes05: { src: 'clothes/shoes05/shoes05_diffuse.png', rect: cell(3, 3, 3) },
  shoes01: { src: 'clothes/shoes01/shoes01_diffuse.png', rect: cell(0, 4, 0) },
  eyes: { src: 'eyes/materials/brown_eye.png', rect: cell(0, 4, 1) },
  fedora01: { src: 'clothes/fedora01/fedora_diffuse.png', rect: cell(0, 4, 2) },
  flag: { src: '@flag', rect: cell(0, 4, 3) },
};

/** Remaps a source UV (0..1, v up) into its atlas rect (v up, image row 0 at the top). */
function atlasUV(key, u, v) {
  const [x, y, w, h] = LAYOUT[key].rect;
  const inset = 1.5;
  const uu = Math.min(1, Math.max(0, u)), vv = Math.min(1, Math.max(0, v));
  const px = x + inset + uu * (w - 2 * inset), py = y + inset + (1 - vv) * (h - 2 * inset);
  return [px / ATLAS.w, 1 - py / ATLAS.h];
}

function shapeFor(v) {
  const g = v.gender, ages = v.age === 'child' ? { child: 1 } : v.age === 'old' ? { old: 0.75, young: 0.25 } : v.age === 'mid' ? { young: 0.72, old: 0.28 } : { young: 1 };
  const m = v.muscle, w = v.weight;
  const mw = m < 0.5 ? { minmuscle: (0.5 - m) * 2, averagemuscle: m * 2 } : { averagemuscle: (1 - m) * 2, maxmuscle: (m - 0.5) * 2 };
  const ww = w < 0.5 ? { minweight: (0.5 - w) * 2, averageweight: w * 2 } : { averageweight: (1 - w) * 2, maxweight: (w - 0.5) * 2 };
  const out = {};
  for (const [age, aw] of Object.entries(ages)) {
    for (const [eth, ew] of [['caucasian', 0.7], ['african', 0.15], ['asian', 0.15]]) out[`macrodetails/${eth}-${g}-${age}`] = (out[`macrodetails/${eth}-${g}-${age}`] ?? 0) + ew * aw;
    for (const [mk, mwv] of Object.entries(mw)) for (const [wk, wwv] of Object.entries(ww)) {
      if (age === 'child' && !(mk === 'averagemuscle' && wk === 'averageweight')) continue;
      const key = `macrodetails/universal-${g}-${age}-${mk}-${wk}`;
      out[key] = (out[key] ?? 0) + aw * mwv * wwv;
    }
  }
  return out;
}

/**
 * ctx: {base, shaped(weights), skelDef, mhWeights, SYS, hasTarget(name)}. Returns {meshes, meta, atlasLayout}.
 */
export function buildCrowd(ctx) {
  const { base, skelDef, mhWeights, SYS } = ctx;
  const meshes = {};
  const variants = [];
  const proxyNear = { male: readFitting(path.join(SYS, 'proxymeshes/male1591/male1591.proxy')), female: readFitting(path.join(SYS, 'proxymeshes/female1605/female1605.proxy')) };
  const proxyNearObj = { male: readObj(path.join(SYS, 'proxymeshes/male1591/male1591.obj')), female: readObj(path.join(SYS, 'proxymeshes/female1605/female1605.obj')) };
  const proxyFar = readFitting(path.join(SYS, 'proxymeshes/proxy741/proxy741.proxy'));
  const proxyFarObj = readObj(path.join(SYS, 'proxymeshes/proxy741/proxy741.obj'));
  const clothes = (name) => {
    const dir = fs.existsSync(path.join(SYS, 'clothes', name)) ? path.join(SYS, 'clothes', name) : path.join(SYS, 'hair', name);
    const f = readFitting(path.join(dir, `${name}.mhclo`));
    return { fit: f, obj: readObj(path.join(dir, f.objFile)) };
  };
  const eyes = (() => {
    const f = readFitting(path.join(SYS, 'eyes/low-poly/low-poly.mhclo'));
    return { fit: f, obj: readObj(path.join(SYS, 'eyes/low-poly', f.objFile)) };
  })();

  for (const v of VARIANTS) {
    const restMH = ctx.shaped(shapeFor(v));
    const rest = toGame(restMH);
    const skel = new Skeleton(skelDef, rest);
    const posedFor = (frame) => {
      standingPose(skel, { arms: v.arms, frame, lean: v.lean ?? 0, turn: v.turn ?? 0 });
      return skel;
    };
    // Pieces: [{fit, obj, part, key (atlas), partOf(vertex) optional}]
    const outfit = clothes(v.outfit);
    const pieces = [];
    const deleted = new Set([...outfit.fit.deleteVerts]);
    const shoe = clothes(v.shoes);
    for (const d of shoe.fit.deleteVerts) deleted.add(d);
    pieces.push({ ...outfit, key: v.outfit, part: 'outfit' });
    pieces.push({ ...shoe, key: v.shoes, part: PART.SHOES });
    const acc = accessories(v, skel);
    pieces.push({ ...clothes(v.hair), key: v.hair, part: PART.HAIR, trim: acc.covers });
    pieces.push({ ...eyes, key: 'eyes', part: PART.EYES });
    if (v.hat) pieces.push({ ...clothes(v.hat), key: v.hat, part: PART.HAT });
    // Body proxy, minus what the clothes cover.
    const bodyFit = proxyNear[v.gender], bodyObj = proxyNearObj[v.gender];
    pieces.unshift({ fit: bodyFit, obj: bodyObj, key: `skin:${v.skin}`, part: PART.SKIN, body: true });

    // Rest coordinates and weights of every piece's vertices.
    for (const p of pieces) {
      p.rest = toGame(fitCoords(p.fit, restMH));
      p.w = fittedWeights(p.fit, mhWeights);
    }
    // Top or bottom for the outfit's vertices: above the hips (rest) is the top.
    const hipY = skel.bones['upperleg01.R'].head[1] + 0.07;
    const frames = {};
    for (const frame of ['A', 'B']) {
      posedFor(frame);
      frames[frame] = pieces.map((p) => skel.skin(p.rest, p.w));
    }
    // Stand on the ground: lowest posed point of frame A at y = 0; centre the feet at x = z = 0.
    let minY = Infinity;
    const sole = [0, 0];
    {
      const sh = frames.A[pieces.findIndex((p) => p.part === PART.SHOES)];
      let n = 0;
      for (let i = 0; i < sh.length; i += 3) { minY = Math.min(minY, sh[i + 1]); sole[0] += sh[i]; sole[1] += sh[i + 2]; n++; }
      sole[0] /= n; sole[1] /= n;
    }
    const shift = [-sole[0], -minY, -sole[1]];

    // The flag: a pole between the hands (frame A/B) with a cloth at the top.
    let flag = null;
    if (v.flag) {
      flag = {};
      for (const frame of ['A', 'B']) {
        posedFor(frame);
        const hR = skel.bones['finger3-1.R'].pos, hL = skel.bones['finger3-1.L'].pos;
        flag[frame] = { r: V3.add(hR, shift), l: V3.add(hL, shift) };
      }
    }

    // ---- Near mesh: each piece with atlas UVs, A/B positions and normals and parts, simplified, then merged ----
    const KEEP = { [PART.SKIN]: 1, outfit: 0.42, [PART.HAIR]: 0.45, [PART.SHOES]: 0.22, [PART.EYES]: 1, [PART.HAT]: 0.4 };
    const built = [];
    const addPiece = (p, ia) => {
      const P = [], PB = [], N = [], NB = [], UV = [], PT = [], IDX = [];
      const posA = frames.A[ia], posB = frames.B[ia];
      const faces = p.obj.faces.filter((f) => {
        if (p.trim && f.v.some((vi) => p.trim(p.rest[vi * 3], p.rest[vi * 3 + 1], p.rest[vi * 3 + 2]))) return false;
        if (!p.body) return true;
        // Drop body faces whose vertices' main reference vertex is covered by the clothes.
        return !f.v.every((vi) => {
          const k = [0, 1, 2].reduce((best, j) => (p.fit.w[vi * 3 + j] > p.fit.w[vi * 3 + best] ? j : best), 0);
          return deleted.has(p.fit.refs[vi * 3 + k]);
        });
      });
      const nA = vertexNormals(posA, p.obj.faces), nB = vertexNormals(posB, p.obj.faces);
      // Garments: whole UV islands are top or bottom (by their average height), so shirt tails stay shirt.
      let islandTop = null;
      if (p.part === 'outfit') {
        const parent = new Int32Array(p.obj.vt.length / 2).map((_, i) => i);
        const find = (a) => { while (parent[a] !== a) a = parent[a] = parent[parent[a]]; return a; };
        for (const f of p.obj.faces) for (let k = 1; k < f.t.length; k++) { const a = find(f.t[0]), b = find(f.t[k]); if (a !== b) parent[a] = b; }
        const sum = new Map();
        for (const f of p.obj.faces) f.v.forEach((vi, k) => {
          const r = find(f.t[k]);
          const e = sum.get(r) ?? [0, 0];
          e[0] += p.rest[vi * 3 + 1]; e[1]++;
          sum.set(r, e);
        });
        islandTop = (t) => { const e = sum.get(find(t)); return e && e[0] / e[1] > hipY; };
      }
      const map = new Map();
      for (const f of faces) {
        const ids = f.v.map((vi, k) => {
          const t = f.t[k];
          const key = vi * 100000 + t;
          let id = map.get(key);
          if (id !== undefined) return id;
          id = P.length / 3;
          map.set(key, id);
          P.push(posA[vi * 3] + shift[0], posA[vi * 3 + 1] + shift[1], posA[vi * 3 + 2] + shift[2]);
          PB.push(posB[vi * 3] + shift[0], posB[vi * 3 + 1] + shift[1], posB[vi * 3 + 2] + shift[2]);
          N.push(nA[vi * 3], nA[vi * 3 + 1], nA[vi * 3 + 2]);
          NB.push(nB[vi * 3], nB[vi * 3 + 1], nB[vi * 3 + 2]);
          const uv = atlasUV(p.key, t >= 0 ? p.obj.vt[t * 2] : 0.5, t >= 0 ? p.obj.vt[t * 2 + 1] : 0.5);
          UV.push(uv[0], uv[1]);
          let part = p.part;
          if (part === 'outfit') part = (t >= 0 ? islandTop(t) : p.rest[vi * 3 + 1] > hipY) ? PART.TOP : PART.BOTTOM;
          PT.push(part);
          return id;
        });
        for (let k = 1; k < ids.length - 1; k++) IDX.push(ids[0], ids[k], ids[k + 1]);
      }
      let m = finish({ P, PB, N, NB, UV, PT, IDX });
      const keepRatio = KEEP[p.part] ?? 1;
      if (keepRatio < 1) {
        const r = simplify(m.position, Array.from(m.index), Math.round((m.index.length / 3) * keepRatio));
        if (process.env.DBG_SIMPLIFY) { console.log("  simplify", p.key, m.index.length / 3, "->", r.index.length / 3); if (r.index.length === m.index.length) fs.writeFileSync("/private/tmp/claude-501/-Users-oliverpugh-Documents-Turbo-Trainer-App/800469bc-7f5d-4860-8448-5d74aed9b4d6/scratchpad/gp/dbg/fail-" + p.key + ".json", JSON.stringify({ pos: Array.from(m.position), idx: Array.from(m.index) })); }
        m = compactMesh(m, r.index, r.keep);
      }
      built.push(m);
    };
    pieces.forEach((p, i) => addPiece(p, i));
    // Accessories: carried by their bone in each key frame.
    for (const a of acc.list) {
      const fr = {};
      for (const frame of ['A', 'B']) {
        posedFor(frame);
        fr[frame] = [];
        for (let i = 0; i < a.b.P.length / 3; i++) {
          const pt = a.b.p(i);
          const bone = a.upper && pt[1] > a.split ? a.upper : a.bone;
          fr[frame].push(...V3.add(skel.carry(bone, pt), shift));
        }
      }
      const faces = [];
      for (let k = 0; k < a.b.I.length; k += 3) faces.push({ v: [a.b.I[k], a.b.I[k + 1], a.b.I[k + 2]] });
      const nA = vertexNormals(Float64Array.from(fr.A), faces), nB = vertexNormals(Float64Array.from(fr.B), faces);
      const grey = [0.875, 1 - 2400 / ATLAS.h];
      built.push(finish({ P: fr.A, PB: fr.B, N: Array.from(nA), NB: Array.from(nB), UV: Array.from({ length: a.b.P.length / 3 }, () => grey).flat(), PT: Array.from(a.b.R), IDX: a.b.I.slice() }));
    }
    const near = mergeFinished(built);
    if (flag) {
      const fl = unfinish(near);
      addFlag(flag, fl);
      Object.assign(near, finish(fl));
    }

    // ---- Far mesh: the proxy741 body with each vertex's part (and so colour) from the nearest near vertex ----
    const farRest = toGame(fitCoords(proxyFar, restMH));
    const farW = fittedWeights(proxyFar, mhWeights);
    const farPos = {};
    for (const frame of ['A', 'B']) {
      posedFor(frame);
      farPos[frame] = skel.skin(farRest, farW);
    }
    const FP = [], FPB = [], FN = [], FNB = [], FUV = [], FPT = [], FIDX = [];
    const nA = vertexNormals(farPos.A, proxyFarObj.faces), nBf = vertexNormals(farPos.B, proxyFarObj.faces);
    // Nearest near-mesh vertex (frame A), preferring the outermost layer (clothes over skin).
    const nearCount = near.count;
    const fmap = new Map();
    for (const f of proxyFarObj.faces) {
      const ids = f.v.map((vi) => {
        if (fmap.has(vi)) return fmap.get(vi);
        const id = FP.length / 3;
        fmap.set(vi, id);
        const x = farPos.A[vi * 3] + shift[0], y = farPos.A[vi * 3 + 1] + shift[1], z = farPos.A[vi * 3 + 2] + shift[2];
        FP.push(x, y, z);
        FPB.push(farPos.B[vi * 3] + shift[0], farPos.B[vi * 3 + 1] + shift[1], farPos.B[vi * 3 + 2] + shift[2]);
        FN.push(nA[vi * 3], nA[vi * 3 + 1], nA[vi * 3 + 2]);
        FNB.push(nBf[vi * 3], nBf[vi * 3 + 1], nBf[vi * 3 + 2]);
        let best = -1, bd = Infinity;
        for (let i = 0; i < nearCount; i++) {
          const pt = near.part[i];
          if (pt === PART.EYES || pt === PART.FLAG || pt === PART.POLE) continue;
          const d = (near.position[i * 3] - x) ** 2 + (near.position[i * 3 + 1] - y) ** 2 + (near.position[i * 3 + 2] - z) ** 2 - (pt === PART.SKIN ? 0 : 0.0004);
          if (d < bd) { bd = d; best = i; }
        }
        FUV.push(near.uv[best * 2] / 65535, near.uv[best * 2 + 1] / 65535);
        FPT.push(near.part[best]);
        return id;
      });
      for (let k = 1; k < ids.length - 1; k++) FIDX.push(ids[0], ids[k], ids[k + 1]);
    }
    let far = finish({ P: FP, PB: FPB, N: FN, NB: FNB, UV: FUV, PT: FPT, IDX: FIDX });
    if (flag) {
      // Distant flag-wavers keep their flag (it is what you notice).
      const fl = unfinish(far);
      addFlag(flag, fl);
      far = finish(fl);
    }
    // Very far: the proxy simplified to about a third (people beyond ~55 m are a handful of pixels).
    const vr = simplify(far.position, Array.from(far.index), Math.round((far.index.length / 3) * 0.3), { lockBorder: false });
    const vfar = compactMesh(far, vr.index, vr.keep);
    meshes[`${v.name}`] = near;
    meshes[`${v.name}:far`] = far;
    meshes[`${v.name}:vfar`] = vfar;
    // Arm swing amplitude for the shader's own extra motion is in the A/B frames; meta for the game.
    variants.push({ name: v.name, arms: v.arms, age: v.age, gender: v.gender, flag: !!v.flag, height: +(Math.max(...Array.from(near.position).filter((_, i) => i % 3 === 1))).toFixed(3) });
    console.log(`crowd ${v.name}: near ${near.count}v ${near.index.length / 3}t, far ${far.count}v ${far.index.length / 3}t, vfar ${vfar.index.length / 3}t`);
  }
  const atlasLayout = Object.fromEntries(Object.entries(LAYOUT).map(([k, l]) => [k, l]));
  return { meshes, meta: { variants, parts: PART, atlas: ATLAS }, atlasLayout };
}

/**
 * Accessories in the rest pose, each with the bone that carries it: a baseball cap or a beanie on the head, a
 * phone in the right hand, a shoulder bag. Returns [{builder, bone, part}] and a test for hair hidden by a hat.
 */
function accessories(v, skel) {
  const B = skel.bones, out = [];
  const H = B.head.head, C = [0, H[1] + 0.077, H[2] + 0.002];
  let covers = null;
  const dome = (b, rx, ry, rz, cy, rimFront, rimBack, part, nt = 28, ns = 7) => {
    const P = [];
    for (let i = 0; i <= nt; i++) {
      P.push([]);
      const th = (i / nt) * Math.PI * 2, c = Math.cos(th), sn = Math.sin(th);
      const rim = rimFront + (rimBack - rimFront) * (1 - c) / 2;
      const e0 = Math.asin(Math.max(-0.9, Math.min(0.9, (rim - cy) / ry)));
      for (let j = 0; j <= ns; j++) {
        const e = e0 + (Math.PI / 2 - e0) * (j / ns);
        P[i].push(b.v([sn * rx * Math.cos(e), cy + ry * Math.sin(e), C[2] - c * rz * Math.cos(e)], part));
      }
    }
    for (let i = 0; i < nt; i++) for (let j = 0; j < ns; j++) b.quad(P[i][j], P[i][j + 1], P[i + 1][j + 1], P[i + 1][j]);
    b.orient([0, cy - 0.02, C[2]]);
  };
  if (v.cap) {
    const b = new Builder();
    dome(b, 0.097, 0.09, 0.11, C[1] + 0.002, C[1] + 0.008, C[1] - 0.016, PART.CAP);
    // Peak: a curved visor off the front, slightly down.
    const NU = 10, peak = [];
    for (let i = 0; i <= NU; i++) {
      const u = -1 + (2 * i) / NU;
      const a = u * 1.0;
      const x0 = Math.sin(a) * 0.096, z0 = C[2] - Math.cos(a) * 0.109;
      const len = 0.075 * Math.cos(u * 1.2);
      peak.push([b.v([x0, C[1] + 0.008, z0], PART.CAP), b.v([x0 * 1.05, C[1] + 0.0 - 0.012 * (1 - u * u), z0 - len], PART.CAP)]);
    }
    for (let i = 0; i < NU; i++) {
      b.quad(peak[i][0], peak[i][1], peak[i + 1][1], peak[i + 1][0]);
      b.quad(peak[i][0], peak[i + 1][0], peak[i + 1][1], peak[i][1]);
    }
    out.push({ b, bone: 'head', part: PART.CAP });
    covers = (x, y, z) => y > C[1] - 0.012 && (x / 0.12) ** 2 + ((y - C[1]) / 0.12) ** 2 + ((z - C[2]) / 0.13) ** 2 < 1;
  } else if (v.beanie) {
    const b = new Builder();
    dome(b, 0.092, 0.092, 0.104, C[1] + 0.006, C[1] - 0.012, C[1] - 0.03, PART.BEANIE);
    // Folded cuff: a slightly bigger band round the rim.
    dome(b, 0.096, 0.03, 0.108, C[1] - 0.005, C[1] - 0.014, C[1] - 0.032, PART.BEANIE, 28, 2);
    out.push({ b, bone: 'head', part: PART.BEANIE });
    covers = (x, y, z) => y > C[1] - 0.026 && (x / 0.12) ** 2 + ((y - C[1]) / 0.125) ** 2 + ((z - C[2]) / 0.13) ** 2 < 1;
  }
  if (v.phone) {
    // A phone held up in the right hand, screen to the face.
    const w = B['wrist.R'].head, k3 = B['finger3-1.R'].head, k2 = B['finger2-1.R'].head, k5 = B['finger5-1.R'].head;
    const f = V3.norm(V3.sub(k3, w)), across = V3.norm(V3.sub(k5, k2));
    let n = V3.norm(V3.cross(f, across));
    if (V3.dot(n, [-1, 0, 0]) < 0) n = V3.scale(n, -1); // palm side faces the body at rest
    const c = V3.add(V3.add(w, V3.scale(f, 0.07)), V3.scale(n, 0.02));
    const b = new Builder();
    const corner = (a, bb, cc) => V3.add(c, V3.add(V3.add(V3.scale(f, a * 0.075), V3.scale(across, bb * 0.036)), V3.scale(n, cc * 0.004)));
    const ids = [];
    for (const a of [-1, 1]) for (const bb of [-1, 1]) for (const cc of [-1, 1]) ids.push(b.v(corner(a, bb, cc), PART.PHONE));
    const box = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]];
    for (const q of box) b.quad(ids[q[0]], ids[q[1]], ids[q[2]], ids[q[3]]);
    b.orient(c);
    out.push({ b, bone: 'wrist.R', part: PART.PHONE });
  }
  if (v.bag) {
    // Shoulder bag: strap from the left shoulder across the chest to a bag at the right hip.
    const b = new Builder();
    const shL = B['clavicle.L'].tail, hipR = B['upperleg01.R'].head;
    const chestF = B.spine02.head;
    const strap = [V3.add(shL, [0.0, 0.03, 0.01]), V3.add(chestF, [0.03, 0.06, -0.12]), V3.add(chestF, [0.11, -0.08, -0.1]), V3.add(hipR, [0.07, 0.07, -0.02])];
    b.tube(strap, 0.007, PART.BAG, 4);
    const bc = V3.add(hipR, [0.11, 0.0, 0.0]);
    const ids = [];
    for (const dx of [-1, 1]) for (const dy of [-1, 1]) for (const dz of [-1, 1]) ids.push(b.v(V3.add(bc, [dx * 0.035, dy * 0.09 + 0.0, dz * 0.12]), PART.BAG));
    const box = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]];
    for (const q of box) b.quad(ids[q[0]], ids[q[1]], ids[q[2]], ids[q[3]]);
    out.push({ b, bone: 'spine05', part: PART.BAG, upper: 'spine01', split: chestF[1] - 0.12 });
  }
  return { list: out, covers };
}

/** A flag on a pole held between the two hands: pole (dark) and a cloth (atlas flag cell) at the top. */
function addFlag(flag, M) {
  const { P, PB, N, NB, UV, PT, IDX } = M;
  const base = P.length / 3;
  const verts = (fr) => {
    const { r, l } = flag[fr];
    const mid = V3.scale(V3.add(r, l), 0.5);
    const up = [0, 1, 0];
    return { bottom: V3.sub(mid, V3.scale(up, 0.4)), top: V3.add(mid, V3.scale(up, 0.95)) };
  };
  const A = verts('A'), B = verts('B');
  // Pole: a thin box.
  const pole = (q, side) => {
    const w = 0.012;
    return [V3.add(q.bottom, [side * w, 0, 0]), V3.add(q.top, [side * w, 0, 0])];
  };
  const pa = [...pole(A, -1), ...pole(A, 1)], pb = [...pole(B, -1), ...pole(B, 1)];
  for (let i = 0; i < 4; i++) {
    P.push(...pa[i]); PB.push(...pb[i]); N.push(0, 0, -1); NB.push(0, 0, -1);
    UV.push(0.5, 0.5); PT.push(PART.POLE);
  }
  IDX.push(base, base + 1, base + 3, base, base + 3, base + 2);
  IDX.push(base, base + 3, base + 1, base, base + 2, base + 3);
  // Cloth: a 6x4 grid off the top of the pole, to the right, both sides.
  const cb = P.length / 3;
  const NX = 6, NY = 4, FW = 0.9, FH = 0.6;
  const [fx, fy, fw, fh] = LAYOUT.flag.rect;
  const [ax, ay] = [fx + 4, fy + 4], [aw, ah] = [fw - 8, fh - 8];
  for (let j = 0; j <= NY; j++) for (let i = 0; i <= NX; i++) {
    const u = i / NX, v = j / NY;
    const pA = V3.add(A.top, [u * FW, -v * FH, 0]), pB = V3.add(B.top, [u * FW, -v * FH, 0]);
    P.push(...pA); PB.push(...pB); N.push(0, 0, -1); NB.push(0, 0, -1);
    UV.push((ax + u * aw) / ATLAS.w, 1 - (ay + v * ah) / ATLAS.h);
    PT.push(PART.FLAG);
  }
  for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
    const a = cb + j * (NX + 1) + i, b = a + 1, c = a + NX + 1, d = c + 1;
    IDX.push(a, c, b, b, c, d, a, b, c, b, d, c);
  }
}

/** Back from typed arrays to plain lists (to append more geometry). */
function unfinish(m) {
  return { P: Array.from(m.position), PB: Array.from(m.positionB), N: Array.from(m.normal, (x) => x / 127), NB: Array.from(m.normalB, (x) => x / 127), UV: Array.from(m.uv, (x) => x / 65535), PT: Array.from(m.part), IDX: Array.from(m.index) };
}

/** Concatenates finished meshes. */
function mergeFinished(list) {
  const all = { P: [], PB: [], N: [], NB: [], UV: [], PT: [], IDX: [] };
  for (const m of list) {
    const u = unfinish(m), base = all.P.length / 3;
    for (const k of ['P', 'PB', 'N', 'NB', 'UV', 'PT']) for (const x of u[k]) all[k].push(x);
    for (const i of u.IDX) all.IDX.push(i + base);
  }
  return finish(all);
}

function finish({ P, PB, N, NB, UV, PT, IDX }) {
  const n = P.length / 3;
  return {
    count: n,
    position: Float32Array.from(P),
    positionB: Float32Array.from(PB),
    normal: Int8Array.from(N.map((x) => Math.round(Math.max(-1, Math.min(1, x)) * 127))),
    normalB: Int8Array.from(NB.map((x) => Math.round(Math.max(-1, Math.min(1, x)) * 127))),
    uv: Uint16Array.from(UV.map((x) => Math.round(Math.max(0, Math.min(1, x)) * 65535))),
    part: Uint8Array.from(PT),
    index: n > 65535 ? Uint32Array.from(IDX) : Uint16Array.from(IDX),
  };
}
void M3;
