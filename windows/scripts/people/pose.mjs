// Poses for the MakeHuman skeleton: the cyclist on the hoods, and standing spectators. All positions are in the
// game frame (metres, +y up, the figure facing -z, +x its right).
import { M3, V3 } from './skeleton.mjs';

const { sub, add, scale, norm, len, cross, dot } = V3;

/** Two-bone IK: joint position for a chain root->joint->end of lengths a, b reaching `target`, bending towards `pole`. */
export function ikJoint(root, target, a, b, pole) {
  const d = sub(target, root);
  const dist = Math.min(a + b - 1e-5, Math.max(Math.abs(a - b) + 1e-5, len(d)));
  const dir = norm(d);
  const x = (a * a - b * b + dist * dist) / (2 * dist); // along dir
  const h = Math.sqrt(Math.max(0, a * a - x * x));
  // Pole direction perpendicular to dir.
  let p = sub(pole, scale(dir, dot(pole, dir)));
  p = norm(p);
  return add(add(root, scale(dir, x)), scale(p, h));
}

/** Rotates bone `name` about its head so that the point `from` (world, carried by the bone) goes towards `to`. */
export function aimPoint(skel, name, from, to) {
  skel.solve();
  const h = skel.bones[name].pos;
  skel.rotateWorld(name, M3.between(sub(from, h), sub(to, h)));
}

const curl = (skel, name, axis, angle) => {
  skel.solve();
  skel.rotateWorld(name, M3.axisAngle(axis, angle));
};

/**
 * Arm and hand poses for spectators: per side, the world direction of the upper arm (shoulder to elbow) and of
 * the forearm (elbow to wrist) for the right arm (the left mirrors x unless given), and how much the fingers curl.
 * Each pose has two key frames, A and B; the game blends between them to animate.
 */
const ARMS = {
  down: { R: [[0.1, -1, 0.04], [0.05, -1, -0.16]], curl: 0.35 },
  cheer: { A: { R: [[0.5, 0.82, -0.16], [0.22, 1, -0.12]] }, B: { R: [[0.32, 0.95, -0.1], [0.06, 1, -0.04]] }, curl: 1.25 },
  wave: { A: { R: [[0.85, 0.42, -0.25], [0.2, 1, -0.18]], L: [[-0.1, -1, 0.04], [-0.05, -1, -0.16]] }, B: { R: [[0.85, 0.42, -0.25], [0.72, 0.72, -0.18]], L: [[-0.1, -1, 0.04], [-0.05, -1, -0.16]] }, curl: 0.12 },
  clap: { A: { R: [[0.22, -0.82, -0.52], [-0.3, 0.18, -1]] }, B: { R: [[0.18, -0.82, -0.55], [-0.62, 0.2, -0.78]] }, curl: 0.15 },
  flag: { A: { R: [[0.5, 0.85, -0.22], [-0.25, 1, -0.12]], L: [[-0.32, 0.92, -0.22], [0.42, 0.95, -0.12]] }, B: { R: [[0.32, 0.92, -0.22], [-0.42, 0.95, -0.12]], L: [[-0.5, 0.85, -0.22], [0.25, 1, -0.12]] }, curl: 1.1 },
  phone: { A: { R: [[0.32, -0.32, -0.9], [-0.25, 0.78, -0.58]], L: [[-0.1, -1, 0.04], [-0.05, -1, -0.16]] }, B: { R: [[0.3, -0.3, -0.9], [-0.22, 0.8, -0.56]], L: [[-0.1, -1, 0.04], [-0.05, -1, -0.16]] }, curl: 0.8 },
  folded: { R: [[0.3, -0.72, -0.6], [-1, 0.18, -0.22]], curl: 0.6 },
  hips: { R: [[0.92, -0.38, 0.12], [-0.55, -0.78, 0.02]], curl: 0.5 },
};

/**
 * A standing spectator. spec: {arms: key of ARMS, frame: 'A'|'B', lean: hip shift (-1..1), turn: head yaw (rad)}.
 * The figure faces -z with the soles of the feet on y = 0 (the caller re-centres). Returns the key points.
 */
export function standingPose(skel, spec) {
  const B = skel.bones;
  skel.reset();
  const def = ARMS[spec.arms] ?? ARMS.down;
  const frame = def[spec.frame ?? 'A'] ?? def;
  // Legs: feet under the hips, a little apart; weight on one leg bends the other knee slightly.
  for (const s of ['R', 'L']) {
    const sgn = s === 'R' ? 1 : -1;
    skel.solve();
    const hip = B[`upperleg01.${s}`].pos, ankle = B[`foot.${s}`].pos;
    const want = [sgn * (0.095 + 0.02 * Math.max(0, sgn * (spec.lean ?? 0))), ankle[1], ankle[2] + 0.01 * sgn];
    aimPoint(skel, `upperleg01.${s}`, ankle, want);
    // Feet point a little outwards.
    skel.solve();
    skel.rotateWorld(`foot.${s}`, M3.axisAngle([0, 1, 0], -sgn * 0.12));
  }
  // Weight shift: the pelvis drops a touch on the relaxed side; the relaxed knee bends.
  const lean = spec.lean ?? 0;
  if (lean) {
    skel.rotateWorld('root', M3.axisAngle([0, 0, 1], 0.035 * lean));
    const relaxed = lean > 0 ? 'L' : 'R';
    skel.solve();
    skel.rotateWorld(`lowerleg01.${relaxed}`, M3.axisAngle([1, 0, 0], -0.12));
    skel.rotateWorld(`upperleg01.${relaxed}`, M3.axisAngle([1, 0, 0], 0.06));
  }
  // Arms.
  for (const s of ['R', 'L']) {
    const sgn = s === 'R' ? 1 : -1;
    const mirror = (d) => [d[0] * sgn, d[1], d[2]];
    const [ua, fa] = frame[s] ?? frame.R.map(mirror);
    skel.solve();
    const sh = B[`upperarm01.${s}`].pos;
    aimPoint(skel, `upperarm01.${s}`, B[`lowerarm01.${s}`].pos, add(sh, norm(ua)));
    skel.solve();
    const el = B[`lowerarm01.${s}`].pos;
    aimPoint(skel, `lowerarm01.${s}`, B[`wrist.${s}`].pos, add(el, norm(fa)));
    // Hand along the forearm, then the fingers curl.
    skel.solve();
    const w = B[`wrist.${s}`].pos, k3 = B[`finger3-1.${s}`].pos;
    aimPoint(skel, `wrist.${s}`, k3, add(w, scale(norm(fa), len(sub(k3, w)))));
    skel.solve();
    const k2 = B[`finger2-1.${s}`].pos, k5 = B[`finger5-1.${s}`].pos;
    const f = norm(sub(B[`finger3-1.${s}`].pos, B[`wrist.${s}`].pos));
    let n = cross(sub(k2, w), sub(k5, w));
    n = norm(sub(n, scale(f, dot(n, f))));
    // Palm normal sign: towards the body at rest (computed from the rest skeleton).
    const restN = cross(sub(B[`finger2-1.${s}`].head, B[`wrist.${s}`].head), sub(B[`finger5-1.${s}`].head, B[`wrist.${s}`].head));
    if (dot(restN, [-sgn, 0, 0]) < 0) n = scale(n, -1);
    const axis = cross(f, n);
    const c = def.curl ?? 0.4;
    for (const fg of [2, 3, 4, 5]) {
      curl(skel, `finger${fg}-1.${s}`, axis, c * 0.8);
      curl(skel, `finger${fg}-2.${s}`, axis, c);
      curl(skel, `finger${fg}-3.${s}`, axis, c * 0.7);
    }
    curl(skel, `finger1-2.${s}`, axis, c * 0.4);
  }
  // Head: a little turned, chin level.
  if (spec.turn) skel.rotateWorld('neck02', M3.axisAngle([0, 1, 0], spec.turn));
  if (spec.nod) skel.rotateWorld('head', M3.axisAngle([1, 0, 0], spec.nod));
  skel.solve();
}

/**
 * The road cyclist on the hoods. fit: {hip, shoulderY, hood, pedal(side) -> {ankle, pitch}, headPitch}.
 * Returns the posed key points (for fitting the bike to the rider).
 */
export function cyclingPose(skel, fit) {
  const B = skel.bones;
  skel.reset();
  // Which way the palm normal (index x little-finger knuckles from the wrist) points: towards the midline at rest.
  fit.palmSign = {};
  for (const s of ['R', 'L']) {
    const sgn = s === 'R' ? 1 : -1;
    const w = B[`wrist.${s}`].pos, k2 = B[`finger2-1.${s}`].pos, k5 = B[`finger5-1.${s}`].pos;
    const n = cross(sub(k2, w), sub(k5, w));
    fit.palmSign[s] = dot(n, [-sgn, 0, 0]) > 0 ? 1 : -1;
  }
  // 1. Move the hips onto the saddle: put the midpoint of the hip joints at fit.hip.
  const hipMid = scale(add(B['upperleg01.R'].head, B['upperleg01.L'].head), 0.5);
  B.root.rootPos = add(B.root.head, sub(fit.hip, hipMid));
  skel.solve();
  // 2. Pelvis rolled forward about the hip axis.
  const tiltAxis = [1, 0, 0];
  skel.rotateWorld('root', M3.axisAngle(tiltAxis, -fit.pelvisTilt));
  // Re-centre the hips (the root bone's head is not at the hip joints).
  {
    const m = scale(add(B['upperleg01.R'].pos, B['upperleg01.L'].pos), 0.5);
    B.root.rootPos = add(B.root.rootPos, sub(fit.hip, m));
    skel.solve();
  }
  // 3. Spine: a long smooth forward curve, rounder through the upper back, solved so the shoulders reach
  // the height that puts the hands on the hoods.
  const spine = [['spine05', 0.16], ['spine04', 0.16], ['spine03', 0.18], ['spine02', 0.26], ['spine01', 0.24]];
  const setSpine = (total) => {
    for (const [n, f] of spine) B[n].local = M3.I();
    skel.solve();
    for (const [n, f] of spine) skel.rotateWorld(n, M3.axisAngle(tiltAxis, -total * f));
  };
  let lo = 0, hi = 1.6;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    setSpine(mid);
    const sh = scale(add(B['upperarm01.R'].pos, B['upperarm01.L'].pos), 0.5);
    if (sh[1] > fit.shoulderY) lo = mid;
    else hi = mid;
  }
  setSpine((lo + hi) / 2);
  // Shoulder blades forward a little (protracted), as on the bars.
  for (const s of ['R', 'L']) {
    const sgn = s === 'R' ? 1 : -1;
    skel.rotateWorld(`clavicle.${s}`, M3.axisAngle([0, 1, 0], sgn * fit.protract));
    skel.rotateWorld(`clavicle.${s}`, M3.axisAngle([0, 0, 1], -sgn * fit.shrug));
  }
  // 4. Neck extended so the face looks up the road.
  const neck = [['neck01', 0.3], ['neck02', 0.35], ['neck03', 0.35]];
  {
    skel.solve();
    const headDir = M3.col(B.head.rot, 1); // current head axis (towards the crown)
    const wantHead = norm([0, Math.cos(fit.headPitch), -Math.sin(fit.headPitch)]);
    // Angle about x between them.
    const a = Math.atan2(wantHead[2], wantHead[1]) - Math.atan2(headDir[2], headDir[1]);
    for (const [n, f] of neck) skel.rotateWorld(n, M3.axisAngle(tiltAxis, a * f * 0.82));
    skel.rotateWorld('head', M3.axisAngle(tiltAxis, a * 0.18));
  }
  // 5. Arms: two-bone IK to the wrist, elbows bent outwards and down, then the hand laid on the hood.
  const out = { hands: {}, feet: {} };
  for (const s of ['R', 'L']) {
    const sgn = s === 'R' ? 1 : -1;
    // Where the hand must go: the palm resting on top of the hood, fingers forward and wrapping down.
    const fwdT = norm([sgn * fit.handOut, -fit.handDown, -1]);
    let nT = [-sgn * fit.palmIn, -1, 0];
    nT = norm(sub(nT, scale(fwdT, dot(nT, fwdT))));
    const grip = [fit.hood[0] * sgn, fit.hood[1], fit.hood[2]];
    const wristT = sub(sub(grip, scale(fwdT, fit.palmBack)), scale(nT, fit.palmLift));
    skel.solve();
    const sh = B[`upperarm01.${s}`].pos;
    const el = B[`lowerarm01.${s}`].pos, wr = B[`wrist.${s}`].pos;
    const a = len(sub(el, sh)), b = len(sub(wr, el));
    const elbow = ikJoint(sh, wristT, a, b, [sgn * fit.elbowOut, -1, 0.25]);
    aimPoint(skel, `upperarm01.${s}`, B[`lowerarm01.${s}`].pos, elbow);
    aimPoint(skel, `lowerarm01.${s}`, B[`wrist.${s}`].pos, wristT);
    // Hand frame from the geometry: forward = wrist to middle knuckle, n = palm normal (sign fixed at rest:
    // the palm faces the body's midline in the rest pose).
    const handFrame = () => {
      skel.solve();
      const w = B[`wrist.${s}`].pos, k2 = B[`finger2-1.${s}`].pos, k5 = B[`finger5-1.${s}`].pos, k3 = B[`finger3-1.${s}`].pos;
      const f = norm(sub(k3, w));
      let n = cross(sub(k2, w), sub(k5, w));
      n = norm(sub(n, scale(f, dot(n, f))));
      return { f, n: scale(n, fit.palmSign[s]) };
    };
    // Share the hand's roll between the forearm (pronation) and the wrist, so the forearm twists rather than
    // the wrist breaking: first turn the forearm about its axis so the palm faces nT as nearly as it can.
    {
      const fa = norm(sub(B[`wrist.${s}`].pos, B[`lowerarm01.${s}`].pos));
      const { n } = handFrame();
      const p = (v) => norm(sub(v, scale(fa, dot(v, fa))));
      const n0 = p(n), n1 = p(nT);
      const ang = Math.atan2(dot(cross(n0, n1), fa), dot(n0, n1)) * fit.pronateShare;
      skel.rotateWorld(`lowerarm01.${s}`, M3.axisAngle(fa, ang * 0.45));
      skel.rotateWorld(`lowerarm02.${s}`, M3.axisAngle(fa, ang * 0.55));
    }
    {
      const { f, n } = handFrame();
      const F = M3.fromCols(f, n, cross(f, n)), T = M3.fromCols(fwdT, nT, cross(fwdT, nT));
      skel.rotateWorld(`wrist.${s}`, M3.mul(T, M3.T(F)));
    }
    // Fingers curl towards the palm, round the hood; the thumb wraps the inside of the hood.
    const { f: hf, n: hn } = handFrame();
    const axis = cross(hf, hn);
    const spread = [0, 0, 0.0, 0.08, 0.16, 0.24]; // ring and little fingers curl a little more
    for (const fg of [2, 3, 4, 5]) {
      curl(skel, `finger${fg}-1.${s}`, axis, fit.curl[0] + spread[fg]);
      curl(skel, `finger${fg}-2.${s}`, axis, fit.curl[1] + spread[fg]);
      curl(skel, `finger${fg}-3.${s}`, axis, fit.curl[2]);
    }
    // Thumb: swing it forward along the hood and curl it in.
    skel.solve();
    const tAim = norm(add(scale(hf, 1), add(scale(hn, fit.thumbDown), [0, -0.0, 0])));
    aimPoint(skel, `finger1-2.${s}`, B[`finger1-3.${s}`].pos, add(B[`finger1-2.${s}`].pos, scale(tAim, 0.03)));
    curl(skel, `finger1-3.${s}`, axis, fit.thumb);
    skel.solve();
    out.hands[s] = { wrist: B[`wrist.${s}`].pos, knuckle: B[`finger3-1.${s}`].pos, elbow: B[`lowerarm01.${s}`].pos, shoulder: B[`upperarm01.${s}`].pos, grip };
  }
  // 6. Legs: IK from hip to ankle with the knee forward, then the foot pitched onto its pedal.
  for (const s of ['R', 'L']) {
    const sgn = s === 'R' ? 1 : -1;
    const { ankle, pitch } = fit.pedal(s);
    skel.solve();
    const hip = B[`upperleg01.${s}`].pos;
    const knee0 = B[`lowerleg01.${s}`].pos, ank0 = B[`foot.${s}`].pos;
    const a = len(sub(knee0, hip)), b = len(sub(ank0, knee0));
    const knee = ikJoint(hip, ankle, a, b, [sgn * fit.kneeOut, 0.15, -1]);
    aimPoint(skel, `upperleg01.${s}`, B[`lowerleg01.${s}`].pos, knee);
    aimPoint(skel, `lowerleg01.${s}`, B[`foot.${s}`].pos, ankle);
    // Foot: the sole (level in the rest pose) pitched toes-down by `pitch`, pointing straight ahead. The
    // ankle-to-toe line already slopes down by rest0 when standing.
    skel.solve();
    const heel = B[`foot.${s}`].pos, toe = B[`toe3-1.${s}`].pos;
    const r0 = sub(B[`toe3-1.${s}`].head, B[`foot.${s}`].head);
    const rest0 = Math.atan2(-r0[1], Math.hypot(r0[0], r0[2]));
    const fl = len(sub(toe, heel));
    const want = add(heel, scale(norm([0, -Math.sin(pitch + rest0), -Math.cos(pitch + rest0)]), fl));
    aimPoint(skel, `foot.${s}`, toe, want);
    skel.solve();
    out.feet[s] = { hip, knee: B[`lowerleg01.${s}`].pos, ankle: B[`foot.${s}`].pos, toe: B[`toe3-1.${s}`].pos };
  }
  skel.solve();
  out.hip = fit.hip;
  return out;
}
