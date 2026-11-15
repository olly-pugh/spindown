// An articulated cyclist on a road bike, in a clean stylised look: smooth swept limbs and torso with a curved
// back, a vented helmet and wrap sunglasses, kit patterns painted in vertex colours, and a bike with a proper
// drop bar, paired stays and fork blades, spoked wheels, bottle, computer and rear light.
//
// The whole rider is two skinned meshes (bike and body) on one small skeleton, so a rider costs two draw calls
// (plus a soft contact shadow) instead of nine. Every vertex follows exactly one bone: the wheels and cranks
// spin, each leg is a thigh/shin/foot chain solved by two-bone IK so the foot stays on its pedal, and the
// upper body rocks a little with each stroke. Units are metres; the rider faces −z.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { blobTexture } from './textures.js';

const WHEEL_R = 0.335;
const CRANK = 0.172;
const BB = new THREE.Vector3(0, 0.27, 0);
const REAR = new THREE.Vector3(0, WHEEL_R, 0.41);
const FRONT = new THREE.Vector3(0, WHEEL_R, -0.585);
const SADDLE = new THREE.Vector3(0, 0.955, 0.205);
const HIP = new THREE.Vector3(0, 1.0, 0.19);
const THIGH = 0.45, SHIN = 0.455;
const LEG_X = 0.108; // legs and pedals sit this far either side of the frame
const PEDAL = new THREE.Vector3(0, -0.1, -0.105); // pedal spindle relative to the ankle, in the foot's frame

// Bone indices.
const B_ROOT = 0, B_TORSO = 1, B_REAR = 2, B_FRONT = 3, B_CRANK = 4, B_THIGH = 5, B_SHIN = 6, B_FOOT = 7; // legs: +3 for the left

const colour = (c) => new THREE.Color(c);
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const UP = new THREE.Vector3(0, 1, 0);

/** Sets every vertex of a geometry to one colour (or a function of position), and binds it to one bone. */
function part(geo, c, bone = B_ROOT) {
  let g = geo.index ? geo.toNonIndexed() : geo;
  for (const k of Object.keys(g.attributes)) if (!['position', 'normal'].includes(k)) g.deleteAttribute(k);
  const pos = g.attributes.position, n = pos.count;
  const col = new Float32Array(n * 3), si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
  const tmp = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const cc = typeof c === 'function' ? c(pos.getX(i), pos.getY(i), pos.getZ(i), tmp) : c;
    col[i * 3] = cc.r;
    col[i * 3 + 1] = cc.g;
    col[i * 3 + 2] = cc.b;
    si[i * 4] = bone;
    sw[i * 4] = 1;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
  g.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
  return g;
}

/** A cylinder between two points. */
function tube(a, b, r, seg = 8, r2 = r) {
  const len = a.distanceTo(b);
  const g = new THREE.CylinderGeometry(r2, r, len, seg, 1);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, b.clone().sub(a).normalize()));
  const mid = a.clone().add(b).multiplyScalar(0.5);
  return g.translate(mid.x, mid.y, mid.z);
}

function ball(p, r, sx = 1, sy = 1, sz = 1, seg = 12) {
  return new THREE.SphereGeometry(r, seg, Math.max(6, Math.round(seg * 0.7))).scale(sx, sy, sz).translate(p.x, p.y, p.z);
}

/**
 * Sweeps an elliptical cross-section along a smooth path: rx is the half-width sideways (world x), rz the
 * half-depth in the plane of the path. Both ends are rounded off. colourAt(u 0…1 along, side −1…1, back −1…1)
 * may return a colour per vertex (written to a 'color' attribute that `part` then leaves alone if absent).
 */
function sweep(points, rx, rz, { rings = 12, radial = 12, colourAt = null } = {}) {
  const curve = new THREE.CatmullRomCurve3(points, false, 'catmullrom', 0.5);
  const n = points.length - 1;
  const at = (arr, t) => {
    const f = Math.min(n - 1e-6, Math.max(0, t * n)), i = Math.floor(f);
    return arr[i] + (arr[i + 1] - arr[i]) * (f - i);
  };
  const pos = [], col = [], idx = [];
  const p = new THREE.Vector3(), tan = new THREE.Vector3(), side = new THREE.Vector3(), nrm = new THREE.Vector3();
  const tmp = new THREE.Color();
  const total = rings + 3; // one extra ring at each end closes the caps
  for (let k = 0; k < total; k++) {
    const cap = k === 0 ? -1 : k === total - 1 ? 1 : 0;
    const t = Math.min(1, Math.max(0, (k - 1) / rings));
    curve.getPoint(t, p);
    curve.getTangent(t, tan).normalize();
    side.set(1, 0, 0).addScaledVector(tan, -tan.x).normalize();
    nrm.crossVectors(tan, side).normalize();
    let a = at(rx, t), b = at(rz, t);
    if (cap) {
      p.addScaledVector(tan, cap * Math.min(a, b) * 0.55);
      a *= 0.02;
      b *= 0.02;
    }
    for (let j = 0; j < radial; j++) {
      const th = (j / radial) * Math.PI * 2;
      const cs = Math.cos(th), sn = Math.sin(th);
      pos.push(p.x + side.x * cs * a + nrm.x * sn * b, p.y + side.y * cs * a + nrm.y * sn * b, p.z + side.z * cs * a + nrm.z * sn * b);
      if (colourAt) {
        const c = colourAt(t, cs, sn, tmp);
        col.push(c.r, c.g, c.b);
      }
    }
    if (k > 0) {
      for (let j = 0; j < radial; j++) {
        const a0 = (k - 1) * radial + j, a1 = (k - 1) * radial + ((j + 1) % radial), b0 = k * radial + j, b1 = k * radial + ((j + 1) % radial);
        idx.push(a0, b0, a1, a1, b0, b1);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  if (colourAt) g.setAttribute('paint', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  // Make sure it is not inside out (the winding depends on the direction of travel).
  g.computeBoundingSphere();
  const c0 = g.boundingSphere.center, pa = g.attributes.position, na = g.attributes.normal;
  let dot = 0;
  for (let i = 0; i < pa.count; i += 3) dot += (pa.getX(i) - c0.x) * na.getX(i) + (pa.getY(i) - c0.y) * na.getY(i) + (pa.getZ(i) - c0.z) * na.getZ(i);
  if (dot < 0) {
    for (let i = 0; i < idx.length; i += 3) [idx[i + 1], idx[i + 2]] = [idx[i + 2], idx[i + 1]];
    g.setIndex(idx);
    g.computeVertexNormals();
  }
  return g;
}

/** A round limb from a to b with the given radii along it (evenly spaced). */
function limb(a, b, radii, opts = {}) {
  const pts = radii.map((_, i) => a.clone().lerp(b, i / (radii.length - 1)));
  return sweep(pts, radii, radii, { rings: Math.max(4, (radii.length - 1) * 2), radial: 10, ...opts });
}

/** A swept part whose colours were computed during the sweep. */
function painted(geo, bone = B_ROOT) {
  const g = geo.toNonIndexed();
  const paint = g.attributes.paint;
  g.deleteAttribute('paint');
  const out = part(g, colour('#fff'), bone);
  out.setAttribute('color', new THREE.BufferAttribute(paint.array.slice(), 3));
  return out;
}

function merge(list) {
  return mergeGeometries(list, false);
}

/** Jersey colouring: u runs from the hem (0) to the collar (1), x is metres across the chest. */
function jerseyPaint(jersey) {
  const body = colour(jersey.body), accent = colour(jersey.accent);
  const pocket = body.clone().multiplyScalar(0.84);
  return (u, x, back) => {
    if (u > 0.955) return accent; // collar
    if (u < 0.045) return pocket; // hem gripper
    let c = body;
    switch (jersey.pattern) {
      case 'band': if (Math.abs(u - 0.6) < 0.1) c = accent; break;
      case 'hoops': if (Math.floor(u * 7.5) % 2) c = accent; break;
      case 'stripes': if (Math.abs(x) < 0.028 || Math.abs(Math.abs(x) - 0.085) < 0.016) c = accent; break;
      case 'sash': if (Math.abs(x - (u - 0.5) * 0.42) < 0.05) c = accent; break;
      case 'halves': if (x > 0) c = accent; break;
      case 'dots': {
        const a = Math.round(u * 9), b = Math.round((x + 0.3) * 18 + (a % 2) * 0.5);
        const du = u * 9 - a, dx = (x + 0.3) * 18 + (a % 2) * 0.5 - b;
        if (du * du + dx * dx < 0.13) c = accent;
        break;
      }
      default:
    }
    // Three back pockets, a shade darker.
    if (c === body && back > 0.25 && u > 0.1 && u < 0.3) return pocket;
    return c;
  };
}

const sharedMaterials = new Map();
function material(kind) {
  if (!sharedMaterials.has(kind)) {
    let m;
    if (kind === 'ghost') m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0, transparent: true, opacity: 0.38, depthWrite: false, emissive: new THREE.Color('#5ad1ff'), emissiveIntensity: 0.35 });
    else if (kind === 'shadow') m = new THREE.MeshBasicMaterial({ map: blobTexture(), transparent: true, depthWrite: false, opacity: 0.6, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6, toneMapped: false, color: '#000000' });
    else m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: kind === 'bike' ? 0.3 : 0.66, metalness: kind === 'bike' ? 0.35 : 0.0 });
    sharedMaterials.set(kind, m);
  }
  return sharedMaterials.get(kind);
}
let shadowGeo = null;

/**
 * Builds a rider. kit: {jersey, helmet, bike, wheels} from content.js. options: {ghost, skin, shadows}.
 */
export class RiderModel {
  constructor(kit, { ghost = false, skin = '#e0ac8a', shadows = true } = {}) {
    this.root = new THREE.Group();
    this.lean = new THREE.Group(); // rolls about the tyre contact line
    this.root.add(this.lean);
    const matBody = material(ghost ? 'ghost' : 'body');
    const matBike = material(ghost ? 'ghost' : 'bike');
    const black = colour('#17181a'), grey = colour('#8a8d91'), silver = colour('#c9ccd1'), rubber = colour('#101011');
    const frameCol = colour(kit.bike.color);
    const frameDark = frameCol.clone().multiplyScalar(0.55);
    const skinCol = colour(skin), skinShade = skinCol.clone().multiplyScalar(0.86);
    const shorts = colour('#16171a');
    const accent = colour(kit.jersey.accent), sleeve = colour(kit.jersey.sleeve);

    // ---- Skeleton ----
    const bone = (parent, p) => {
      const b = new THREE.Bone();
      b.position.copy(p);
      if (parent) parent.add(b);
      return b;
    };
    const bRoot = bone(null, V(0, 0, 0));
    const bTorso = bone(bRoot, HIP);
    const bRear = bone(bRoot, REAR), bFront = bone(bRoot, FRONT), bCrank = bone(bRoot, BB);
    const bones = [bRoot, bTorso, bRear, bFront, bCrank];
    this.legs = [];
    for (const s of [1, -1]) {
      const thigh = bone(bRoot, V(LEG_X * s, HIP.y, HIP.z));
      const shin = bone(thigh, V(0, -THIGH, 0));
      const foot = bone(shin, V(0, -SHIN, 0));
      bones.push(thigh, shin, foot);
      this.legs.push({ side: s, thigh, shin, foot });
    }
    this.lean.add(bRoot);
    this.bones = { torso: bTorso, rear: bRear, front: bFront, crank: bCrank };

    // ---- Bike frame, fork, bars, saddle ----
    const headTop = V(0, 0.865, -0.43), headBottom = V(0, 0.715, -0.47);
    const seatTop = V(0, 0.84, 0.17);
    const bike = [];
    const add = (geo, c, b = B_ROOT) => bike.push(part(geo, c, b));
    add(tube(BB, headBottom, 0.027, 10, 0.024), (x, y, z) => (y > 0.5 && y < 0.62 ? frameDark : frameCol)); // down tube with a painted band
    add(tube(seatTop, headTop, 0.019, 8), frameCol); // top tube
    add(tube(BB, seatTop, 0.02, 8), frameCol); // seat tube
    add(tube(headBottom.clone().add(V(0, -0.02, 0.006)), headTop.clone().add(V(0, 0.015, -0.004)), 0.026, 10), frameCol); // head tube
    add(new THREE.CylinderGeometry(0.034, 0.034, 0.075, 12).rotateZ(Math.PI / 2).translate(0, BB.y, BB.z), frameCol); // bottom bracket shell
    for (const s of [-1, 1]) {
      add(tube(BB.clone().add(V(0.03 * s, 0, 0.02)), REAR.clone().add(V(0.066 * s, 0, 0)), 0.011, 6), frameCol); // chain stays
      add(tube(seatTop.clone().add(V(0.012 * s, -0.03, 0)), REAR.clone().add(V(0.066 * s, 0, 0)), 0.009, 6), frameCol); // seat stays
      add(tube(headBottom.clone().add(V(0.03 * s, -0.035, 0.004)), FRONT.clone().add(V(0.05 * s, 0, 0)), 0.013, 6, 0.016), frameCol); // fork blades
    }
    add(new THREE.BoxGeometry(0.09, 0.03, 0.04).translate(0, headBottom.y - 0.04, headBottom.z + 0.004), frameCol); // fork crown
    add(tube(seatTop.clone().add(V(0, -0.02, 0)), SADDLE.clone().add(V(0, -0.03, -0.01)), 0.0135, 8), black); // seat post
    // Saddle: a narrow nose widening to the rear.
    add(sweep([V(0, SADDLE.y - 0.005, SADDLE.z - 0.15), V(0, SADDLE.y, SADDLE.z - 0.05), V(0, SADDLE.y + 0.002, SADDLE.z + 0.05), V(0, SADDLE.y + 0.012, SADDLE.z + 0.115)], [0.018, 0.034, 0.066, 0.06], [0.014, 0.016, 0.018, 0.014], { rings: 8, radial: 10 }), black);
    add(tube(headTop.clone().add(V(0, 0.02, -0.004)), V(0, 0.905, -0.53), 0.015, 8), black); // stem
    add(new THREE.BoxGeometry(0.05, 0.016, 0.075).translate(0, 0.925, -0.555), colour('#0c0c0d')); // bike computer
    add(new THREE.BoxGeometry(0.042, 0.004, 0.06).translate(0, 0.9345, -0.555), colour('#9fd6c2'));
    // Drop bar: tops, the forward reach to the hoods, and the drops curling back.
    for (const s of [-1, 1]) {
      const curve = new THREE.CatmullRomCurve3([V(0, 0.905, -0.53), V(0.1 * s, 0.905, -0.53), V(0.185 * s, 0.905, -0.538), V(0.2 * s, 0.9, -0.585), V(0.2 * s, 0.872, -0.632), V(0.2 * s, 0.815, -0.638), V(0.2 * s, 0.778, -0.6), V(0.2 * s, 0.772, -0.53)]);
      add(new THREE.TubeGeometry(curve, 22, 0.0118, 6, false), black);
      add(limb(V(0.2 * s, 0.9, -0.59), V(0.2 * s, 0.972, -0.64), [0.019, 0.021, 0.017]), rubber); // brake hood
      add(tube(V(0.2 * s, 0.955, -0.652), V(0.2 * s, 0.83, -0.668), 0.006, 5), silver); // brake lever
    }
    // Drivetrain: chainring, chain, cassette, rear derailleur.
    add(tube(V(0.052, BB.y + 0.098, BB.z), V(0.052, REAR.y + 0.04, REAR.z), 0.0045, 4), grey);
    add(tube(V(0.052, BB.y - 0.098, BB.z), V(0.058, REAR.y - 0.085, REAR.z + 0.015), 0.0045, 4), grey);
    add(new THREE.CylinderGeometry(0.052, 0.026, 0.036, 14).rotateZ(Math.PI / 2).translate(0.046, REAR.y, REAR.z), silver);
    add(new THREE.BoxGeometry(0.02, 0.085, 0.03).rotateX(0.3).translate(0.06, REAR.y - 0.075, REAR.z + 0.015), black);
    // Brakes, bottle and cage, rear light.
    add(new THREE.BoxGeometry(0.07, 0.035, 0.03).translate(0, FRONT.y + WHEEL_R + 0.012, FRONT.z + 0.006), black);
    add(new THREE.BoxGeometry(0.07, 0.035, 0.03).translate(0, REAR.y + WHEEL_R + 0.012, REAR.z - 0.07), black);
    const bottleA = V(0, 0.5, -0.172), bottleB = V(0, 0.66, -0.262);
    add(tube(bottleA, bottleB, 0.035, 12), (x, y) => (y > 0.6 ? accent : colour(kit.jersey.body)));
    add(tube(bottleB, bottleB.clone().lerp(bottleA, -0.22), 0.018, 8, 0.012), black);
    add(new THREE.BoxGeometry(0.034, 0.05, 0.03).translate(0, 0.9, 0.2), colour('#e3221c')); // rear light
    const frame = merge(bike);

    // ---- Wheels: tyre, rim (depth from the wheelset), hub and spokes ----
    const depth = kit.wheels.depth ?? 0.025;
    const deep = depth > 0.03;
    const rimCol = deep ? colour(kit.wheels.id === 'gold' ? '#d4af37' : '#1d1d20') : silver;
    const wheel = (at, b) => {
      const w = [];
      const put = (geo, c) => w.push(part(geo.translate(at.x, at.y, at.z), c, b));
      put(new THREE.TorusGeometry(WHEEL_R - 0.013, 0.0135, 8, 36).rotateY(Math.PI / 2), rubber);
      const rOuter = WHEEL_R - 0.024, rInner = rOuter - depth;
      // Rim: two side walls and the inner face.
      for (const s of [-1, 1]) put(new THREE.RingGeometry(rInner, rOuter, 36, 1).rotateY((s * Math.PI) / 2).translate(0.0105 * s, 0, 0), rimCol);
      put(new THREE.CylinderGeometry(rInner, rInner, 0.021, 36, 1, true).rotateZ(Math.PI / 2), deep ? rimCol : grey);
      put(new THREE.CylinderGeometry(0.019, 0.019, 0.1, 10).rotateZ(Math.PI / 2), grey);
      const spokes = deep ? 16 : 20;
      for (let i = 0; i < spokes; i++) {
        const a = (i / spokes) * Math.PI * 2;
        put(tube(V((i % 2 ? 1 : -1) * 0.034, Math.cos(a + 0.25) * 0.018, Math.sin(a + 0.25) * 0.018), V(0, Math.cos(a) * rInner, Math.sin(a) * rInner), 0.0017, 3), silver);
      }
      return w;
    };
    // ---- Cranks: rotate about the bottom bracket (the pedals travel with the feet) ----
    const cranks = [];
    for (const s of [1, -1]) {
      cranks.push(part(tube(V(0.064 * s, BB.y, BB.z), V(0.064 * s, BB.y - CRANK * s, BB.z), 0.0125, 6, 0.01), black, B_CRANK));
      cranks.push(part(tube(V(0.064 * s, BB.y - CRANK * s, BB.z), V((LEG_X - 0.03) * s, BB.y - CRANK * s, BB.z), 0.007, 5), grey, B_CRANK));
    }
    cranks.push(part(tube(V(-0.07, BB.y, BB.z), V(0.07, BB.y, BB.z), 0.013, 8), grey, B_CRANK));
    cranks.push(part(new THREE.TorusGeometry(0.098, 0.008, 5, 28).rotateY(Math.PI / 2).translate(0.052, BB.y, BB.z), grey, B_CRANK));
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI * 2;
      cranks.push(part(tube(V(0.052, BB.y, BB.z), V(0.052, BB.y + Math.cos(a) * 0.095, BB.z + Math.sin(a) * 0.095), 0.006, 4), black, B_CRANK));
    }
    const bikeGeo = merge([frame, ...wheel(REAR, B_REAR), ...wheel(FRONT, B_FRONT), ...cranks]);

    // ---- Rider: a curved back from the saddle to the shoulders ----
    const body = [];
    const put = (geo, c, b = B_TORSO) => body.push(part(geo, c, b));
    const jersey = jerseyPaint(kit.jersey);
    const spine = [V(0, 1.0, 0.215), V(0, 1.105, 0.15), V(0, 1.215, 0.055), V(0, 1.31, -0.07), V(0, 1.372, -0.19), V(0, 1.4, -0.268)];
    const halfW = [0.148, 0.143, 0.155, 0.178, 0.186, 0.085];
    const halfD = [0.108, 0.103, 0.112, 0.118, 0.1, 0.062];
    const tmpC = new THREE.Color();
    body.push(painted(sweep(spine, halfW, halfD, { rings: 26, radial: 22, colourAt: (u, cs, sn) => tmpC.copy(jersey(u, cs * 0.17, sn)) }), B_TORSO));
    // Hips and seat in bib shorts.
    put(ball(HIP.clone().add(V(0, -0.02, 0.012)), 0.16, 1.1, 0.74, 1.05, 16), shorts, B_ROOT);
    // Arms: sleeves to mid upper arm, bare forearms, gloved hands on the hoods.
    const glove = colour('#1d1d20');
    for (const s of [-1, 1]) {
      const sh = V(0.178 * s, 1.36, -0.222), elbow = V(0.226 * s, 1.156, -0.405), wrist = V(0.204 * s, 1.012, -0.556);
      const cuff = sh.clone().lerp(elbow, 0.58);
      put(ball(sh, 0.071, 1, 1, 1, 12), sleeve);
      put(limb(sh, cuff, [0.066, 0.056, 0.052]), sleeve);
      put(limb(cuff.clone().lerp(sh, 0.05), cuff.clone().lerp(elbow, 0.1), [0.054, 0.054]), accent); // cuff band
      put(limb(cuff, elbow, [0.047, 0.043]), skinCol);
      put(ball(elbow, 0.043, 1, 1, 1, 10), skinCol);
      put(limb(elbow, wrist, [0.043, 0.041, 0.031]), skinCol);
      // Hand wrapped over the hood, thumb inside.
      put(ball(V(0.204 * s, 0.984, -0.598), 0.04, 0.95, 0.78, 1.35, 10), glove);
      put(ball(V(0.174 * s, 0.972, -0.6), 0.017, 1, 1, 1.7, 6), glove);
    }
    // Neck and head, looking up the road.
    const head = V(0, 1.548, -0.372);
    put(limb(V(0, 1.4, -0.268), head.clone().add(V(0, -0.055, 0.028)), [0.054, 0.047, 0.047]), skinCol);
    put(ball(head, 0.1, 0.9, 1.06, 1.02, 18), skinCol);
    put(ball(head.clone().add(V(0, -0.058, -0.042)), 0.071, 0.82, 0.72, 0.98, 12), skinCol); // jaw and chin
    put(ball(head.clone().add(V(0, -0.012, -0.102)), 0.018, 0.95, 1.1, 1.3, 8), skinShade); // nose
    for (const s of [-1, 1]) put(ball(head.clone().add(V(0.09 * s, -0.008, 0.004)), 0.022, 0.5, 1.2, 0.9, 8), skinShade); // ears
    put(ball(head.clone().add(V(0, -0.068, -0.098)), 0.017, 1.5, 0.35, 0.6, 8), skinCol.clone().multiplyScalar(0.72)); // mouth
    // Wrap-round sunglasses: a tinted shield across the eyes and arms back to the ears.
    const shield = new THREE.CylinderGeometry(0.094, 0.094, 0.044, 16, 1, true, Math.PI * 0.66, Math.PI * 0.68).scale(1, 1, 1.02).translate(head.x, head.y + 0.014, head.z + 0.004);
    put(shield, (x, y) => (y > head.y + 0.03 ? black : colour('#20303c')));
    // Helmet.
    const helmetCol = colour(kit.helmet.color);
    const trim = helmetCol.clone().multiplyScalar(0.55);
    const vent = colour('#111113');
    const aero = kit.helmet.aero < 1;
    const shell = new THREE.SphereGeometry(0.13, 28, 14, 0, Math.PI * 2, 0, Math.PI * 0.57);
    shell.scale(0.9, 0.84, aero ? 1.46 : 1.24);
    shell.rotateX(-0.2);
    shell.translate(head.x, head.y + 0.034, head.z + (aero ? 0.046 : 0.014));
    put(shell, (x, y, z) => {
      const lx = x - head.x, lz = z - head.z, ly = y - head.y;
      if (ly < 0.012 + lz * 0.2) return trim; // rim band
      // Vents: long dark slots running front to back, and a pair of brow vents.
      if (!aero && ly > 0.075 && Math.abs(Math.sin(lx * 58)) > 0.8 && lz > -0.115 && lz < 0.125 && Math.abs(lx) < 0.085) return vent;
      if (aero && ly > 0.05 && lz < -0.1 && Math.abs(Math.abs(lx) - 0.035) < 0.014) return vent;
      return helmetCol;
    });
    // Helmet straps.
    for (const s of [-1, 1]) put(tube(head.clone().add(V(0.085 * s, 0.03, 0.005)), head.clone().add(V(0.05 * s, -0.1, -0.03)), 0.004, 4), black);

    // ---- Legs ----
    const sock = colour('#f4f4f2'), shoe = colour(kit.helmet.color === '#1c1c1e' ? '#f2f2f2' : '#202024'), sole = colour('#0e0e0f');
    for (const [k, s] of [[0, 1], [1, -1]]) {
      const hip = V(LEG_X * s, HIP.y, HIP.z), knee = hip.clone().add(V(0, -THIGH, 0)), ankle = knee.clone().add(V(0, -SHIN, 0));
      const o = k * 3;
      const thighGeo = sweep([hip.clone().add(V(-0.012 * s, 0.03, 0)), hip.clone().lerp(knee, 0.3), hip.clone().lerp(knee, 0.7), knee], [0.086, 0.087, 0.07, 0.055], [0.092, 0.09, 0.073, 0.056], {
        rings: 10, radial: 12, colourAt: (u) => (u < 0.6 ? shorts : u < 0.66 ? accent : skinCol),
      });
      body.push(painted(thighGeo, B_THIGH + o));
      put(ball(knee, 0.055, 1, 1, 1.05, 10), skinCol, B_THIGH + o);
      // Calf: fuller at the back, tapering to the ankle; sock below.
      const shinGeo = sweep([knee, knee.clone().lerp(ankle, 0.28).add(V(0, 0, 0.012)), knee.clone().lerp(ankle, 0.62).add(V(0, 0, 0.006)), ankle.clone().add(V(0, 0.02, 0))], [0.05, 0.058, 0.046, 0.035], [0.052, 0.064, 0.047, 0.036], {
        rings: 10, radial: 12, colourAt: (u) => (u < 0.74 ? skinCol : sock),
      });
      body.push(painted(shinGeo, B_SHIN + o));
      // Shoe: toe forward, sole plate and a pedal under the ball of the foot.
      const shoeGeo = sweep([ankle.clone().add(V(0, -0.04, 0.06)), ankle.clone().add(V(0, -0.035, 0.0)), ankle.clone().add(V(0, -0.055, -0.09)), ankle.clone().add(V(0, -0.068, -0.175))], [0.036, 0.043, 0.047, 0.036], [0.034, 0.05, 0.036, 0.024], {
        rings: 10, radial: 12, colourAt: (u, cs, sn) => (sn < -0.55 ? sole : u > 0.36 && u < 0.46 ? accent : shoe),
      });
      body.push(painted(shoeGeo, B_FOOT + o));
      put(new THREE.BoxGeometry(0.085, 0.018, 0.075).translate(ankle.x + 0.012 * s, ankle.y + PEDAL.y - 0.002, ankle.z + PEDAL.z), black, B_FOOT + o);
    }
    const bodyGeo = merge(body);

    // ---- Meshes ----
    this.root.updateMatrixWorld(true);
    this.skeleton = new THREE.Skeleton(bones);
    const sphere = new THREE.Sphere(V(0, 0.85, -0.1), 1.35);
    const make = (geo, mat) => {
      const m = new THREE.SkinnedMesh(geo, mat);
      m.bind(this.skeleton, new THREE.Matrix4());
      m.boundingSphere = sphere;
      m.castShadow = shadows && !ghost;
      m.receiveShadow = false;
      this.lean.add(m);
      return m;
    };
    this.frame = make(bikeGeo, matBike);
    this.body = make(bodyGeo, matBody);
    if (!ghost) {
      // A soft contact shadow, so the bike sits on the road even where there is no sun.
      if (!shadowGeo) shadowGeo = new THREE.PlaneGeometry(1.15, 2.7).rotateX(-Math.PI / 2).translate(0, 0.012, -0.09);
      this.blob = new THREE.Mesh(shadowGeo, material('shadow'));
      this.blob.renderOrder = 2;
      this.root.add(this.blob);
    }
    this.setPose(0, 0, 0);
  }

  /** crank: crank angle (rad), wheel: wheel angle (rad), lean: roll (rad, positive leaning right). */
  setPose(crank, wheel, lean) {
    const b = this.bones;
    b.crank.rotation.x = -crank;
    b.rear.rotation.x = -wheel;
    b.front.rotation.x = -wheel;
    this.lean.rotation.z = -lean;
    // A little upper-body rock with each pedal stroke.
    b.torso.rotation.z = Math.sin(crank) * 0.022;
    b.torso.rotation.y = Math.sin(crank) * 0.012;
    for (const leg of this.legs) {
      // Pedal position in the side plane (z forward is negative).
      const a = crank + (leg.side > 0 ? 0 : Math.PI);
      const pz = BB.z + Math.sin(a) * CRANK;
      const py = BB.y - Math.cos(a) * CRANK;
      // Ankling: toes down a little all the way round, most on the upstroke.
      const pitch = -(0.27 + 0.15 * Math.sin(a));
      const cs = Math.cos(pitch), sn = Math.sin(pitch);
      const fy = py - (PEDAL.y * cs - PEDAL.z * sn), fz = pz - (PEDAL.y * sn + PEDAL.z * cs); // the ankle
      // Two-bone IK in the y–z plane, knee forward (towards −z).
      const dz = fz - HIP.z, dy = fy - HIP.y;
      const dist = Math.min(THIGH + SHIN - 1e-4, Math.max(0.2, Math.hypot(dz, dy)));
      const toFoot = Math.atan2(dz, -dy); // angle from straight down, positive towards +z (backwards)
      const cosKnee = (THIGH * THIGH + dist * dist - SHIN * SHIN) / (2 * THIGH * dist);
      const kneeOffset = Math.acos(Math.max(-1, Math.min(1, cosKnee)));
      const thighAngle = toFoot - kneeOffset; // swing the knee forward
      const cosInner = (THIGH * THIGH + SHIN * SHIN - dist * dist) / (2 * THIGH * SHIN);
      const inner = Math.acos(Math.max(-1, Math.min(1, cosInner)));
      // three.js rotation.x of θ swings a downward limb (−y) forwards (−z) for positive θ; our angles are
      // positive backwards, hence the signs. The shin folds back from the knee; the foot keeps its own pitch.
      leg.thigh.rotation.x = -thighAngle;
      leg.shin.rotation.x = -(Math.PI - inner);
      leg.foot.rotation.x = pitch - leg.thigh.rotation.x - leg.shin.rotation.x;
    }
  }

  dispose() {
    this.frame.geometry.dispose();
    this.body.geometry.dispose();
    this.skeleton.dispose();
  }
}

export const RIDER_DIMENSIONS = { WHEEL_R, length: 1.75 };
