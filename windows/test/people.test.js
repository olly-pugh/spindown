// Spindown World people: the committed rider and spectator packs decode with every mesh the game asks for, and
// the shared bike fit keeps the feet on the pedals all the way round the stroke.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { unpack } from '../src/renderer/game3d/people/pack.js';
import * as FIT from '../src/renderer/game3d/people/fit.js';

const pack = (name) => unpack(new Uint8Array(fs.readFileSync(fileURLToPath(new URL(`../src/renderer/game3d/people/${name}`, import.meta.url)))));

test('people: the rider pack has both bodies, all levels of detail and all gear', () => {
  const { meta, geometries: G } = pack('rider.bin');
  for (const [body, b] of Object.entries(meta.bodies)) {
    // The runtime skeleton: 20 bones, parents before children, the pelvis between the hips.
    assert.equal(b.bones.length, 20, body);
    b.bones.forEach((bone, i) => assert.ok(bone.parent < i, `${body} ${bone.name}`));
    for (const k of ['body', 'bodyMid', 'bodyFar', 'hair', 'helmet', 'helmetAero', 'glasses', 'shoes', 'helmetFar', 'helmetAeroFar', 'glassesFar', 'shoesFar']) {
      const g = G[k + b.suffix];
      assert.ok(g, `${body}: ${k}`);
      const n = g.attributes.position.count;
      assert.ok(n > 100, `${body}: ${k} has ${n} vertices`);
      // Every index points at a vertex; every vertex is skinned to a real bone.
      for (const i of g.index.array) assert.ok(i < n, `${body}: ${k} index ${i} >= ${n}`);
      const si = g.attributes.skinIndex.array;
      for (let i = 0; i < si.length; i++) assert.ok(si[i] < b.bones.length, `${body}: ${k} bone ${si[i]}`);
    }
    // Levels of detail get lighter.
    const tris = (k) => G[k + b.suffix].index.count / 3;
    assert.ok(tris('body') > tris('bodyMid') && tris('bodyMid') > tris('bodyFar'), body);
    // The near bodies carry what the kit shader and the face shapes need.
    for (const a of ['rest', 'kit', 'ao', 'uv', 'morph0', 'morph1', 'morph2']) assert.ok(G['body' + b.suffix].attributes[a], `${body}: body.${a}`);
    // The body sits on the bike: hips over the saddle, every vertex within the bike's bounds.
    const p = G['body' + b.suffix].attributes.position.array;
    for (let i = 0; i < p.length; i += 3) {
      assert.ok(p[i + 1] > 0.15 && p[i + 1] < 1.62, `${body}: vertex y ${p[i + 1]}`);
      assert.ok(Math.abs(p[i]) < 0.4 && p[i + 2] > -0.95 && p[i + 2] < 0.5, `${body}: vertex ${p[i]}, ${p[i + 2]}`);
    }
  }
});

test('people: the spectator pack has every person at three levels of detail, in two key frames', () => {
  const { meta, geometries: G } = pack('crowd.bin');
  assert.ok(meta.variants.length >= 10);
  assert.ok(meta.variants.some((v) => v.age === 'child') && meta.variants.some((v) => v.gender === 'female') && meta.variants.some((v) => v.flag));
  for (const v of meta.variants) {
    for (const lod of ['', ':far', ':vfar']) {
      const g = G[v.name + lod];
      assert.ok(g, v.name + lod);
      for (const a of ['position', 'positionB', 'normal', 'normalB', 'uv', 'part', 'ao']) assert.ok(g.attributes[a], `${v.name}${lod}.${a}`);
      // Standing on the ground, about person-sized (a flag held overhead reaches higher).
      let lo = Infinity, hi = -Infinity;
      const p = g.attributes.position.array;
      for (let i = 1; i < p.length; i += 3) { lo = Math.min(lo, p[i]); hi = Math.max(hi, p[i]); }
      assert.ok(Math.abs(lo) < 0.03, `${v.name}${lod} feet at ${lo}`);
      assert.ok(hi > (v.age === 'child' ? 0.9 : 1.45) && hi < (v.flag ? 3.2 : 2.6), `${v.name}${lod} top at ${hi}`);
    }
  }
});

test('people: the feet stay on the pedals round the whole stroke', () => {
  const pedal = [0, 0, 0];
  for (let k = 0; k < 72; k++) {
    const a = (k / 72) * Math.PI * 2;
    for (const side of [1, -1]) {
      const ankle = FIT.anklePosition(a, side);
      // Put the spindle back from the ankle through the foot's pitch: it must land on the crank circle.
      const pitch = FIT.footPitch(a), c = Math.cos(pitch), s = Math.sin(pitch);
      pedal[1] = ankle[1] + FIT.PEDAL[1] * c + FIT.PEDAL[2] * s;
      pedal[2] = ankle[2] - FIT.PEDAL[1] * s + FIT.PEDAL[2] * c;
      assert.ok(Math.abs(pedal[1] - (FIT.BB[1] - Math.cos(a) * FIT.CRANK)) < 1e-9, `y at ${k}`);
      assert.ok(Math.abs(pedal[2] - (FIT.BB[2] + Math.sin(a) * FIT.CRANK)) < 1e-9, `z at ${k}`);
      // The leg (0.425 + 0.442 m for the male body) can always reach without locking or folding up.
      const d = Math.hypot(ankle[1] - FIT.HIP[1], ankle[2] - FIT.HIP[2], ankle[0] - side * FIT.LEG_X);
      assert.ok(d > 0.42 && d < 0.425 + 0.442 - 0.02, `hip to ankle ${d} at ${k}`);
    }
  }
});
